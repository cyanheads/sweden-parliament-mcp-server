/** @fileoverview Endpoint parsing and exact report resolution through injected Fetch. @module tests/services/riksdag/documents */
import { describe, expect, it, vi } from 'vitest';
import {
  loadDocumentStatus,
  resolveReport,
  searchDocuments,
} from '@/services/riksdag/documents.js';
import { RiksdagService } from '@/services/riksdag/riksdag-service.js';
import { createToolBudget } from '@/services/riksdag/transport.js';
import { reportFixture } from './document-fixtures.js';

describe('document endpoint contracts', () => {
  it('normalizes missing and singleton status children without fabricating values', async () => {
    const network = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        dokumentstatus: {
          dokument: { dok_id: 'HC01KU1' },
          dokaktivitet: { aktivitet: { kod: 'A' } },
          dokmotforslag: null,
          dokbilaga: { bilaga: null },
        },
      }),
    );
    const service = new RiksdagService({ fetch: network });
    using budget = createToolBudget();
    try {
      const result = await loadDocumentStatus(service, 'HC01KU1', budget);
      expect(result).toMatchObject({
        found: true,
        record: {
          decisions: [],
          reservations: [],
          activities: [{ code: 'A' }],
          properties: [],
          attachments: [],
          references: [],
        },
      });
      if (!result.found) throw new Error('Expected synthetic report.');
      expect(result.record.text).toBeUndefined();
      expect(result.record.metadata.publicationStatus).toBeUndefined();
      expect(result.record.metadata.chamberStatus).toBeUndefined();
    } finally {
      service.dispose();
    }
  });
  it.each([{ doktyp: 'mot' }, { rm: '2025/26' }, { organ: 'FiU' }])(
    'rejects search filter contradictions %j',
    async (contradiction) => {
      const service = new RiksdagService({
        fetch: async () =>
          Response.json({
            dokumentlista: {
              dokument: {
                dok_id: 'HC01KU1',
                doktyp: 'bet',
                rm: '2024/25',
                organ: 'KU',
                ...contradiction,
              },
            },
          }),
      });
      using budget = createToolBudget();
      try {
        await expect(
          searchDocuments(
            service,
            { page: 1, pageSize: 10, documentType: 'bet', session: '2024/25', committee: 'KU' },
            budget,
          ),
        ).rejects.toMatchObject({ data: { reason: 'upstream_identity_mismatch' } });
      } finally {
        service.dispose();
      }
    },
  );
  it('finds an exact report on a later page despite broad nonmatching rows and hit counts', async () => {
    const network = vi.fn<typeof fetch>().mockImplementation(async (request) => {
      const url = new URL(String(request));
      if (url.pathname !== '/dokumentlista/') return Response.json(reportFixture());
      return Response.json({
        dokumentlista:
          url.searchParams.get('p') === '1'
            ? {
                '@traffar': '6',
                '@nasta_sida': 'https://data.riksdagen.se/dokumentlista/?p=2',
                dokument: [
                  { dok_id: 'HC01KU2', doktyp: 'bet', rm: '2024/25', beteckning: 'KU2' },
                  { dok_id: 'HC01KU3', doktyp: 'mot', rm: '2024/25', beteckning: 'KU1' },
                ],
              }
            : {
                '@traffar': '6',
                dokument: { dok_id: 'HC01KU1', doktyp: 'bet', rm: '2024/25', beteckning: 'KU1' },
              },
      });
    });
    const service = new RiksdagService({ fetch: network });
    using budget = createToolBudget();
    try {
      await expect(resolveReport(service, '2024/25', 'KU1', budget)).resolves.toMatchObject({
        found: true,
        documentId: 'HC01KU1',
      });
      expect(network).toHaveBeenCalledTimes(3);
      const second = new URL(String(network.mock.calls[1]?.[0]));
      expect(Object.fromEntries(second.searchParams)).toEqual({
        bet: 'KU1',
        doktyp: 'bet',
        p: '2',
        rm: '2024/25',
        sz: '2',
        utformat: 'json',
      });
    } finally {
      service.dispose();
    }
  });
  it('normalizes every nested collection and retains publication and chamber state separately', async () => {
    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(reportFixture()));
    const service = new RiksdagService({ fetch: network });
    using budget = createToolBudget();
    try {
      const result = await loadDocumentStatus(service, 'hc01ku1', budget);
      expect(result.found).toBe(true);
      if (!result.found) throw new Error('Expected synthetic report.');
      expect(result.record.metadata).toMatchObject({
        documentId: 'HC01KU1',
        publicationStatus: 'Publicerad',
        chamberStatus: 'Avgjort',
        sourceUrl: 'https://data.riksdagen.se/dokument/HC01KU1',
        sourceTextUrl: 'https://data.riksdagen.se/dokument/HC01KU1.text',
        publishedAt: '2025-01-02 12:00:00',
      });
      expect(result.record.decisions[2]).toMatchObject({
        point: 3,
        heading: 'Punkt 3',
        proposal: '<p>Förslag 3</p>',
        decisionType: 'röstning',
        voteId: 'vote-3',
        winner: 'utskottet',
        session: '2024/25',
        report: 'KU1',
        sourceUrl: 'https://data.riksdagen.se/votering/3',
      });
      expect(result.record.reservations[2]).toEqual({
        number: '3',
        heading: 'Reservation 3',
        parties: 'S, M',
        type: 'reservation',
        point: '3',
      });
      expect(result.record.activities[2]).toEqual({
        code: 'A3',
        name: 'Händelse 3',
        date: '2025-01-02 12:00',
        status: 'publicerad',
        process: 'beredning',
      });
      expect(result.record.properties[2]).toEqual({
        code: 'P3',
        name: 'Egenskap 3',
        text: 'Värde 3',
      });
      expect(result.record.attachments[2]).toMatchObject({
        title: 'Bilaga 3',
        filename: 'synthetic-3.pdf',
        type: 'pdf',
        sizeBytes: '00042',
        sourceUrl: 'https://example.test/attachment-3.pdf',
      });
      expect(result.record.references[2]).toEqual({
        relationship: 'behandlar',
        description: 'Källrelation',
        documentId: 'HC02MOT3',
        documentType: 'mot',
        session: '2024/25',
        designation: '3',
        title: 'Motion 3',
        subtitle: 'Underrubrik',
      });
      expect(result.record.text).toBe('# Rubrik 😀\n\nFörsta stycket.\n\nAndra stycket.');
      expect(network).toHaveBeenCalledTimes(1);
    } finally {
      service.dispose();
    }
  });
  it.each([
    'wrong-id',
    'duplicate-point',
    'wrong-session',
    'wrong-report',
    'missing-wrapper',
    'primitive-child',
  ])('rejects malformed status %s before caching', async (kind) => {
    const fixture = reportFixture();
    let payload: unknown = fixture;
    if (kind === 'wrong-id') fixture.dokumentstatus.dokument.dok_id = 'HC01KU2';
    if (kind === 'duplicate-point')
      fixture.dokumentstatus.dokutskottsforslag.utskottsforslag[1]!.punkt = '1';
    if (kind === 'wrong-session')
      fixture.dokumentstatus.dokutskottsforslag.utskottsforslag[0]!.rm = '2025/26';
    if (kind === 'wrong-report')
      fixture.dokumentstatus.dokutskottsforslag.utskottsforslag[0]!.bet = 'KU2';
    if (kind === 'missing-wrapper') payload = {};
    if (kind === 'primitive-child')
      payload = {
        dokumentstatus: { dokument: { dok_id: 'HC01KU1' }, dokaktivitet: { aktivitet: 'bad' } },
      };
    const network = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(payload));
    const service = new RiksdagService({ fetch: network });
    using budget = createToolBudget();
    try {
      for (let i = 0; i < 2; i++)
        await expect(loadDocumentStatus(service, 'HC01KU1', budget)).rejects.toMatchObject({
          data: {
            reason: ['wrong-id', 'wrong-session', 'wrong-report'].includes(kind)
              ? 'upstream_identity_mismatch'
              : 'upstream_schema_invalid',
          },
        });
      expect(network).toHaveBeenCalledTimes(2);
    } finally {
      service.dispose();
    }
  });
  it.each([
    { '@sida': '2', dokument: [] },
    { '@traffar': '2', dokument: [{ dok_id: 'HC01KU1' }] },
    { dokument: [{ dok_id: 'HC01KU1' }, { dok_id: 'hc01ku1' }] },
    { '@nasta_sida': 'https://example.test/dokumentlista/?p=2', dokument: [] },
  ])('rejects inconsistent search page identities', async (root) => {
    const service = new RiksdagService({
      fetch: async () => Response.json({ dokumentlista: root }),
    });
    using budget = createToolBudget();
    try {
      await expect(
        searchDocuments(service, { page: 1, pageSize: 2 }, budget),
      ).rejects.toMatchObject({
        data: { reason: expect.stringMatching(/upstream_(schema_invalid|identity_mismatch)/) },
      });
    } finally {
      service.dispose();
    }
  });
  it('resolves a single exact report with a fixed allowlist and fetches complete decisions', async () => {
    const network = vi.fn<typeof fetch>().mockImplementation(async (request) =>
      new URL(String(request)).pathname === '/dokumentlista/'
        ? Response.json({
            dokumentlista: {
              '@traffar': '1',
              dokument: { dok_id: 'HC01KU1', doktyp: 'bet', rm: '2024/25', beteckning: 'KU1' },
            },
          })
        : Response.json(reportFixture()),
    );
    const service = new RiksdagService({ fetch: network });
    using budget = createToolBudget();
    try {
      const result = await resolveReport(service, '2024/25', '2024/25:ku1', budget);
      expect(result).toMatchObject({
        found: true,
        documentId: 'HC01KU1',
        record: { decisions: [{ point: 1 }, { point: 2 }, { point: 3 }] },
      });
      expect(String(network.mock.calls[0]?.[0])).toBe(
        'https://data.riksdagen.se/dokumentlista/?bet=KU1&doktyp=bet&p=1&rm=2024%2F25&sz=2&utformat=json',
      );
      expect(String(network.mock.calls[1]?.[0])).toBe(
        'https://data.riksdagen.se/dokumentstatus/HC01KU1.json',
      );
    } finally {
      service.dispose();
    }
  });
  it('returns a report miss and distinguishes ambiguous exact identities', async () => {
    for (const count of [0, 2]) {
      const service = new RiksdagService({
        fetch: async () =>
          Response.json({
            dokumentlista: {
              '@traffar': String(count),
              dokument: Array.from({ length: count }, (_, i) => ({
                dok_id: `HC01KU${i + 1}`,
                doktyp: 'bet',
                rm: '2024/25',
                beteckning: 'KU1',
              })),
            },
          }),
      });
      using budget = createToolBudget();
      try {
        if (count === 0)
          await expect(resolveReport(service, '2024/25', 'KU1', budget)).resolves.toMatchObject({
            found: false,
            documentId: '2024/25:KU1',
          });
        else
          await expect(resolveReport(service, '2024/25', 'KU1', budget)).rejects.toMatchObject({
            data: { reason: 'ambiguous_report' },
          });
      } finally {
        service.dispose();
      }
    }
  });
  it('traverses report resolution continuation before declaring a unique report ambiguous', async () => {
    const network = vi.fn<typeof fetch>().mockImplementation(async (request) => {
      const url = new URL(String(request));
      if (url.pathname !== '/dokumentlista/') return Response.json(reportFixture());
      return Response.json({
        dokumentlista:
          url.searchParams.get('p') === '1'
            ? {
                '@nasta_sida': 'https://data.riksdagen.se/dokumentlista/?p=2',
                dokument: { dok_id: 'HC01KU1', doktyp: 'bet', rm: '2024/25', beteckning: 'KU1' },
              }
            : { dokument: [] },
      });
    });
    const service = new RiksdagService({ fetch: network });
    using budget = createToolBudget();
    try {
      await expect(resolveReport(service, '2024/25', 'KU1', budget)).resolves.toMatchObject({
        found: true,
        documentId: 'HC01KU1',
      });
      expect(network).toHaveBeenCalledTimes(3);
    } finally {
      service.dispose();
    }
  });
});
