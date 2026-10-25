/** @fileoverview Complete register parsing, sparse identity and assignment invariants. @module tests/services/riksdag/members */
import { describe, expect, it, vi } from 'vitest';
import { loadMembers } from '@/services/riksdag/members.js';
import { RiksdagService } from '@/services/riksdag/riksdag-service.js';
import { createToolBudget } from '@/services/riksdag/transport.js';
import { memberDetail } from './member-fixtures.js';

describe('member register endpoint', () => {
  it('preserves leading-zero IID, source UUID and assignment source order/date precision', async () => {
    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ personlista: { '@hits': '1', person: memberDetail() } }),
      );
    const service = new RiksdagService({ fetch: network });
    using budget = createToolBudget();
    try {
      const result = await loadMembers(service, budget, { memberId: '0001' });
      expect(result.records[0]).toMatchObject({
        memberId: '0001',
        sourceRecordId: 'synthetic-1',
        detailAvailable: true,
        serviceClassification: 'not_serving',
      });
      expect(result.records[0]?.assignments).toEqual([
        {
          organ: 'ORG3',
          role: 'Roll 1',
          status: 'Publicerad',
          type: 'uppdrag',
          from: '2020-01-01 12:00:00',
          to: '2099-12-31',
          descriptions: ['Beskrivning 1', 'Detalj 1'],
        },
        {
          organ: 'ORG2',
          role: 'Roll 2',
          status: 'Publicerad',
          type: 'uppdrag',
          from: '2020-01-02 12:00:00',
          to: '2099-12-31',
          descriptions: ['Beskrivning 2', 'Detalj 2'],
        },
        {
          organ: 'ORG1',
          role: 'Roll 3',
          status: 'Publicerad',
          type: 'uppdrag',
          from: '2020-01-03 12:00:00',
          to: '2099-12-31',
          descriptions: ['Beskrivning 3', 'Detalj 3'],
        },
      ]);
      expect(String(network.mock.calls[0]?.[0])).toBe(
        'https://data.riksdagen.se/personlista/?iid=0001&rdlstatus=tjanst&utformat=json',
      );
    } finally {
      service.dispose();
    }
  });
  it.each(['missing-assignment', 'empty-wrapper', 'singleton-assignment', 'empty-description'])(
    'normalizes sparse %s collections',
    async (shape) => {
      const person = {
        intressent_id: '0001',
        ...(shape === 'missing-assignment'
          ? {}
          : {
              personuppdrag:
                shape === 'empty-wrapper'
                  ? {}
                  : {
                      uppdrag:
                        shape === 'singleton-assignment'
                          ? { organ_kod: 'KU', uppgift: 'Synthetic description' }
                          : { uppgift: {} },
                    },
            }),
      };
      const service = new RiksdagService({
        fetch: async () => Response.json({ personlista: { '@hits': '1', person } }),
      });
      using budget = createToolBudget();
      try {
        const result = await loadMembers(service, budget);
        expect(result.records[0]?.assignments).toMatchObject(
          shape === 'missing-assignment' || shape === 'empty-wrapper'
            ? []
            : [{ descriptions: shape === 'singleton-assignment' ? ['Synthetic description'] : [] }],
        );
      } finally {
        service.dispose();
      }
    },
  );
  it('accepts omitted person rows only for an authoritative empty register', async () => {
    const service = new RiksdagService({
      fetch: async () => Response.json({ personlista: { '@hits': '0' } }),
    });
    using budget = createToolBudget();
    try {
      await expect(loadMembers(service, budget)).resolves.toMatchObject({ records: [] });
    } finally {
      service.dispose();
    }
  });
  it('retains source identity when no IID exists without inventing a detail target', async () => {
    const service = new RiksdagService({
      fetch: async () =>
        Response.json({
          personlista: {
            '@hits': '1',
            person: {
              intressent_id: '',
              sourceid: 'synthetic-european-record',
              status: 'Europaparlamentariker',
            },
          },
        }),
    });
    using budget = createToolBudget();
    try {
      const result = await loadMembers(service, budget);
      expect(result.records[0]).toMatchObject({
        memberId: undefined,
        sourceRecordId: 'synthetic-european-record',
        detailAvailable: false,
        serviceClassification: 'not_serving',
        sourceUrl: 'https://data.riksdagen.se/person/synthetic-european-record',
      });
    } finally {
      service.dispose();
    }
  });
  it.each([
    'Tjänstgörande riksdagsledamot',
    'Andre vice talman (tjänstgörande riksdagsledamot)',
    'Tidigare ersättare',
    'Tidigare riksdagsledamot',
    'Tillgänglig ersättare',
    'Tidigare statsråd',
    'Europaparlamentariker',
    'Tidigare europaparlamentariker',
    'Statsråd',
    'Okänd källa',
    '',
  ])('classifies source status %s conservatively', async (status) => {
    const service = new RiksdagService({
      fetch: async () =>
        Response.json({ personlista: { '@hits': '1', person: { intressent_id: '1', status } } }),
    });
    using budget = createToolBudget();
    const expected =
      status === 'Tjänstgörande riksdagsledamot' || status.startsWith('Andre vice')
        ? 'serving'
        : ['Statsråd', 'Okänd källa', ''].includes(status)
          ? 'unknown'
          : 'not_serving';
    try {
      const result = await loadMembers(service, budget);
      expect(result.records[0]?.serviceClassification).toBe(expected);
    } finally {
      service.dispose();
    }
  });
  it.each([
    'count-mismatch',
    'missing-wrapper',
    'missing-count',
    'duplicate-iid',
    'duplicate-source',
    'neither-id',
    'wrong-party',
    'wrong-iid',
    'assignment-iid',
    'multiple-detail',
  ])('rejects %s and does not cache the bad register', async (kind) => {
    let payload: unknown = {
      personlista: { '@hits': '1', person: { intressent_id: '0001', parti: 'S' } },
    };
    if (kind === 'count-mismatch')
      payload = { personlista: { '@hits': '2', person: { intressent_id: '0001' } } };
    if (kind === 'missing-wrapper') payload = {};
    if (kind === 'missing-count') payload = { personlista: { person: { intressent_id: '0001' } } };
    if (kind === 'duplicate-iid')
      payload = {
        personlista: {
          '@hits': '2',
          person: [{ intressent_id: '0001' }, { intressent_id: '0001' }],
        },
      };
    if (kind === 'duplicate-source')
      payload = {
        personlista: { '@hits': '2', person: [{ sourceid: 'same' }, { sourceid: 'same' }] },
      };
    if (kind === 'neither-id') payload = { personlista: { '@hits': '1', person: {} } };
    if (kind === 'assignment-iid')
      payload = {
        personlista: {
          '@hits': '1',
          person: { intressent_id: '0001', personuppdrag: { uppdrag: { intressent_id: '0002' } } },
        },
      };
    if (kind === 'multiple-detail')
      payload = {
        personlista: {
          '@hits': '2',
          person: [{ intressent_id: '0001' }, { intressent_id: '0002' }],
        },
      };
    const network = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(payload));
    const service = new RiksdagService({ fetch: network });
    const filters =
      kind === 'wrong-party'
        ? { party: 'M' }
        : kind === 'wrong-iid'
          ? { memberId: '0002' }
          : kind === 'multiple-detail'
            ? { memberId: '0001' }
            : {};
    using budget = createToolBudget();
    try {
      for (let i = 0; i < 2; i++)
        await expect(loadMembers(service, budget, filters)).rejects.toMatchObject({
          data: {
            reason: ['wrong-party', 'wrong-iid', 'assignment-iid', 'multiple-detail'].includes(kind)
              ? 'upstream_identity_mismatch'
              : 'upstream_schema_invalid',
          },
        });
      expect(network).toHaveBeenCalledTimes(2);
    } finally {
      service.dispose();
    }
  });
});
