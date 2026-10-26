/** @fileoverview Complete ballot identity and disambiguated party counts. @module tests/services/riksdag/point-ballots */
import { describe, expect, it } from 'vitest';
import { RiksdagService } from '@/services/riksdag/riksdag-service.js';
import { createToolBudget } from '@/services/riksdag/transport.js';
import { hydrateVotePoint, loadMemberVotes } from '@/services/riksdag/votes.js';

const ballot = (avser: string, rost = 'Ja') => ({
  votering_id: 'v1',
  intressent_id: '0001',
  rm: '2024/25',
  beteckning: 'KU1',
  punkt: '1',
  dok_id: 'HC01KU1',
  parti: 'S',
  avser,
  rost,
});

describe('complete ballot records', () => {
  it('uses published ballots for availability without inventing a party or subject', async () => {
    const source = { ...ballot('sakfrågan'), parti: undefined, avser: undefined };
    const service = new RiksdagService({
      fetch: async () => Response.json({ voteringlista: { '@antal': '1', votering: source } }),
    });
    using budget = createToolBudget();
    try {
      const result = await hydrateVotePoint(
        service,
        '2024/25',
        'KU1',
        'HC01KU1',
        { point: 1, decisionType: 'röstning' },
        budget,
      );
      expect(result).toMatchObject({ rollCallState: 'available', parties: [] });
    } finally {
      service.dispose();
    }
  });
  it('keeps complete substantive and motivation totals separate across every ballot', async () => {
    const selections = [
      ['sakfrågan', [190, 127, 0, 32]],
      ['motivfrågan', [139, 62, 116, 32]],
    ] as const;
    const rows = selections.flatMap(([avser, counts]) =>
      counts.flatMap((count, label) =>
        Array.from({ length: count }, (_, index) => ({
          ...ballot(avser, ['Ja', 'Nej', 'Avstår', 'Frånvarande'][label]),
          intressent_id: `0${label}${String(index).padStart(3, '0')}`,
        })),
      ),
    );
    const service = new RiksdagService({
      fetch: async () => Response.json({ voteringlista: { '@antal': '698', votering: rows } }),
    });
    using budget = createToolBudget();
    try {
      const result = await hydrateVotePoint(
        service,
        '2024/25',
        'KU1',
        'HC01KU1',
        { point: 1 },
        budget,
      );
      expect(result.parties).toEqual([
        {
          party: 'S',
          avser: 'sakfrågan',
          yes: 190,
          no: 127,
          abstain: 0,
          absent: 32,
          otherVotes: [],
        },
        {
          party: 'S',
          avser: 'motivfrågan',
          yes: 139,
          no: 62,
          abstain: 116,
          absent: 32,
          otherVotes: [],
        },
      ]);
    } finally {
      service.dispose();
    }
  });
  it('characterizes positive points and published date precision', async () => {
    const service = new RiksdagService({
      fetch: async () =>
        Response.json({
          voteringlista: {
            '@antal': '1',
            votering: {
              ...ballot('sakfrågan'),
              datum: '2025-01-02',
              systemdatum: '2025-01-02 12:00:00',
            },
          },
        }),
    });
    using budget = createToolBudget();
    try {
      expect(
        (await loadMemberVotes(service, '2024/25', '0001', undefined, budget)).rows[0],
      ).toMatchObject({ point: 1, date: '2025-01-02', systemDate: '2025-01-02 12:00:00' });
    } finally {
      service.dispose();
    }
  });
  it('omits source point zero without dropping its linked document', async () => {
    const service = new RiksdagService({
      fetch: async () =>
        Response.json({
          voteringlista: { '@antal': '1', votering: { ...ballot('frågan'), punkt: '0' } },
        }),
    });
    using budget = createToolBudget();
    try {
      const row = (await loadMemberVotes(service, '2024/25', '0001', undefined, budget)).rows[0];
      expect(row).toMatchObject({ documentId: 'HC01KU1', report: 'KU1' });
      expect(row?.point).toBeUndefined();
    } finally {
      service.dispose();
    }
  });
  it('keeps shared vote/member IDs for distinct avser and counts each subject separately', async () => {
    const rows = [ballot('sakfrågan'), ballot('motivfrågan', 'Nej')];
    const service = new RiksdagService({
      fetch: async () => Response.json({ voteringlista: { '@antal': '2', votering: rows } }),
    });
    using budget = createToolBudget();
    try {
      expect(
        (await loadMemberVotes(service, '2024/25', '0001', undefined, budget)).rows.map(
          (row) => row.avser,
        ),
      ).toEqual(['sakfrågan', 'motivfrågan']);
      expect(
        (await hydrateVotePoint(service, '2024/25', 'KU1', 'HC01KU1', { point: 1 }, budget))
          .parties,
      ).toEqual([
        { party: 'S', avser: 'sakfrågan', yes: 1, no: 0, abstain: 0, absent: 0, otherVotes: [] },
        { party: 'S', avser: 'motivfrågan', yes: 0, no: 1, abstain: 0, absent: 0, otherVotes: [] },
      ]);
    } finally {
      service.dispose();
    }
  });
});
