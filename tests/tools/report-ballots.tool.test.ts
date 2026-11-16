/** @fileoverview Report ballot pagination and independent revision contracts. @module tests/tools/report-ballots.tool */
import type { z } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { riksdagGetVotes } from '@/mcp-server/tools/definitions/get-votes.tool.js';
import { getRiksdagService, initRiksdagService } from '@/services/riksdag/riksdag-service.js';
import { continuationArgs } from '../services/riksdag/continuation-fixtures.js';
import {
  publishedReportFetch,
  publishedSizeRows,
  reportFetch,
} from '../services/riksdag/vote-fixtures.js';

afterEach(() => {
  vi.useRealTimers();
  getRiksdagService().dispose();
});
const args = {
  mode: 'report' as const,
  session: '2024/25',
  documentId: 'HC01KU1',
  point: 1,
  ballots: true,
  limit: 1,
};
function rows() {
  return ['sakfrågan', 'motivfrågan', 'annan'].map((avser, i) => ({
    votering_id: 'v1',
    intressent_id: '0001',
    rm: '2024/25',
    beteckning: 'KU1',
    punkt: '1',
    dok_id: 'HC01KU1',
    parti: 'S',
    avser,
    rost: i ? 'Nej' : 'Ja',
  }));
}
function success(result: Awaited<ReturnType<typeof runToolContract>>) {
  expect(result.isError).not.toBe(true);
  const output = riksdagGetVotes.output.parse(result.structuredContent);
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('Expected domain text.');
  const newline = first.text.indexOf('\n');
  const delimiter = first.text.slice(0, newline).replace(/json$/, '');
  expect(
    JSON.parse(first.text.slice(newline + 1, first.text.indexOf(`\n${delimiter}`, newline))),
  ).toEqual(output);
  return output;
}
describe('report ballots', () => {
  it.each([false, true])(
    'discloses unidentified party ballots with ballots %s without inventing a party or subject',
    async (ballots) => {
      const row = { ...rows()[0], parti: undefined, avser: undefined };
      initRiksdagService({
        fetch: reportFetch(() => ({ voteringlista: { '@antal': '1', votering: row } })),
      });
      const result = await runToolContract(riksdagGetVotes, { ...args, ballots, limit: undefined });
      const domain = success(result);
      expect(domain.points).toMatchObject([{ rollCallState: 'acclamation', parties: [] }]);
      expect(JSON.stringify(result.structuredContent)).toContain(
        '1 published ballots omit party identity',
      );
      expect(JSON.stringify(result.content)).toContain('1 published ballots omit party identity');
      if (ballots)
        expect(domain.votes).toEqual([
          {
            voteId: 'v1',
            memberId: '0001',
            session: '2024/25',
            report: 'KU1',
            point: 1,
            vote: 'Ja',
            documentId: 'HC01KU1',
          },
        ]);
    },
  );
  it('preserves zero-point member rows and shared vote/member subjects on both surfaces', async () => {
    const ballots = rows().map((row) => ({ ...row, punkt: '0' }));
    initRiksdagService({
      fetch: async () => Response.json({ voteringlista: { '@antal': '3', votering: ballots } }),
    });
    const result = success(
      await runToolContract(riksdagGetVotes, {
        mode: 'member',
        session: '2024/25',
        memberId: '0001',
      }),
    );
    // Source order is sakfrågan, motivfrågan, annan; shared vote/member rows order by avser.
    expect(result.votes!.map((row) => row.avser)).toEqual(['annan', 'motivfrågan', 'sakfrågan']);
    for (const row of result.votes!) {
      expect(row).toMatchObject({ memberId: '0001', documentId: 'HC01KU1', report: 'KU1' });
      expect(row).not.toHaveProperty('point');
    }
  });
  it('retains observed labels but leaves every exact group count unknown when one ballot omits its label', async () => {
    const ballots = rows();
    ballots[1]!.avser = 'sakfrågan';
    ballots[1]!.intressent_id = '0003';
    ballots[1]!.rost = 'Annan röst';
    const missing = { ...ballots[0], intressent_id: '0002', rost: undefined };
    initRiksdagService({
      fetch: reportFetch(() => ({
        voteringlista: { '@antal': '4', votering: [...ballots, missing] },
      })),
    });
    const result = await runToolContract(riksdagGetVotes, { ...args, limit: 20 });
    const domain = success(result);
    const party = domain.points![0]!.parties.find((row) => row.avser === 'sakfrågan');
    expect(party).toEqual({
      party: 'S',
      avser: 'sakfrågan',
      observedVoteLabels: ['Ja', 'Annan röst'],
      otherVotes: [{ vote: 'Annan röst' }],
    });
    expect(JSON.stringify(result.content)).toContain('exact counts remain unknown');
  });
  it('orders one point’s ballots by voteId, then memberId, whatever the source order', async () => {
    const ballot = (votering_id: string, intressent_id: string, avser: string) => ({
      ...rows()[0],
      votering_id,
      intressent_id,
      avser,
    });
    // Two votes on point 1 across two members; voteId order runs opposite to avser order.
    const source = [
      ballot('V2', '0001', 'motivfrågan'),
      ballot('V1', '0002', 'sakfrågan'),
      ballot('V2', '0002', 'motivfrågan'),
      ballot('V1', '0001', 'sakfrågan'),
    ];
    initRiksdagService({
      fetch: reportFetch(() => ({ voteringlista: { '@antal': '4', votering: source } })),
    });
    const domain = success(await runToolContract(riksdagGetVotes, { ...args, limit: 20 }));
    expect(domain.votes!.map((row) => `${row.voteId}/${row.memberId}`)).toEqual([
      'V1/0001',
      'V1/0002',
      'V2/0001',
      'V2/0002',
    ]);
  });
  it.each([
    { mode: 'member', memberId: '0001', ballots: true },
    { mode: 'report', documentId: 'HC01KU1', ballots: true },
    { mode: 'report', documentId: 'HC01KU1', point: 1, ballots: false, offset: 0 },
    { mode: 'report', documentId: 'HC01KU1', point: 1, ballotRevision: 'old' },
  ] as const)('rejects invalid ballot selections before acquisition %j', async (input) => {
    const network = vi.fn<typeof fetch>();
    initRiksdagService({ fetch: network });
    const result = await runToolContract(riksdagGetVotes, { ...input, session: '2024/25' });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { data: { reason: 'invalid_filter' } } },
    });
    expect(JSON.stringify(result.content)).toContain('riksdag_list_reference');
    expect(network).not.toHaveBeenCalled();
  });
  it.each([undefined, false, true])(
    'uses one status and one ballot request with ballots %s',
    async (ballots) => {
      const network = vi
        .fn<typeof fetch>()
        .mockImplementation(
          reportFetch(() => ({ voteringlista: { '@antal': '3', votering: rows() } })),
        );
      initRiksdagService({ fetch: network });
      const result = success(
        await runToolContract(riksdagGetVotes, {
          mode: 'report',
          session: '2024/25',
          documentId: 'HC01KU1',
          point: 1,
          ...(ballots === undefined ? {} : { ballots }),
        }),
      );
      expect(network).toHaveBeenCalledTimes(2);
      expect(result.ballotPage === undefined).toBe(ballots !== true);
      expect(result.votes === undefined).toBe(ballots !== true);
      expect(String(network.mock.calls[1]![0])).not.toContain('gruppering');
    },
  );
  it('keeps empty publication and past-end ballot pages terminal while retaining authoritative acclamation', async () => {
    initRiksdagService({ fetch: reportFetch() });
    const empty = success(
      await runToolContract(riksdagGetVotes, { ...args, offset: 4, limit: 100000 }),
    );
    expect(empty).toMatchObject({
      votes: [],
      points: [{ rollCallState: 'acclamation' }],
      ballotPage: {
        totalCount: 0,
        returnedCount: 0,
        offset: 4,
        limit: 500,
        requestedLimit: 100000,
        hasMore: false,
      },
    });
    expect(empty.ballotPage!.nextCall).toBeUndefined();
    initRiksdagService({
      fetch: reportFetch(() => ({ voteringlista: { '@antal': '3', votering: rows() } })),
    });
    const terminal = success(await runToolContract(riksdagGetVotes, { ...args, offset: 3 }));
    expect(terminal).toMatchObject({
      votes: [],
      ballotPage: { totalCount: 3, returnedCount: 0, hasMore: false },
    });
  });
  it('validates report and point before acquiring ballots', async () => {
    const network = vi.fn<typeof fetch>().mockImplementation(reportFetch());
    initRiksdagService({ fetch: network });
    const unknown = await runToolContract(riksdagGetVotes, { ...args, point: 99 });
    expect(unknown).toMatchObject({
      isError: true,
      structuredContent: { error: { data: { reason: 'unknown_point' } } },
    });
    expect(JSON.stringify(unknown.content)).toContain('riksdag_get_document');
    expect(network).toHaveBeenCalledTimes(1);
    initRiksdagService({ fetch: async () => new Response('', { status: 404 }) });
    const missing = success(await runToolContract(riksdagGetVotes, args));
    expect(missing).toMatchObject({ found: false });
    expect(missing.ballotPage).toBeUndefined();
  });
  it('traverses three pages with independent ballot counts and complete continuation on both surfaces', async () => {
    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(
        reportFetch(() => ({ voteringlista: { '@antal': '3', votering: rows() } })),
      );
    initRiksdagService({ fetch: network });
    let input = riksdagGetVotes.input.parse(args);
    const subjects: string[] = [];
    for (;;) {
      const result = success(await runToolContract(riksdagGetVotes, input));
      expect(result).toMatchObject({
        totalCount: 1,
        returnedCount: 1,
        pointTotalCount: 4,
        hasMore: false,
      });
      expect(result.ballotPage).toMatchObject({
        totalCount: 3,
        offset: subjects.length,
        returnedCount: 1,
      });
      subjects.push(...result.votes!.map((row) => row.avser!));
      if (!result.ballotPage!.nextCall) break;
      expect(result.ballotPage!.nextCall.args).toMatchObject({
        ...args,
        report: 'KU1',
        offset: subjects.length,
        revision: result.revision,
        ballotRevision: result.ballotPage!.revision,
      });
      input = riksdagGetVotes.input.parse(result.ballotPage!.nextCall.args);
    }
    expect(subjects).toEqual(['annan', 'motivfrågan', 'sakfrågan']);
    expect(network).toHaveBeenCalledTimes(2);
  });
  const published349 = () =>
    reportFetch(() => ({
      voteringlista: { '@antal': '349', votering: publishedSizeRows(349, 'ballots') },
    }));
  it.each([500, 600])(
    'returns every one of 349 published-size ballots at limit %i in one page',
    async (limit) => {
      initRiksdagService({ fetch: published349() });
      const result = await runToolContract(riksdagGetVotes, { ...args, limit });
      const domain = success(result);
      expect(domain.votes).toHaveLength(349);
      // The raw surface, so a field the output schema no longer declares cannot hide in parsing.
      expect(result.structuredContent).not.toHaveProperty('truncated');
      expect(result.structuredContent).toHaveProperty('ballotPage', {
        revision: expect.any(String),
        totalCount: 349,
        returnedCount: 349,
        offset: 0,
        limit: 500,
        requestedLimit: limit,
        hasMore: false,
      });
      const notices = JSON.stringify(result.structuredContent);
      expect(notices.includes('Requested limit was clamped to 500.')).toBe(limit > 500);
      expect(notices).not.toMatch(/response target|shortened/);
    },
  );
  it('pages published-size ballots at the requested limit through every re-slice', async () => {
    const network = vi.fn<typeof fetch>().mockImplementation(published349());
    initRiksdagService({ fetch: network });
    let input: z.input<typeof riksdagGetVotes.input> = { ...args, limit: 100 };
    const pageSizes: number[] = [];
    const memberIds: string[] = [];
    for (;;) {
      const raw = await runToolContract(riksdagGetVotes, input);
      const result = success(raw);
      expect(result).toMatchObject({ returnedCount: 1, points: [{ decision: { point: 1 } }] });
      expect(result.ballotPage).toMatchObject({ offset: memberIds.length, limit: 100 });
      expect(raw.structuredContent).not.toHaveProperty('ballotPage.truncated');
      expect(raw.structuredContent).not.toHaveProperty('truncated');
      pageSizes.push(result.votes!.length);
      memberIds.push(...result.votes!.map((row) => row.memberId));
      if (!result.ballotPage!.nextCall) break;
      expect(result.ballotPage!.nextCall.args).toMatchObject({
        limit: 100,
        offset: memberIds.length,
      });
      input = continuationArgs(riksdagGetVotes, result.ballotPage!.nextCall);
    }
    expect(pageSizes).toEqual([100, 100, 100, 49]);
    expect(memberIds).toEqual(
      Array.from({ length: 349 }, (_, i) => String(i + 1).padStart(13, '0')),
    );
    expect(network).toHaveBeenCalledTimes(2);
  });
  it('returns the published designation and normalized ballot document IDs through ballot continuation', async () => {
    initRiksdagService({ fetch: publishedReportFetch(3) });
    let input: z.input<typeof riksdagGetVotes.input> = {
      mode: 'report',
      session: '2024/25',
      report: 'FÖU1',
      point: 2,
      ballots: true,
      limit: 2,
    };
    const memberIds: string[] = [];
    for (;;) {
      const result = success(await runToolContract(riksdagGetVotes, input));
      expect(result).toMatchObject({ report: 'FöU1', documentId: 'HC01FÖU1' });
      for (const row of result.votes!)
        expect(row).toMatchObject({ report: 'FöU1', documentId: 'HC01FÖU1', point: 2 });
      memberIds.push(...result.votes!.map((row) => row.memberId));
      if (!result.ballotPage!.nextCall) break;
      expect(result.ballotPage!.nextCall.args).toMatchObject({
        report: 'FöU1',
        documentId: 'HC01FÖU1',
        point: 2,
        ballots: true,
      });
      input = continuationArgs(riksdagGetVotes, result.ballotPage!.nextCall);
    }
    expect(memberIds).toEqual(['0001', '0002', '0003']);
  });
  it('rejects changed ballot data while the report catalog stays unchanged', async () => {
    vi.useFakeTimers();
    let changed = false;
    initRiksdagService({
      fetch: reportFetch(() => {
        const ballots = rows();
        if (changed) ballots[2]!.rost = 'Avstår';
        return { voteringlista: { '@antal': '3', votering: ballots } };
      }),
    });
    const first = success(await runToolContract(riksdagGetVotes, args));
    changed = true;
    vi.advanceTimersByTime(300001);
    const result = await runToolContract(
      riksdagGetVotes,
      continuationArgs(riksdagGetVotes, first.ballotPage!.nextCall),
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          data: {
            reason: 'revision_changed',
            recovery: { hint: expect.stringContaining('Restart') },
          },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('Restart');
  });
});
