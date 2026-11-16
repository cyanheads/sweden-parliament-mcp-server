/** @fileoverview Main-vote parsing and report identity at the network boundary. @module tests/services/riksdag/votes */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it, vi } from 'vitest';
import { RiksdagService } from '@/services/riksdag/riksdag-service.js';
import { createToolBudget } from '@/services/riksdag/transport.js';
import { hydrateVotePoint, loadMemberVotes, loadVoteReport } from '@/services/riksdag/votes.js';
import { memberVoteRows, reportFetch, voteReport } from './vote-fixtures.js';

describe('main vote endpoints', () => {
  it('classifies malformed source session syntax as an upstream schema failure rather than caller input', async () => {
    const service = new RiksdagService({
      fetch: async () =>
        Response.json({
          voteringlista: {
            '@antal': '1',
            votering: { votering_id: 'v1', intressent_id: '0001', rm: 'not-a-session' },
          },
        }),
    });
    using budget = createToolBudget();
    try {
      await expect(
        loadMemberVotes(service, '2024/25', '0001', undefined, budget),
      ).rejects.toMatchObject({ data: { reason: 'upstream_schema_invalid' } });
    } finally {
      service.dispose();
    }
  });
  it('acquires a complete member set with exact query keys and preserves source precision', async () => {
    const network = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        voteringlista: {
          '@antal': '4',
          '@villkor': 'rm=2024/25:iid=0001',
          '@q': 'upstream',
          '@varning': 'Källvarning',
          votering: memberVoteRows(),
        },
      }),
    );
    const service = new RiksdagService({ fetch: network });
    using budget = createToolBudget();
    try {
      const result = await loadMemberVotes(service, '2024/25', '0001', 'S', budget);
      expect(result).toMatchObject({ candidateCount: 4, upstreamWarnings: ['Källvarning'] });
      // One shared timestamp and report, so rows order by point.
      expect(result.rows.map((row) => row.voteId)).toEqual([
        'vote-0004',
        'vote-0003',
        'vote-0002',
        'vote-0001',
      ]);
      expect(result.rows[0]).toMatchObject({
        memberId: '0001',
        point: 1,
        systemDate: '2025-01-02 12:00:00',
        vote: 'Ja',
        avser: 'motivering',
        sourceUrl: 'https://data.riksdagen.se/votering/row-1',
      });
      expect(result.rows[0]).not.toHaveProperty('date');
      expect(String(network.mock.calls[0]?.[0])).toBe(
        'https://data.riksdagen.se/voteringlista/?iid=0001&parti=S&rm=2024%2F25&sz=50000&utformat=json',
      );
      expect(network).toHaveBeenCalledTimes(1);
    } finally {
      service.dispose();
    }
  });
  it('normalizes every linked document ID in the shared grammar and keeps any other as published', async () => {
    const published = [
      ['H6190118-1', 'H6190118-1'],
      ['h6190118-1', 'H6190118-1'],
      ['HC01FöU1', 'HC01FÖU1'],
      ['HC01FüU1', 'HC01FüU1'],
      ['HC010118-1', 'HC010118-1'],
    ] as const;
    const rows = memberVoteRows(published.length).map((row, i) => ({
      ...row,
      dok_id: published[i]![0],
    }));
    const service = new RiksdagService({
      fetch: async () =>
        Response.json({ voteringlista: { '@antal': String(rows.length), votering: rows } }),
    });
    using budget = createToolBudget();
    try {
      const result = await loadMemberVotes(service, '2024/25', '0001', undefined, budget);
      expect(Object.fromEntries(result.rows.map((row) => [row.voteId, row.documentId]))).toEqual(
        Object.fromEntries(rows.map((row, i) => [row.votering_id, published[i]![1]])),
      );
    } finally {
      service.dispose();
    }
  });
  it.each([
    'missing-count',
    'wrong-count',
    'duplicate',
    'wrong-iid',
    'wrong-session',
    'wrong-party',
    'echo-iid',
    'echo-session',
  ])('rejects member %s before caching or returning partial data', async (kind) => {
    const rows = memberVoteRows(2);
    if (kind === 'duplicate') rows[1]!.votering_id = rows[0]!.votering_id;
    if (kind === 'wrong-iid') rows[0]!.intressent_id = '0002';
    if (kind === 'wrong-session') rows[0]!.rm = '2025/26';
    if (kind === 'wrong-party') rows[0]!.parti = 'M';
    const network = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        voteringlista: {
          ...(kind === 'missing-count' ? {} : { '@antal': kind === 'wrong-count' ? '3' : '2' }),
          ...(kind.startsWith('echo-')
            ? { '@villkor': kind === 'echo-iid' ? 'iid=0002' : 'rm=2025/26' }
            : {}),
          votering: rows,
        },
      }),
    );
    const service = new RiksdagService({ fetch: network });
    using budget = createToolBudget();
    try {
      for (let i = 0; i < 2; i++)
        await expect(
          loadMemberVotes(service, '2024/25', '0001', 'S', budget),
        ).rejects.toMatchObject({
          data: {
            reason: [
              'wrong-iid',
              'wrong-session',
              'wrong-party',
              'echo-iid',
              'echo-session',
            ].includes(kind)
              ? 'upstream_identity_mismatch'
              : 'upstream_schema_invalid',
          },
        });
      expect(network).toHaveBeenCalledTimes(2);
    } finally {
      service.dispose();
    }
  });
  it('preserves sparse ballot labels without inventing zero counts', async () => {
    const network = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        voteringlista: {
          '@antal': '3',
          '@villkor': 'rm=2024/25:bet=KU1:punkt=4',
          votering: ['Annan', 'Annan', undefined].map((rost, i) => ({
            votering_id: `v${i}`,
            intressent_id: `000${i}`,
            rm: '2024/25',
            beteckning: 'KU1',
            punkt: '4',
            dok_id: 'HC01KU1',
            parti: 'S',
            avser: 'sakfrågan',
            rost,
          })),
        },
      }),
    );
    const service = new RiksdagService({ fetch: network });
    using budget = createToolBudget();
    try {
      const result = await hydrateVotePoint(
        service,
        '2024/25',
        'KU1',
        'HC01KU1',
        { point: 4, decisionType: 'röstning' },
        budget,
      );
      expect(result).toMatchObject({
        rollCallState: 'available',
        parties: [
          {
            party: 'S',
            otherVotes: [{ vote: 'Annan' }],
            avser: 'sakfrågan',
          },
        ],
      });
      expect(result.parties[0]).not.toHaveProperty('no');
      expect(result.parties[0]).not.toHaveProperty('yes');
      expect(result.parties[0]).not.toHaveProperty('abstain');
      expect(result.parties[0]).not.toHaveProperty('absent');
      expect(String(network.mock.calls[0]?.[0])).toBe(
        'https://data.riksdagen.se/voteringlista/?bet=KU1&punkt=4&rm=2024%2F25&sz=50000&utformat=json',
      );
    } finally {
      service.dispose();
    }
  });
  it.each([
    'count',
    'missing-count',
    'duplicate-ballot',
    'negative',
    'decimal',
    'session',
    'report',
    'point',
    'echo',
  ])('rejects point ballot %s without caching invalid data', async (kind) => {
    const row = {
      parti: 'S',
      votering_id: 'v1',
      intressent_id: '0001',
      dok_id: 'HC01KU1',
      rm: kind === 'session' ? '2025/26' : '2024/25',
      beteckning: kind === 'report' ? 'KU2' : 'KU1',
      punkt: kind === 'point' ? '2' : kind === 'negative' ? '-1' : kind === 'decimal' ? '1.5' : '1',
      rost: 'Ja',
    };
    const network = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        voteringlista: {
          ...(kind === 'missing-count'
            ? {}
            : { '@antal': kind === 'count' || kind === 'duplicate-ballot' ? '2' : '1' }),
          ...(kind === 'echo' ? { '@villkor': 'punkt=2' } : {}),
          votering: kind === 'duplicate-ballot' ? [row, row] : row,
        },
      }),
    );
    const service = new RiksdagService({ fetch: network });
    using budget = createToolBudget();
    try {
      for (let i = 0; i < 2; i++)
        await expect(
          hydrateVotePoint(service, '2024/25', 'KU1', 'HC01KU1', { point: 1 }, budget),
        ).rejects.toMatchObject({
          data: {
            reason: ['session', 'report', 'point', 'echo'].includes(kind)
              ? 'upstream_identity_mismatch'
              : 'upstream_schema_invalid',
          },
        });
      expect(network).toHaveBeenCalledTimes(2);
    } finally {
      service.dispose();
    }
  });
  it.each(['acklamation', 'röstning', undefined])(
    'distinguishes empty ballot rows with decision method %s',
    async (decisionType) => {
      const service = new RiksdagService({
        fetch: async () => Response.json({ voteringlista: { '@antal': '0' } }),
      });
      using budget = createToolBudget();
      try {
        const result = await hydrateVotePoint(
          service,
          '2024/25',
          'KU1',
          'HC01KU1',
          { point: 1, decisionType },
          budget,
        );
        expect(result.rollCallState).toBe(
          decisionType === 'acklamation'
            ? 'acclamation'
            : decisionType === 'röstning'
              ? 'not_published'
              : 'unknown',
        );
        expect(result.parties).toEqual([]);
      } finally {
        service.dispose();
      }
    },
  );
  it.each([
    {
      kind: 'type',
      message: 'is a mot document, not a committee report (bet)',
      hint: 'riksdag_get_document with documentId HC01KU1 and sections references',
    },
    {
      kind: 'session',
      message: 'belongs to session 2025/26, not 2024/25',
      hint: 'Retry riksdag_get_votes with session 2025/26 and the same documentId HC01KU1',
    },
    {
      kind: 'report',
      message: 'is report KU2, not KU1',
      hint: 'Pass report or documentId alone',
    },
  ])(
    'rejects a direct report documentId with another $kind as caller input',
    async ({ kind, message, hint }) => {
      const payload = voteReport();
      if (kind === 'type') payload.dokumentstatus.dokument.doktyp = 'mot';
      if (kind === 'session') {
        payload.dokumentstatus.dokument.rm = '2025/26';
        for (const row of payload.dokumentstatus.dokutskottsforslag.utskottsforslag)
          row.rm = '2025/26';
      }
      if (kind === 'report') {
        payload.dokumentstatus.dokument.beteckning = 'KU2';
        for (const row of payload.dokumentstatus.dokutskottsforslag.utskottsforslag)
          row.bet = 'KU2';
      }
      const service = new RiksdagService({ fetch: async () => Response.json(payload) });
      using budget = createToolBudget();
      try {
        const failure = loadVoteReport(service, '2024/25', 'KU1', 'HC01KU1', budget);
        await expect(failure).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringContaining(message),
          data: { reason: 'invalid_filter', recovery: { hint: expect.stringContaining(hint) } },
        });
      } finally {
        service.dispose();
      }
    },
  );
  it.each(['doktyp', 'rm', 'beteckning'] as const)(
    'keeps a status record without published %s an upstream identity mismatch',
    async (field) => {
      const payload = voteReport();
      delete (payload.dokumentstatus.dokument as Partial<typeof payload.dokumentstatus.dokument>)[
        field
      ];
      const service = new RiksdagService({ fetch: async () => Response.json(payload) });
      using budget = createToolBudget();
      try {
        await expect(
          loadVoteReport(service, '2024/25', undefined, 'HC01KU1', budget),
        ).rejects.toMatchObject({ data: { reason: 'upstream_identity_mismatch' } });
      } finally {
        service.dispose();
      }
    },
  );
  it('keeps a resolved report whose status record disagrees an upstream identity mismatch', async () => {
    const service = new RiksdagService({
      fetch: async (request) => {
        const url = new URL(String(request));
        const payload = voteReport();
        payload.dokumentstatus.dokument.beteckning = 'KU2';
        return url.pathname === '/dokumentstatus/HC01KU1.json'
          ? Response.json(payload)
          : reportFetch()(request);
      },
    });
    using budget = createToolBudget();
    try {
      await expect(
        loadVoteReport(service, '2024/25', 'KU1', undefined, budget),
      ).rejects.toMatchObject({ data: { reason: 'upstream_identity_mismatch' } });
    } finally {
      service.dispose();
    }
  });
  it('loads the complete report catalog before selecting or hydrating points', async () => {
    const service = new RiksdagService({ fetch: reportFetch() });
    using budget = createToolBudget();
    try {
      const result = await loadVoteReport(service, '2024/25', 'KU1', undefined, budget);
      expect(result).toMatchObject({
        found: true,
        documentId: 'HC01KU1',
        decisions: [{ point: 1 }, { point: 2 }, { point: 3 }, { point: 4 }],
      });
    } finally {
      service.dispose();
    }
  });
});
