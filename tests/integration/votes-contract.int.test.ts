/** @fileoverview Whole-point and member-vote public contracts. @module tests/integration/votes-contract */
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { riksdagGetVotes } from '@/mcp-server/tools/definitions/get-votes.tool.js';
import { successEnrichment } from '@/services/riksdag/output.js';
import { getRiksdagService, initRiksdagService } from '@/services/riksdag/riksdag-service.js';
import { memberVoteRows, reportFetch, voteReport } from '../services/riksdag/vote-fixtures.js';

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
  it.each(['metadata', 'grouped-echo'])(
    'returns %s identity mismatch and recovery through both surfaces',
    async (kind) => {
      const network: typeof fetch =
        kind === 'metadata'
          ? async () => {
              const payload = voteReport();
              payload.dokumentstatus.dokument.doktyp = 'mot';
              return Response.json(payload);
            }
          : reportFetch(() => ({
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
    },
  );
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
    const cached = success(await runToolContract(riksdagGetVotes, first.domain.nextCall!.args));
    expect(cached.enrichment.retrievedAt).toBe(first.enrichment.retrievedAt);
    expect(cached.domain.revision).toBe(first.domain.revision);
    expect(network).toHaveBeenCalledTimes(1);
    changed = true;
    vi.advanceTimersByTime(300000);
    failure(
      await runToolContract(riksdagGetVotes, first.domain.nextCall!.args),
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
    const cached = success(await runToolContract(riksdagGetVotes, first.domain.nextCall!.args));
    expect(cached.enrichment.retrievedAt).toBe(first.enrichment.retrievedAt);
    expect(cached.domain.revision).toBe(first.domain.revision);
    changed = true;
    vi.advanceTimersByTime(300000);
    failure(
      await runToolContract(riksdagGetVotes, first.domain.nextCall!.args),
      'revision_changed',
    );
  });
  it('keeps one total deadline across report loading and grouped hydration', async () => {
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
  it('cancels grouped body consumption instead of returning partially hydrated points', async () => {
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
                  parti: 'S',
                  Ja: '0',
                  Nej: '',
                  Avstår: '2',
                  Annan: '',
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
      { party: 'S', yes: 0, abstain: 2, otherVotes: [{ vote: 'Annan' }], avser: 'motivering' },
    ]);
    expect(enrichment.notices.join(' ')).toContain('remain unknown, not zero');
    expect(network).toHaveBeenCalledTimes(6);
  });
  it.each([10, 11])(
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
      let revision: string | undefined;
      for (;;) {
        const { domain, enrichment } = success(await runToolContract(riksdagGetVotes, args));
        expect(domain.requestedPointLimit).toBe(args.pointLimit);
        expect(domain.pointLimit).toBeLessThanOrEqual(10);
        if (!points.length)
          expect(enrichment.notices.some((notice) => notice.includes('clamped'))).toBe(
            pointLimit === 11,
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
    },
  );
  it('preserves an already hydrated oversized point and continues after it', async () => {
    const network = vi.fn<typeof fetch>().mockImplementation(
      reportFetch(
        () => ({
          voteringlista: { '@antal': '1', votering: { parti: 'x'.repeat(16000), Ja: '0' } },
        }),
        3,
      ),
    );
    initRiksdagService({ fetch: network });
    const { domain, enrichment } = success(
      await runToolContract(riksdagGetVotes, {
        mode: 'report',
        session: '2024/25',
        documentId: 'HC01KU1',
      }),
    );
    expect(domain).toMatchObject({
      returnedCount: 1,
      pointTotalCount: 3,
      truncated: true,
      pointLimit: 1,
      points: [{ decision: { point: 1 }, parties: [{ party: 'x'.repeat(16000), yes: 0 }] }],
      nextCall: { args: { pointOffset: 1 } },
    });
    expect(enrichment.notices.join(' ')).toContain('Every hydrated point');
    expect(network).toHaveBeenCalledTimes(2);
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
  it.each(['member', 'grouped'] as const)(
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
                '@antal': '500',
                votering: Array.from({ length: 500 }, (_, i) => ({ parti: `P${i}`, Ja: '0' })),
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
  it.each([500, 501])(
    'traverses measured member pages requested at %i without missing or repeating a whole vote',
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
          expect(enrichment.notices.some((notice) => notice.includes('clamped'))).toBe(
            limit === 501,
          );
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
      expect(ids).toEqual(
        Array.from({ length: 505 }, (_, i) => `vote-${String(i + 1).padStart(4, '0')}`),
      );
      expect(network).toHaveBeenCalledTimes(1);
    },
  );
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
