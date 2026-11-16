/** @fileoverview Whole-point and member-vote public contracts. @module tests/integration/votes-contract */
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { riksdagGetDocument } from '@/mcp-server/tools/definitions/get-document.tool.js';
import { riksdagGetVotes } from '@/mcp-server/tools/definitions/get-votes.tool.js';
import { successEnrichment } from '@/services/riksdag/output.js';
import { getRiksdagService, initRiksdagService } from '@/services/riksdag/riksdag-service.js';
import { continuationArgs } from '../services/riksdag/continuation-fixtures.js';
import {
  memberReportRows,
  memberVoteRows,
  publishedReportFetch,
  publishedSizeRows,
  reportFetch,
  timestampedMemberRow,
  timestampedMemberRows,
  voteReport,
} from '../services/riksdag/vote-fixtures.js';

afterEach(() => {
  vi.useRealTimers();
  getRiksdagService().dispose();
});
function success(result: Awaited<ReturnType<typeof runToolContract>>) {
  expect(result.isError).not.toBe(true);
  const domain = riksdagGetVotes.output.parse(result.structuredContent);
  const enrichment = z.object(successEnrichment).parse(result.structuredContent);
  expect(enrichment.source).toBe('Source: The Swedish Parliament');
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('Expected domain text.');
  const firstNewline = first.text.indexOf('\n');
  const delimiter = first.text.slice(0, firstNewline).replace(/json$/, '');
  expect(
    JSON.parse(
      first.text.slice(firstNewline + 1, first.text.indexOf(`\n${delimiter}`, firstNewline)),
    ),
  ).toEqual(domain);
  const text = result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  expect(text).toContain(enrichment.source);
  expect(text).toContain(enrichment.retrievedAt);
  for (const notice of enrichment.notices)
    expect(text).toContain(JSON.stringify(notice).slice(1, -1));
  return { domain, enrichment };
}
function failure(result: Awaited<ReturnType<typeof runToolContract>>, reason: string) {
  expect(result.isError).toBe(true);
  const error = z
    .object({
      error: z.object({
        code: z.number(),
        data: z.object({ reason: z.string(), recovery: z.object({ hint: z.string() }) }),
      }),
    })
    .parse(result.structuredContent).error;
  expect(error.data.reason).toBe(reason);
  expect(result.content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining(error.data.recovery.hint),
      }),
    ]),
  );
  return error;
}
describe('vote public contracts', () => {
  it('reports malformed source sessions through the upstream schema recovery on both surfaces', async () => {
    initRiksdagService({
      fetch: async () =>
        Response.json({
          voteringlista: {
            '@antal': '1',
            votering: { votering_id: 'v1', intressent_id: '0001', rm: 'not-a-session' },
          },
        }),
    });
    const error = failure(
      await runToolContract(riksdagGetVotes, {
        mode: 'member',
        session: '2024/25',
        memberId: '0001',
      }),
      'upstream_schema_invalid',
    );
    expect(error.code).toBe(JsonRpcErrorCode.SerializationError);
  });
  it('preserves sparse member vote fields and unknown source vote labels without inventing values', async () => {
    initRiksdagService({
      fetch: async () =>
        Response.json({
          voteringlista: {
            '@antal': '1',
            '@q': 'källfråga',
            '@varning': 'Källans varning',
            votering: {
              votering_id: 'sparse-vote',
              intressent_id: '0001',
              rm: '2024/25',
              rost: 'Annan publicerad röst',
              avser: 'sakfrågan',
              contact_email: 'private@example.test',
            },
          },
        }),
    });
    const { domain, enrichment } = success(
      await runToolContract(riksdagGetVotes, {
        mode: 'member',
        session: '2024/25',
        memberId: '0001',
      }),
    );
    expect(domain.votes).toEqual([
      {
        voteId: 'sparse-vote',
        memberId: '0001',
        session: '2024/25',
        vote: 'Annan publicerad röst',
        avser: 'sakfrågan',
      },
    ]);
    expect(enrichment).toMatchObject({
      upstreamQuery: 'källfråga',
      upstreamWarnings: ['Källans varning'],
    });
    expect(JSON.stringify(domain)).not.toContain('private@example.test');
  });
  it('returns ballot-echo identity mismatch and recovery through both surfaces', async () => {
    const network: typeof fetch = reportFetch(() => ({
      voteringlista: { '@antal': '0', '@villkor': 'rm=2025/26:bet=KU1:punkt=1' },
    }));
    initRiksdagService({ fetch: network });
    failure(
      await runToolContract(riksdagGetVotes, {
        mode: 'report',
        session: '2024/25',
        documentId: 'HC01KU1',
        point: 1,
      }),
      'upstream_identity_mismatch',
    );
  });
  it.each([
    {
      name: 'a motion',
      input: { session: '2024/25', documentId: 'HC023023' },
      message: 'Document HC023023 is a mot document, not a committee report (bet).',
      hint: 'Call riksdag_get_document with documentId HC023023 and sections references to list the reports that treated it (behandlas_i), then retry riksdag_get_votes with one of their documentIds; otherwise use riksdag_search_documents with documentType "bet" and session 2024/25.',
    },
    {
      name: 'a report from another session',
      input: { session: '2023/24', documentId: 'HC01FÖU1' },
      message: 'Report HC01FÖU1 belongs to session 2024/25, not 2023/24.',
      hint: 'Retry riksdag_get_votes with session 2024/25 and the same documentId HC01FÖU1.',
    },
    {
      name: 'a disagreeing report designation',
      input: { session: '2024/25', report: 'FiU1', documentId: 'HC01FÖU1' },
      message: 'Report HC01FÖU1 is report FöU1, not FIU1.',
      hint: 'Pass report or documentId alone: documentId HC01FÖU1 selects report FöU1.',
    },
  ])('fails $name as invalid_filter before any vote request', async ({ input, message, hint }) => {
    const records = new Map([
      [
        '/dokumentstatus/HC023023.json',
        { dok_id: 'HC023023', doktyp: 'mot', rm: '2024/25', beteckning: '3023' },
      ],
      [
        '/dokumentstatus/HC01FÖU1.json',
        { dok_id: 'HC01FöU1', doktyp: 'bet', rm: '2024/25', beteckning: 'FöU1' },
      ],
    ]);
    const network = vi.fn<typeof fetch>().mockImplementation(async (request) => {
      const record = records.get(decodeURIComponent(new URL(String(request)).pathname));
      if (!record) throw new Error(`Unexpected synthetic route ${String(request)}`);
      return Response.json({ dokumentstatus: { dokument: record } });
    });
    initRiksdagService({ fetch: network });
    const result = await runToolContract(riksdagGetVotes, { mode: 'report', ...input });
    const error = failure(result, 'invalid_filter');
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.recovery.hint).toBe(hint);
    expect(JSON.stringify(result.structuredContent)).toContain(JSON.stringify(message));
    expect(JSON.stringify(result.content)).toContain(JSON.stringify(message).slice(1, -1));
    expect(network).toHaveBeenCalledTimes(1);
    expect(network.mock.calls.map(([request]) => new URL(String(request)).pathname)).not.toContain(
      '/voteringlista/',
    );
  });
  it('rejects changed complete member candidates after cache expiry while preserving cached timestamps', async () => {
    vi.useFakeTimers();
    let changed = false;
    const network = vi.fn<typeof fetch>().mockImplementation(async () => {
      const rows = memberVoteRows();
      if (changed) rows[0]!.rost = 'Nej';
      return Response.json({ voteringlista: { '@antal': '4', votering: rows } });
    });
    initRiksdagService({ fetch: network });
    const first = success(
      await runToolContract(riksdagGetVotes, {
        mode: 'member',
        session: '2024/25',
        memberId: '0001',
        limit: 1,
      }),
    );
    vi.advanceTimersByTime(1000);
    const cached = success(
      await runToolContract(
        riksdagGetVotes,
        continuationArgs(riksdagGetVotes, first.domain.nextCall),
      ),
    );
    expect(cached.enrichment.retrievedAt).toBe(first.enrichment.retrievedAt);
    expect(cached.domain.revision).toBe(first.domain.revision);
    expect(network).toHaveBeenCalledTimes(1);
    changed = true;
    vi.advanceTimersByTime(300000);
    failure(
      await runToolContract(
        riksdagGetVotes,
        continuationArgs(riksdagGetVotes, first.domain.nextCall),
      ),
      'revision_changed',
    );
  });
  it('resolves an exact report on a later remote page and rejects multiple exact report IDs', async () => {
    const network = vi.fn<typeof fetch>().mockImplementation(async (request, options) => {
      const url = new URL(String(request));
      if (url.pathname !== '/dokumentlista/') return reportFetch()(request, options);
      return Response.json({
        dokumentlista:
          url.searchParams.get('p') === '1'
            ? {
                '@nasta_sida': 'https://data.riksdagen.se/dokumentlista/?p=2&untrusted=1',
                dokument: { dok_id: 'HC01KU2', doktyp: 'bet', rm: '2024/25', beteckning: 'KU2' },
              }
            : { dokument: { dok_id: 'HC01KU1', doktyp: 'bet', rm: '2024/25', beteckning: 'KU1' } },
      });
    });
    initRiksdagService({ fetch: network });
    expect(
      success(
        await runToolContract(riksdagGetVotes, {
          mode: 'report',
          session: '2024/25',
          report: 'KU1',
          point: 1,
        }),
      ).domain,
    ).toMatchObject({ found: true, documentId: 'HC01KU1', points: [{ decision: { point: 1 } }] });
    expect(String(network.mock.calls[1]?.[0])).toBe(
      'https://data.riksdagen.se/dokumentlista/?bet=KU1&doktyp=bet&p=2&rm=2024%2F25&sz=2&utformat=json',
    );
    initRiksdagService({
      fetch: async () =>
        Response.json({
          dokumentlista: {
            dokument: [
              { dok_id: 'HC01KU1', doktyp: 'bet', rm: '2024/25', beteckning: 'KU1' },
              { dok_id: 'HC01KU2', doktyp: 'bet', rm: '2024/25', beteckning: 'KU1' },
            ],
          },
        }),
    });
    failure(
      await runToolContract(riksdagGetVotes, { mode: 'report', session: '2024/25', report: 'KU1' }),
      'ambiguous_report',
    );
  });
  it('fails the whole report call for malformed later hydration rather than returning earlier points', async () => {
    initRiksdagService({
      fetch: reportFetch((point) =>
        point === 2
          ? { voteringlista: { '@antal': '1', votering: { parti: 'S', Ja: '-1' } } }
          : { voteringlista: { '@antal': '0' } },
      ),
    });
    failure(
      await runToolContract(riksdagGetVotes, {
        mode: 'report',
        session: '2024/25',
        documentId: 'HC01KU1',
      }),
      'upstream_schema_invalid',
    );
  });
  it('retains source-fetch time on cache hits and rejects a changed point catalog after expiry', async () => {
    vi.useFakeTimers();
    let changed = false;
    const network = vi.fn<typeof fetch>().mockImplementation(async (request, options) => {
      if (new URL(String(request)).pathname === '/dokumentstatus/HC01KU1.json') {
        const payload = voteReport();
        if (changed)
          payload.dokumentstatus.dokutskottsforslag.utskottsforslag[0]!.rubrik = 'Changed';
        return Response.json(payload);
      }
      return reportFetch()(request, options);
    });
    initRiksdagService({ fetch: network });
    const first = success(
      await runToolContract(riksdagGetVotes, {
        mode: 'report',
        session: '2024/25',
        documentId: 'HC01KU1',
        pointLimit: 1,
      }),
    );
    vi.advanceTimersByTime(1000);
    const cached = success(
      await runToolContract(
        riksdagGetVotes,
        continuationArgs(riksdagGetVotes, first.domain.nextCall),
      ),
    );
    expect(cached.enrichment.retrievedAt).toBe(first.enrichment.retrievedAt);
    expect(cached.domain.revision).toBe(first.domain.revision);
    changed = true;
    vi.advanceTimersByTime(300000);
    failure(
      await runToolContract(
        riksdagGetVotes,
        continuationArgs(riksdagGetVotes, first.domain.nextCall),
      ),
      'revision_changed',
    );
  });
  it('keeps one total deadline across report loading and ballot hydration', async () => {
    vi.useFakeTimers();
    const hydrationStarted = Promise.withResolvers<void>();
    const network = vi.fn<typeof fetch>().mockImplementation(async (request) => {
      if (new URL(String(request)).pathname === '/dokumentstatus/HC01KU1.json') {
        await new Promise<void>((resolve) => setTimeout(resolve, 40000));
        return Response.json(voteReport());
      }
      hydrationStarted.resolve();
      return new Response(new ReadableStream());
    });
    initRiksdagService({ fetch: network });
    const pending = runToolContract(riksdagGetVotes, {
      mode: 'report',
      session: '2024/25',
      documentId: 'HC01KU1',
    });
    await vi.advanceTimersByTimeAsync(40000);
    await hydrationStarted.promise;
    await vi.advanceTimersByTimeAsync(15000);
    const result = await pending;
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: JsonRpcErrorCode.Timeout, data: { reason: 'tool_deadline_exceeded' } },
      },
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('budget') }),
      ]),
    );
    expect(network).toHaveBeenCalledTimes(2);
  });
  it('cancels ballot body consumption instead of returning partially hydrated points', async () => {
    const caller = new AbortController();
    const ready = Promise.withResolvers<void>();
    const cancelled = vi.fn();
    const network: typeof fetch = async (request) => {
      if (new URL(String(request)).pathname === '/dokumentstatus/HC01KU1.json')
        return Response.json(voteReport());
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'));
            ready.resolve();
          },
          cancel: cancelled,
        }),
      );
    };
    initRiksdagService({ fetch: network });
    const pending = runToolContract(
      riksdagGetVotes,
      { mode: 'report', session: '2024/25', documentId: 'HC01KU1' },
      { context: { signal: caller.signal } },
    );
    await ready.promise;
    caller.abort();
    const result = await pending;
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: JsonRpcErrorCode.RequestCancelled } },
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringMatching(/cancel|abort/i) }),
      ]),
    );
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
  it('exposes queue saturation as an actionable error on both surfaces', async () => {
    const caller = new AbortController();
    initRiksdagService({ fetch: async () => new Response(new ReadableStream()) });
    const pending = Array.from({ length: 22 }, () =>
      runToolContract(
        riksdagGetVotes,
        { mode: 'member', session: '2024/25', memberId: '0001' },
        { context: { signal: caller.signal } },
      ),
    );
    const shed = await runToolContract(riksdagGetVotes, {
      mode: 'member',
      session: '2024/25',
      memberId: '0001',
    });
    failure(shed, 'upstream_queue_full');
    caller.abort();
    const cancelled = await Promise.all(pending);
    expect(cancelled.every((result) => result.isError)).toBe(true);
  });
  it('returns a source-unavailable error after one retry of recognizable HTML service failure', async () => {
    vi.useFakeTimers();
    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () => new Response('<html><title>503 Service unavailable</title></html>'),
      );
    initRiksdagService({ fetch: network });
    const pending = runToolContract(riksdagGetVotes, {
      mode: 'member',
      session: '2024/25',
      memberId: '0001',
    });
    await vi.advanceTimersByTimeAsync(500);
    failure(await pending, 'upstream_unavailable');
    expect(network).toHaveBeenCalledTimes(2);
  });
  it('keeps every report point and separates acclamation, unavailable, unknown and available publication', async () => {
    const network = vi.fn<typeof fetch>().mockImplementation(
      reportFetch((point) => ({
        voteringlista: {
          '@antal': point === 4 ? '1' : '0',
          '@villkor': `rm=2024/25:bet=KU1:punkt=${point}`,
          ...(point === 4
            ? {
                votering: {
                  votering_id: 'v1',
                  intressent_id: '0001',
                  rm: '2024/25',
                  beteckning: 'KU1',
                  punkt: '4',
                  dok_id: 'HC01KU1',
                  parti: 'S',
                  rost: undefined,
                  avser: 'motivering',
                },
              }
            : {}),
        },
      })),
    );
    initRiksdagService({ fetch: network });
    const result = await runToolContract(riksdagGetVotes, {
      mode: 'report',
      session: '2024/25',
      report: '2024/25:ku1',
    });
    const { domain, enrichment } = success(result);
    expect(domain).toMatchObject({
      mode: 'report',
      report: 'KU1',
      documentId: 'HC01KU1',
      pointTotalCount: 4,
      totalCount: 4,
      returnedCount: 4,
      pointLimit: 5,
      hasMore: false,
    });
    expect(domain.points?.map((point) => point.rollCallState)).toEqual([
      'acclamation',
      'not_published',
      'unknown',
      'available',
    ]);
    expect(domain.points?.[3]?.parties).toEqual([
      { party: 'S', otherVotes: [], observedVoteLabels: [], avser: 'motivering' },
    ]);
    expect(enrichment.notices.join(' ')).toContain('remain unknown, not zero');
    expect(network).toHaveBeenCalledTimes(6);
  });
  it.each([10, 11, 100000])(
    'traverses all report points with pointLimit %i and stable revision',
    async (pointLimit) => {
      initRiksdagService({ fetch: reportFetch(undefined, 12) });
      let args = riksdagGetVotes.input.parse({
        mode: 'report',
        session: '2024/25',
        documentId: 'hc01ku1',
        pointLimit,
      });
      const points: number[] = [];
      const pages: number[][] = [];
      let revision: string | undefined;
      for (;;) {
        const { domain, enrichment } = success(await runToolContract(riksdagGetVotes, args));
        expect(domain.requestedPointLimit).toBe(args.pointLimit);
        expect(domain.pointLimit).toBe(10);
        pages.push((domain.points ?? []).map((point) => point.decision.point));
        if (!points.length)
          expect(enrichment.notices.some((notice) => notice.includes('clamped'))).toBe(
            pointLimit > 10,
          );
        revision ??= domain.revision;
        expect(domain.revision).toBe(revision);
        expect(domain.pointOffset).toBe(points.length);
        points.push(...(domain.points ?? []).map((point) => point.decision.point));
        if (!domain.nextCall) break;
        expect(domain.nextCall.args).toMatchObject({
          mode: 'report',
          session: '2024/25',
          documentId: 'HC01KU1',
          report: 'KU1',
          pointOffset: points.length,
          revision,
        });
        args = riksdagGetVotes.input.parse(domain.nextCall.args);
      }
      expect(points).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      expect(pages).toEqual([
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        [11, 12],
      ]);
    },
  );
  it.each([
    { pointLimit: undefined, returned: [1, 2, 3, 4, 5], next: 5, applied: 5 },
    { pointLimit: 2, returned: [1, 2], next: 2, applied: 2 },
  ])(
    'returns pointLimit $pointLimit heavy points whenever that many remain',
    async ({ pointLimit, returned, next, applied }) => {
      const network = vi.fn<typeof fetch>().mockImplementation(
        reportFetch(
          (point) => ({
            voteringlista: {
              '@antal': '1',
              votering: {
                votering_id: `v${point}`,
                intressent_id: '0001',
                rm: '2024/25',
                beteckning: 'KU1',
                punkt: String(point),
                dok_id: 'HC01KU1',
                parti: 'x'.repeat(16000),
                rost: 'Nej',
              },
            },
          }),
          6,
        ),
      );
      initRiksdagService({ fetch: network });
      const result = await runToolContract(riksdagGetVotes, {
        mode: 'report',
        session: '2024/25',
        documentId: 'HC01KU1',
        ...(pointLimit === undefined ? {} : { pointLimit }),
      });
      const { domain, enrichment } = success(result);
      expect(domain).toMatchObject({
        returnedCount: returned.length,
        pointTotalCount: 6,
        pointLimit: applied,
        requestedPointLimit: applied,
        hasMore: true,
        nextCall: { args: { pointOffset: next, pointLimit: applied } },
      });
      expect(domain.points!.map((point) => point.decision.point)).toEqual(returned);
      expect(domain.points![0]!.parties).toMatchObject([{ party: 'x'.repeat(16000), no: 1 }]);
      expect(result.structuredContent).not.toHaveProperty('truncated');
      expect(enrichment.notices.join(' ')).not.toMatch(/response target|hydrated point/);
      expect(network).toHaveBeenCalledTimes(1 + returned.length);
      const rest = success(
        await runToolContract(riksdagGetVotes, continuationArgs(riksdagGetVotes, domain.nextCall)),
      );
      expect(rest.domain.points!.map((point) => point.decision.point)).toEqual(
        [1, 2, 3, 4, 5, 6].slice(next, next + applied),
      );
    },
  );
  it.each([500, 600])(
    'returns limit %i member rows of 652 published-size rows and continues at the applied limit',
    async (limit) => {
      const rows = publishedSizeRows(652, 'member');
      initRiksdagService({
        fetch: async () => Response.json({ voteringlista: { '@antal': '652', votering: rows } }),
      });
      const result = await runToolContract(riksdagGetVotes, {
        mode: 'member',
        session: '2024/25',
        memberId: '0257612529618',
        limit,
      });
      const { domain, enrichment } = success(result);
      expect(result.structuredContent).not.toHaveProperty('truncated');
      expect(domain).toMatchObject({
        totalCount: 652,
        returnedCount: 500,
        offset: 0,
        limit: 500,
        requestedLimit: limit,
        hasMore: true,
        nextCall: { args: { offset: 500, limit: 500 } },
      });
      expect(domain.votes).toHaveLength(500);
      expect(enrichment.notices.includes('Requested limit was clamped to 500.')).toBe(limit > 500);
      expect(enrichment.notices.join(' ')).not.toMatch(/response target|shortened/);
      const rest = success(
        await runToolContract(riksdagGetVotes, continuationArgs(riksdagGetVotes, domain.nextCall)),
      ).domain;
      expect(rest).toMatchObject({ returnedCount: 152, offset: 500, limit: 500, hasMore: false });
      expect(new Set([...domain.votes!, ...rest.votes!].map((row) => row.voteId)).size).toBe(652);
    },
  );
  it.each([
    { documentId: 'HC01FÖU1' },
    { documentId: 'hc01föu1' },
    { report: 'föu1' },
    { report: '2024/25:FÖU1' },
  ])(
    'returns the published designation and continues to the same report from %j',
    async (selection) => {
      const network = vi.fn<typeof fetch>().mockImplementation(publishedReportFetch());
      initRiksdagService({ fetch: network });
      let args: z.input<typeof riksdagGetVotes.input> = {
        mode: 'report',
        session: '2024/25',
        ...selection,
        pointLimit: 2,
      };
      const points: number[] = [];
      for (;;) {
        const { domain } = success(await runToolContract(riksdagGetVotes, args));
        expect(domain).toMatchObject({
          report: 'FöU1',
          documentId: 'HC01FÖU1',
          pointTotalCount: 3,
        });
        points.push(...domain.points!.map((point) => point.decision.point));
        if (!domain.nextCall) break;
        expect(domain.nextCall.args).toMatchObject({ report: 'FöU1', documentId: 'HC01FÖU1' });
        args = continuationArgs(riksdagGetVotes, domain.nextCall);
      }
      expect(points).toEqual([1, 2, 3]);
      expect(
        network.mock.calls.filter(([request]) => String(request).includes('/voteringlista/')),
      ).toHaveLength(3);
    },
  );
  it('echoes the normalized requested report when no exact report exists', async () => {
    initRiksdagService({
      fetch: async () => Response.json({ dokumentlista: { '@traffar': '0' } }),
    });
    const { domain, enrichment } = success(
      await runToolContract(riksdagGetVotes, {
        mode: 'report',
        session: '2024/25',
        report: 'föu1',
      }),
    );
    expect(domain).toMatchObject({ found: false, report: 'FÖU1' });
    expect(JSON.parse(enrichment.effectiveQuery)).toMatchObject({ report: 'FÖU1' });
  });
  it('distinguishes missing report, unknown point and empty report point catalog', async () => {
    initRiksdagService({
      fetch: async () => Response.json({ dokumentlista: { '@traffar': '0' } }),
    });
    const missingResult = await runToolContract(riksdagGetVotes, {
      mode: 'report',
      session: '2024/25',
      report: 'KU1',
    });
    expect(missingResult.structuredContent).toMatchObject({ mode: 'report', found: false });
    const missing = success(missingResult);
    expect(missing.domain).toMatchObject({
      found: false,
      guidance: expect.stringContaining('documentType bet'),
    });
    initRiksdagService({ fetch: reportFetch() });
    failure(
      await runToolContract(riksdagGetVotes, {
        mode: 'report',
        session: '2024/25',
        documentId: 'HC01KU1',
        point: 99,
      }),
      'unknown_point',
    );
    initRiksdagService({ fetch: reportFetch(undefined, 0) });
    expect(
      success(
        await runToolContract(riksdagGetVotes, {
          mode: 'report',
          session: '2024/25',
          documentId: 'HC01KU1',
        }),
      ).domain,
    ).toMatchObject({
      found: true,
      points: [],
      pointTotalCount: 0,
      totalCount: 0,
      returnedCount: 0,
      hasMore: false,
    });
  });
  it('selects one known point and provides terminal pages beyond the point catalog', async () => {
    const network = vi.fn<typeof fetch>().mockImplementation(reportFetch());
    initRiksdagService({ fetch: network });
    expect(
      success(
        await runToolContract(riksdagGetVotes, {
          mode: 'report',
          session: '2024/25',
          documentId: 'HC01KU1',
          point: 2,
        }),
      ).domain,
    ).toMatchObject({
      points: [{ decision: { point: 2 } }],
      returnedCount: 1,
      totalCount: 1,
      pointTotalCount: 4,
      hasMore: false,
    });
    const terminal = success(
      await runToolContract(riksdagGetVotes, {
        mode: 'report',
        session: '2024/25',
        documentId: 'HC01KU1',
        pointOffset: 100,
      }),
    );
    expect(terminal.domain).toMatchObject({ points: [], returnedCount: 0, hasMore: false });
    expect(terminal.enrichment.notices.join(' ')).toContain('beyond');
    expect(network).toHaveBeenCalledTimes(2);
  });
  it.each(['member', 'point'] as const)(
    'rejects exact %s saturation before returning a prefix',
    async (mode) => {
      const network: typeof fetch =
        mode === 'member'
          ? async () =>
              Response.json({
                voteringlista: {
                  '@antal': '50000',
                  votering: Array.from({ length: 50000 }, (_, i) => ({
                    votering_id: `v${i}`,
                    intressent_id: '0001',
                    rm: '2024/25',
                  })),
                },
              })
          : reportFetch(() => ({
              voteringlista: {
                '@antal': '50000',
                votering: Array.from({ length: 50000 }, (_, i) => ({
                  votering_id: `v${i}`,
                  intressent_id: '0001',
                  rm: '2024/25',
                  beteckning: 'KU1',
                  punkt: '1',
                  dok_id: 'HC01KU1',
                  parti: 'S',
                  rost: 'Ja',
                })),
              },
            }));
      initRiksdagService({ fetch: network });
      failure(
        await runToolContract(
          riksdagGetVotes,
          mode === 'member'
            ? { mode, session: '2024/25', memberId: '0001' }
            : { mode: 'report', session: '2024/25', documentId: 'HC01KU1', point: 1 },
        ),
        'candidate_limit_reached',
      );
    },
  );
  it.each([500, 501, 100000])(
    'traverses member pages requested at %i without missing or repeating a whole vote',
    async (limit) => {
      const rows = memberVoteRows(505);
      for (let i = 0; i < rows.length; i++) rows[i]!.namn = 'x'.repeat((i % 5) * 40) + String(i);
      const network = vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          Response.json({ voteringlista: { '@antal': '505', votering: rows } }),
        );
      initRiksdagService({ fetch: network });
      let args = riksdagGetVotes.input.parse({
        mode: 'member',
        session: '2024/25',
        memberId: '0001',
        party: 's',
        limit,
      });
      const ids: string[] = [];
      let revision: string | undefined;
      for (;;) {
        const { domain, enrichment } = success(await runToolContract(riksdagGetVotes, args));
        expect(domain).toMatchObject({
          candidateCount: 505,
          totalCount: 505,
          party: 'S',
          offset: ids.length,
          requestedLimit: args.limit,
        });
        if (!ids.length)
          expect(enrichment.notices.some((notice) => notice.includes('clamped'))).toBe(limit > 500);
        revision ??= domain.revision;
        expect(domain.revision).toBe(revision);
        ids.push(...(domain.votes ?? []).map((row) => row.voteId));
        if (!domain.nextCall) break;
        expect(domain.nextCall.args).toMatchObject({
          mode: 'member',
          session: '2024/25',
          memberId: '0001',
          party: 'S',
          offset: ids.length,
          revision,
        });
        args = riksdagGetVotes.input.parse(domain.nextCall.args);
      }
      // One shared timestamp and report: rows follow their points, which run opposite to voteId.
      expect(ids).toEqual(
        Array.from({ length: 505 }, (_, i) => `vote-${String(505 - i).padStart(4, '0')}`),
      );
      expect(network).toHaveBeenCalledTimes(1);
    },
  );
  const timestampOrder = [
    'H/motivfrågan',
    'H/sakfrågan',
    'D/sakfrågan',
    'E/frågan',
    'C/sakfrågan',
    'B/sakfrågan',
    'A/sakfrågan',
    'G/motivfrågan',
    'F/sakfrågan',
  ];
  it('orders member rows by source timestamp, then report, point, avser and voteId across a complete traversal', async () => {
    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ voteringlista: { '@antal': '9', votering: timestampedMemberRows() } }),
      );
    initRiksdagService({ fetch: network });
    let args: z.input<typeof riksdagGetVotes.input> = {
      mode: 'member',
      session: '2024/25',
      memberId: '0001',
      limit: 4,
    };
    const order: string[] = [];
    let revision: string | undefined;
    for (;;) {
      const { domain } = success(await runToolContract(riksdagGetVotes, args));
      revision ??= domain.revision;
      expect(domain.revision).toBe(revision);
      expect(domain.offset).toBe(order.length);
      order.push(...domain.votes!.map((row) => `${row.voteId}/${row.avser}`));
      if (!domain.nextCall) break;
      args = continuationArgs(riksdagGetVotes, domain.nextCall);
    }
    expect(order).toEqual(timestampOrder);
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('orders rows sharing timestamp, report and point by avser before voteId', async () => {
    const ku5 = (votering_id: string, avser: string) =>
      timestampedMemberRow(votering_id, 'KU5', '1', avser, '2025-01-02 09:00:00');
    // voteId order (I, J) runs opposite to avser order (motivfrågan, sakfrågan) and to source order.
    const rows = [ku5('I', 'sakfrågan'), ...timestampedMemberRows(), ku5('J', 'motivfrågan')];
    initRiksdagService({
      fetch: async () => Response.json({ voteringlista: { '@antal': '11', votering: rows } }),
    });
    const { domain } = success(
      await runToolContract(riksdagGetVotes, {
        mode: 'member',
        session: '2024/25',
        memberId: '0001',
      }),
    );
    expect(domain.votes!.map((row) => `${row.voteId}/${row.avser}`)).toEqual([
      'H/motivfrågan',
      'H/sakfrågan',
      'D/sakfrågan',
      'E/frågan',
      'C/sakfrågan',
      'B/sakfrågan',
      'J/motivfrågan',
      'I/sakfrågan',
      'A/sakfrågan',
      'G/motivfrågan',
      'F/sakfrågan',
    ]);
  });
  const memberReport = {
    mode: 'member' as const,
    session: '2024/25',
    memberId: '098412828516',
  };
  function memberReportNetwork(rows = memberReportRows()) {
    return vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ voteringlista: { '@antal': String(rows.length), votering: rows } }),
      );
  }
  it.each(['FöU1', 'föu1', 'FÖU1', '2024/25:FöU1', '2024/25: FöU1', 'FöU1'])(
    'narrows member rows to report %s locally with one cold request and none warm',
    async (report) => {
      const network = memberReportNetwork();
      initRiksdagService({ fetch: network });
      for (let call = 0; call < 2; call++) {
        const { domain } = success(
          await runToolContract(riksdagGetVotes, { ...memberReport, report }),
        );
        expect(domain).toMatchObject({
          found: true,
          candidateCount: 6,
          totalCount: 2,
          returnedCount: 2,
          hasMore: false,
        });
        expect(domain.votes!.map((row) => [row.voteId, row.point, row.vote])).toEqual([
          ['V-FOU1-1', 1, 'Nej'],
          ['V-FOU1-3', 3, 'Ja'],
        ]);
        expect(network).toHaveBeenCalledTimes(1);
      }
      expect(String(network.mock.calls[0]?.[0])).toBe(
        'https://data.riksdagen.se/voteringlista/?iid=098412828516&rm=2024%2F25&sz=50000&utformat=json',
      );
    },
  );
  it('normalizes member-row report document IDs and keeps designations and out-of-grammar document IDs as published', async () => {
    initRiksdagService({ fetch: memberReportNetwork() });
    const { domain } = success(await runToolContract(riksdagGetVotes, memberReport));
    expect(domain.votes!.map((row) => [row.voteId, row.report, row.documentId])).toEqual([
      ['V-KU1-1', 'KU1', 'HC01KU1'],
      ['V-FIU1-2', 'FiU1', 'HC01FIU1'],
      ['V-SPARSE', undefined, 'HC01SKU1'],
      ['V-FOU1-1', 'FöU1', 'HC01FÖU1'],
      ['V-FOU1-3', 'FöU1', 'HC01FÖU1'],
      ['V-VOTERING', '0118-1', 'HC010118-1'],
    ]);
  });
  it('links a point-zero member row to a vote record riksdag_get_document reads unchanged', async () => {
    const paths: string[] = [];
    initRiksdagService({
      fetch: async (request) => {
        const url = new URL(String(request));
        paths.push(url.pathname);
        if (url.pathname === '/voteringlista/')
          return Response.json({
            voteringlista: {
              '@antal': '1',
              votering: {
                votering_id: 'AE2946B2-76D0-465F-880F-D7F5717F8F7C',
                intressent_id: '0257612529618',
                rm: '2018/19',
                beteckning: '0118-1',
                punkt: '0',
                rost: 'Nej',
                avser: 'sakfrågan',
                dok_id: 'h6190118-1',
              },
            },
          });
        return Response.json({
          dokumentstatus: {
            dokument: {
              dok_id: 'H6190118-1',
              doktyp: 'votering',
              rm: '2018/19',
              beteckning: '0118-1',
            },
          },
        });
      },
    });
    const { domain } = success(
      await runToolContract(riksdagGetVotes, {
        mode: 'member',
        session: '2018/19',
        memberId: '0257612529618',
      }),
    );
    const [row] = domain.votes ?? [];
    expect(row).toMatchObject({ report: '0118-1', documentId: 'H6190118-1' });
    expect(row).not.toHaveProperty('point');
    expect(
      riksdagGetDocument.input.safeParse({ documentId: row?.documentId }).error,
    ).toBeUndefined();
    const document = await runToolContract(riksdagGetDocument, { documentId: row!.documentId! });
    expect(document.isError).not.toBe(true);
    expect(document.structuredContent).toMatchObject({
      found: true,
      documentId: 'H6190118-1',
      metadata: { documentType: 'votering', designation: '0118-1' },
    });
    expect(paths).toEqual(['/voteringlista/', '/dokumentstatus/H6190118-1.json']);
  });
  it('narrows a member report to one point and keeps the member/session revision', async () => {
    initRiksdagService({ fetch: memberReportNetwork() });
    const unfiltered = success(await runToolContract(riksdagGetVotes, memberReport)).domain;
    const { domain, enrichment } = success(
      await runToolContract(riksdagGetVotes, { ...memberReport, report: 'FöU1', point: 3 }),
    );
    expect(domain).toMatchObject({
      candidateCount: 6,
      totalCount: 1,
      revision: unfiltered.revision,
      votes: [{ voteId: 'V-FOU1-3', point: 3 }],
    });
    expect(JSON.parse(enrichment.effectiveQuery)).toMatchObject({ report: 'FÖU1', point: 3 });
  });
  it.each([
    { report: 'KU9', notice: 'matched report KU9 in this session' },
    { report: 'FöU1', point: 2, notice: 'matched report FÖU1 point 2 in this session' },
  ])(
    'keeps an empty member report selection successful with a report-specific notice ($report)',
    async ({ notice, ...filter }) => {
      initRiksdagService({ fetch: memberReportNetwork() });
      const { domain, enrichment } = success(
        await runToolContract(riksdagGetVotes, { ...memberReport, ...filter }),
      );
      expect(domain).toMatchObject({
        found: true,
        votes: [],
        candidateCount: 6,
        totalCount: 0,
        returnedCount: 0,
        hasMore: false,
      });
      const notices = enrichment.notices.join(' ');
      expect(notices).toContain(notice);
      expect(notices).toContain('does not establish absence or an acclamation decision');
      expect(notices).toContain('report mode');
      expect(notices).not.toContain('Check memberId');
    },
  );
  it('explains an offset beyond the report-filtered rows while member candidates remain', async () => {
    initRiksdagService({ fetch: memberReportNetwork() });
    const { domain, enrichment } = success(
      await runToolContract(riksdagGetVotes, { ...memberReport, report: 'FöU1', offset: 3 }),
    );
    expect(domain).toMatchObject({
      found: true,
      votes: [],
      candidateCount: 6,
      totalCount: 2,
      returnedCount: 0,
      offset: 3,
      hasMore: false,
    });
    expect(enrichment.notices).toContain(
      'The row offset is beyond the filtered result; this is an empty terminal page.',
    );
  });
  it('traverses a filtered member report with report and party kept in continuation', async () => {
    const network = memberReportNetwork();
    initRiksdagService({ fetch: network });
    let args: z.input<typeof riksdagGetVotes.input> = {
      ...memberReport,
      report: 'föu1',
      party: 's',
      limit: 1,
    };
    const ids: string[] = [];
    for (;;) {
      const { domain } = success(await runToolContract(riksdagGetVotes, args));
      expect(domain).toMatchObject({ totalCount: 2, offset: ids.length, party: 'S' });
      ids.push(...domain.votes!.map((row) => row.voteId));
      if (!domain.nextCall) break;
      expect(domain.nextCall.args).toMatchObject({
        mode: 'member',
        memberId: '098412828516',
        report: 'FöU1',
        party: 'S',
        offset: ids.length,
        limit: 1,
        revision: domain.revision,
      });
      args = continuationArgs(riksdagGetVotes, domain.nextCall);
    }
    expect(ids).toEqual(['V-FOU1-1', 'V-FOU1-3']);
    const point = success(
      await runToolContract(riksdagGetVotes, {
        ...memberReport,
        report: 'FöU1',
        point: 1,
        limit: 1,
      }),
    ).domain;
    expect(point).toMatchObject({ totalCount: 1, hasMore: false, votes: [{ voteId: 'V-FOU1-1' }] });
    expect(network).toHaveBeenCalledTimes(2);
  });
  it('continues a point-filtered member report with report and point kept in continuation', async () => {
    const rows = memberReportRows();
    const pointOne = rows.find((row) => row.votering_id === 'V-FOU1-1')!;
    // A second FöU1 point-1 vote (motivation); it sorts before the substantive V-FOU1-1 row.
    rows.push({ ...pointOne, votering_id: 'V-FOU1-1-MOTIV', avser: 'motivfrågan' });
    const network = memberReportNetwork(rows);
    initRiksdagService({ fetch: network });
    let args: z.input<typeof riksdagGetVotes.input> = {
      ...memberReport,
      report: 'föu1',
      point: 1,
      limit: 1,
    };
    const ids: string[] = [];
    for (;;) {
      const { domain } = success(await runToolContract(riksdagGetVotes, args));
      expect(domain).toMatchObject({
        candidateCount: 7,
        totalCount: 2,
        returnedCount: 1,
        offset: ids.length,
      });
      ids.push(...domain.votes!.map((row) => `${row.voteId}/${row.point}`));
      if (!domain.nextCall) break;
      expect(domain.nextCall.args).toMatchObject({
        mode: 'member',
        memberId: '098412828516',
        report: 'FöU1',
        point: 1,
        offset: ids.length,
        limit: 1,
        revision: domain.revision,
      });
      args = continuationArgs(riksdagGetVotes, domain.nextCall);
    }
    expect(ids).toEqual(['V-FOU1-1-MOTIV/1', 'V-FOU1-1/1']);
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('declares and returns no vote date on either surface even when a source row carries datum', async () => {
    initRiksdagService({
      fetch: async () =>
        Response.json({
          voteringlista: {
            '@antal': '1',
            votering: { ...memberVoteRows(1)[0], datum: '2025-01-02' },
          },
        }),
    });
    const result = await runToolContract(riksdagGetVotes, {
      mode: 'member',
      session: '2024/25',
      memberId: '0001',
    });
    const { domain } = success(result);
    expect(domain.votes).toMatchObject([{ systemDate: '2025-01-02 12:00:00' }]);
    expect(domain.votes![0]).not.toHaveProperty('date');
    const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    expect(text).not.toContain('"date"');
    expect(JSON.stringify(z.toJSONSchema(riksdagGetVotes.output))).not.toContain('"date"');
  });
  it('derives the member revision from complete candidates rather than source order and rejects a changed timestamp', async () => {
    vi.useFakeTimers();
    let rows = timestampedMemberRows();
    initRiksdagService({
      fetch: async () => Response.json({ voteringlista: { '@antal': '9', votering: rows } }),
    });
    const first = success(
      await runToolContract(riksdagGetVotes, {
        mode: 'member',
        session: '2024/25',
        memberId: '0001',
        limit: 4,
      }),
    );
    rows = timestampedMemberRows().reverse();
    vi.advanceTimersByTime(300001);
    const reordered = success(
      await runToolContract(
        riksdagGetVotes,
        continuationArgs(riksdagGetVotes, first.domain.nextCall),
      ),
    );
    expect(reordered.domain.revision).toBe(first.domain.revision);
    expect(reordered.domain.votes!.map((row) => `${row.voteId}/${row.avser}`)).toEqual(
      timestampOrder.slice(4, 8),
    );
    rows = timestampedMemberRows();
    rows[1]!.systemdatum = '2025-01-04 10:00:00';
    vi.advanceTimersByTime(300001);
    failure(
      await runToolContract(
        riksdagGetVotes,
        continuationArgs(riksdagGetVotes, first.domain.nextCall),
      ),
      'revision_changed',
    );
  });
  it('filters party before slicing and preserves exact candidate and filtered totals', async () => {
    const rows = [
      memberVoteRows(1)[0]!,
      { votering_id: 'unknown-party', intressent_id: '0001', rm: '2024/25' },
    ];
    initRiksdagService({
      fetch: async () => Response.json({ voteringlista: { '@antal': '2', votering: rows } }),
    });
    const { domain } = success(
      await runToolContract(riksdagGetVotes, {
        mode: 'member',
        session: '2024/25',
        memberId: '0001',
        party: 'S',
        limit: 1,
      }),
    );
    expect(domain).toMatchObject({
      candidateCount: 2,
      totalCount: 1,
      returnedCount: 1,
      votes: [{ voteId: 'vote-0001' }],
      hasMore: false,
    });
  });
  it('keeps empty member selections successful and explains offsets beyond the end', async () => {
    initRiksdagService({ fetch: async () => Response.json({ voteringlista: { '@antal': '0' } }) });
    const empty = success(
      await runToolContract(riksdagGetVotes, {
        mode: 'member',
        session: '2024/25',
        memberId: '0001',
      }),
    );
    expect(empty.domain).toMatchObject({
      found: true,
      votes: [],
      candidateCount: 0,
      totalCount: 0,
      returnedCount: 0,
      hasMore: false,
    });
    expect(empty.enrichment.notices.join(' ')).toContain('no votes does not establish');
    const terminal = success(
      await runToolContract(riksdagGetVotes, {
        mode: 'member',
        session: '2024/25',
        memberId: '0001',
        offset: 100,
      }),
    );
    expect(terminal.domain).toMatchObject({ votes: [], returnedCount: 0, hasMore: false });
    expect(terminal.enrichment.notices.join(' ')).toContain('beyond');
  });
});
