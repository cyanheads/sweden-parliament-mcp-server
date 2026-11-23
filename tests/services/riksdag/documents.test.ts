/** @fileoverview Endpoint parsing and exact report resolution through injected Fetch. @module tests/services/riksdag/documents */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadDocumentStatus,
  resolveReport,
  searchDocuments,
} from '@/services/riksdag/documents.js';
import { RiksdagService } from '@/services/riksdag/riksdag-service.js';
import { htmlToMarkdown } from '@/services/riksdag/text.js';
import { createToolBudget } from '@/services/riksdag/transport.js';
import { loadVoteReport } from '@/services/riksdag/votes.js';
import { convertedReport, convertedReportRevision, reportFixture } from './document-fixtures.js';

/** Counts converter calls below the service cache; every call still runs the real converter. */
vi.mock('@/services/riksdag/text.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/riksdag/text.js')>();
  return { ...actual, htmlToMarkdown: vi.fn(actual.htmlToMarkdown) };
});
const converter = vi.mocked(htmlToMarkdown);
const { htmlToMarkdown: convert } = await vi.importActual<
  typeof import('@/services/riksdag/text.js')
>('@/services/riksdag/text.js');

describe('status conversions memoized with the cached record', () => {
  /** Serves `convertedReport` bodies by document ID; `bodies` overrides a record's HTML. */
  function statusSource(bodies = new Map<string, string>()) {
    return vi.fn<typeof fetch>().mockImplementation(async (request) => {
      const id = /\/dokumentstatus\/(.+)\.json$/.exec(new URL(String(request)).pathname)?.[1];
      if (!id) throw new Error(`Unexpected synthetic route ${String(request)}`);
      return Response.json(convertedReport(id, bodies.get(id)));
    });
  }
  async function load(service: RiksdagService, id = 'HC01KU1', signal?: AbortSignal) {
    using budget = createToolBudget(signal);
    const result = await loadDocumentStatus(service, id, budget);
    if (!result.found) throw new Error('Expected a synthetic record.');
    return result;
  }
  const services: RiksdagService[] = [];
  function service(network: typeof fetch) {
    const created = new RiksdagService({ fetch: network });
    services.push(created);
    return created;
  }
  /** Results from different services differ only in their per-fetch source time. */
  function withoutFetchTime<T extends { retrievedAt: string }>({ retrievedAt: _, ...rest }: T) {
    return rest;
  }
  beforeEach(() => {
    converter.mockClear();
  });
  afterEach(() => {
    for (const created of services.splice(0)) created.dispose();
    converter.mockImplementation(convert);
    vi.useRealTimers();
  });

  it('converts a record once and returns identical results on warm calls', async () => {
    const network = statusSource();
    const cached = service(network);
    const cold = await load(cached);
    // One body, two proposals and one notice property.
    expect(converter).toHaveBeenCalledTimes(4);
    expect(cold.record.revision).toBe(convertedReportRevision);
    for (let i = 0; i < 3; i++) expect(await load(cached, 'hc01ku1')).toEqual(cold);
    expect(converter).toHaveBeenCalledTimes(4);
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('serves riksdag_get_votes report loads from the same memo with an unchanged revision', async () => {
    const cached = service(statusSource());
    const fresh = service(statusSource());
    using budget = createToolBudget();
    const expected = await loadVoteReport(fresh, '2024/25', undefined, 'HC01KU1', budget);
    converter.mockClear();
    await load(cached);
    expect(converter).toHaveBeenCalledTimes(4);
    const primed = await loadVoteReport(cached, '2024/25', undefined, 'HC01KU1', budget);
    const repeated = await loadVoteReport(cached, '2024/25', undefined, 'HC01KU1', budget);
    expect(converter).toHaveBeenCalledTimes(4);
    expect(repeated).toEqual(primed);
    expect(withoutFetchTime(primed)).toEqual(withoutFetchTime(expected));
  });
  it('returns the same record on a fresh service and after priming calls on other records', async () => {
    const bodies = new Map([['HC01KU2', '<h2>Annan</h2><p>Helt <em>annan</em> text.</p>']]);
    const primed = service(statusSource(bodies));
    await load(primed, 'HC01KU2');
    const cold = await load(primed);
    await load(primed, 'HC01KU2');
    const warm = await load(primed);
    const fresh = withoutFetchTime(await load(service(statusSource(bodies))));
    expect(withoutFetchTime(cold)).toEqual(fresh);
    expect(withoutFetchTime(warm)).toEqual(fresh);
    expect(fresh.record.revision).toBe(convertedReportRevision);
    expect((await load(primed, 'HC01KU2')).record.text).toBe('## Annan\n\nHelt _annan_ text.');
  });
  it('converts changed HTML afresh after the TTL and rejects the prior revision', async () => {
    vi.useFakeTimers();
    const bodies = new Map([['HC01KU1', '<p>Före</p>']]);
    const network = statusSource(bodies);
    const cached = service(network);
    const before = await load(cached);
    vi.advanceTimersByTime(300000);
    bodies.set('HC01KU1', '<p>Efter</p>');
    converter.mockClear();
    const after = await load(cached);
    expect(network).toHaveBeenCalledTimes(2);
    expect(converter.mock.calls.map(([html]) => html)).toContain('<p>Efter</p>');
    expect(after.record.text).toBe('Efter');
    expect(after.record.revision).not.toBe(before.record.revision);
  });
  it('converts changed HTML afresh after eviction', async () => {
    const bodies = new Map([['HC01KU1', '<p>Före</p>']]);
    const network = statusSource(bodies);
    const cached = service(network);
    expect((await load(cached)).record.text).toBe('Före');
    for (let i = 2; i <= 65; i++) await load(cached, `HC01KU${i}`);
    bodies.set('HC01KU1', '<p>Efter</p>');
    expect((await load(cached)).record.text).toBe('Efter');
    expect(network).toHaveBeenCalledTimes(66);
  });
  it('leaves a complete memo when the caller cancels during conversion', async () => {
    const body = convertedReport().dokumentstatus.dokument.html;
    const cached = service(statusSource());
    const controller = new AbortController();
    converter.mockImplementation((html) => {
      if (html === body) controller.abort();
      return convert(html);
    });
    await expect(load(cached, 'HC01KU1', controller.signal)).rejects.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
    });
    expect(converter).toHaveBeenCalledTimes(4);
    const next = await load(cached);
    expect(converter).toHaveBeenCalledTimes(4);
    const fresh = await load(service(statusSource()));
    expect(withoutFetchTime(next)).toEqual(withoutFetchTime(fresh));
  });
  it('never converts SFS HTML, whose published text is returned instead', async () => {
    const html = '<p>Lagtext i <b>HTML</b></p>';
    const network = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        dokumentstatus: {
          dokument: { dok_id: 'sfs-2000-100', doktyp: 'sfs', html, text: 'Lagtext\r\n1 §' },
        },
      }),
    );
    const result = await load(service(network), 'sfs-2000-100');
    expect(result.record.text).toBe('Lagtext\r\n1 §');
    expect(converter.mock.calls.map(([source]) => source)).not.toContain(html);
  });
  it('aligns each converted proposal with its own decision point', async () => {
    const report = convertedReport();
    const points = report.dokumentstatus.dokutskottsforslag.utskottsforslag.map(
      ({ forslag: _, ...point }, i) => (i === 0 ? point : { ...point, forslag: '<p>B</p>' }),
    );
    const network = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        dokumentstatus: {
          ...report.dokumentstatus,
          dokutskottsforslag: { utskottsforslag: points },
        },
      }),
    );
    const { decisions } = (await load(service(network))).record;
    expect(decisions.map(({ point, proposal }) => [point, proposal])).toEqual([
      [1, undefined],
      [2, 'B'],
    ]);
  });
});

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
        proposal: 'Förslag 3',
        proposalSourceHtml: '<p>Förslag 3</p>',
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
  describe('member-profile rows in search pages', () => {
    const profile = { database: 'ledamot', dok_id: '', doktyp: '', rm: '', titel: 'Syntetisk (L)' };
    const row = (i: number) => ({ database: 'dokument', dok_id: `HD02${i}`, doktyp: 'mot' });
    async function search(root: Record<string, unknown>, pageSize = 10) {
      const service = new RiksdagService({
        fetch: async () => Response.json({ dokumentlista: root }),
      });
      using budget = createToolBudget();
      try {
        return await searchDocuments(service, { page: 1, pageSize, query: 'klimat' }, budget);
      } finally {
        service.dispose();
      }
    }
    it('skips them, keeps source order and counts them apart from documents', async () => {
      const result = await search({
        '@traffar': '22581',
        dokument: [row(1), profile, row(2), profile, ...[3, 4, 5, 6, 7, 8].map(row)],
      });
      expect(result).toMatchObject({ returnedCount: 8, totalCount: 22581, hasMore: true });
      expect(result.skippedMemberRows).toBe(2);
      expect(result.items.map((item) => item.documentId)).toEqual(
        [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `HD02${i}`),
      );
    });
    it('reads a singleton member-profile row as an empty document page', async () => {
      const result = await search({ '@traffar': '1', dokument: profile });
      expect(result).toMatchObject({ items: [], returnedCount: 0, hasMore: false });
      expect(result.skippedMemberRows).toBe(1);
    });
    it('reports zero skipped rows on a page without them', async () => {
      const result = await search({ '@traffar': '2', dokument: [row(1), row(2)] });
      expect(result.skippedMemberRows).toBe(0);
    });
    it.each([
      { name: 'a document row', blank: { database: 'dokument', dok_id: '' } },
      { name: 'a row without database', blank: { dok_id: '' } },
      { name: 'a whitespace identity', blank: { database: 'alla', dok_id: ' ' } },
      { name: 'a calendar row', blank: { database: 'kalender', dok_id: ' ' } },
    ])('still rejects $name with a blank document ID', async ({ blank }) => {
      await expect(
        search({ '@traffar': '3', dokument: [row(1), profile, blank] }),
      ).rejects.toMatchObject({ data: { reason: 'upstream_schema_invalid' } });
    });
    it('checks the page length against raw rows, member profiles included', async () => {
      await expect(
        search({
          '@traffar': '10',
          dokument: [row(1), profile, profile, ...[2, 3, 4, 5, 6, 7].map(row)],
        }),
      ).rejects.toMatchObject({
        message: 'Document search page length contradicts the published hit count.',
        data: { reason: 'upstream_schema_invalid' },
      });
      const full = await search({
        '@traffar': '10',
        dokument: [row(1), profile, profile, ...[2, 3, 4, 5, 6, 7, 8].map(row)],
      });
      expect(full).toMatchObject({ returnedCount: 8, skippedMemberRows: 2, hasMore: false });
    });
    it('still rejects duplicate document IDs beside member profiles', async () => {
      await expect(
        search({ '@traffar': '4', dokument: [row(1), profile, profile, row(1)] }),
      ).rejects.toMatchObject({
        message: 'Document search returned duplicate document IDs.',
        data: { reason: 'upstream_schema_invalid' },
      });
    });
    it('still rejects one record listed twice by two numbered hits outside the calendar', async () => {
      await expect(
        search({
          '@traffar': '2',
          dokument: [
            { ...row(1), traff: '1' },
            { ...row(1), traff: '2' },
          ],
        }),
      ).rejects.toMatchObject({
        message: 'Document search returned duplicate document IDs.',
        data: { reason: 'upstream_schema_invalid' },
      });
    });
    it('skips a member-profile row during exact report resolution', async () => {
      const network = vi.fn<typeof fetch>().mockImplementation(async (request) =>
        new URL(String(request)).pathname === '/dokumentlista/'
          ? Response.json({
              dokumentlista: {
                '@traffar': '2',
                dokument: [
                  profile,
                  { dok_id: 'HC01KU1', doktyp: 'bet', rm: '2024/25', beteckning: 'KU1' },
                ],
              },
            })
          : Response.json(reportFixture()),
      );
      const service = new RiksdagService({ fetch: network });
      using budget = createToolBudget();
      try {
        await expect(resolveReport(service, '2024/25', 'KU1', budget)).resolves.toMatchObject({
          found: true,
          documentId: 'HC01KU1',
        });
      } finally {
        service.dispose();
      }
    });
  });
  /**
   * Row shapes of the source's unfiltered and session listings: it numbers hits (`traff`), repeats a
   * recurring calendar event once per occurrence date under one hit, lists some records again as a
   * calendar entry under a second hit, and mixes in web pages and per-occurrence calendar rows.
   */
  describe('calendar and web-page rows in search pages', () => {
    const record = (id: string, traff: number) => ({
      database: 'dokument',
      dok_id: id,
      doktyp: 'utskottsmöte',
      rm: '2025/26',
      beteckning: id.slice(4),
      datum: '2026-10-20 11:00:00',
      dokument_url_html: `//data.riksdagen.se/dokument/${id}.htm`,
      traff: String(traff),
    });
    const calendar = (id: string, traff: number, datum: string) => ({
      database: 'kalender',
      dok_id: id,
      doktyp: 'kal-vi',
      rm: '2025/26',
      beteckning: '',
      datum,
      dokument_url_html: null,
      traff: String(traff),
    });
    const webPage = (traff: number, titel: string) => ({
      database: 'episerver',
      dok_id: '515a17de-c53e-4f2f-9372-077d1e6b3e7e',
      doktyp: '',
      typ: '',
      titel,
      traff: String(traff),
    });
    async function search(dokument: unknown[], traffar: number, input = { page: 1, pageSize: 10 }) {
      const service = new RiksdagService({
        fetch: async () =>
          Response.json({ dokumentlista: { '@traffar': String(traffar), dokument } }),
      });
      using budget = createToolBudget();
      try {
        return await searchDocuments(service, { ...input, session: '2025/26' }, budget);
      } finally {
        service.dispose();
      }
    }
    it('lists a recurring event once, at its first occurrence, and counts it as one hit', async () => {
      const result = await search(
        [
          record('HDA3UU1', 1),
          calendar('HDC420260425vi4', 2, '2026-04-25 15:30:00'),
          record('HDA3UU2', 3),
          calendar('HDC420260425vi4', 2, '2026-04-26 15:30:00'),
          calendar('HDC420260425vi4', 2, '2026-05-02 15:30:00'),
        ],
        3,
      );
      expect(result.items.map((item) => [item.documentId, item.date])).toEqual([
        ['HDA3UU1', '2026-10-20 11:00:00'],
        ['HDC420260425VI4', '2026-04-25 15:30:00'],
        ['HDA3UU2', '2026-10-20 11:00:00'],
      ]);
      expect(result).toMatchObject({ returnedCount: 3, mergedRows: 2, hasMore: false });
    });
    it.each([
      { order: 'before', rows: [record('HDA3UU3', 1), calendar('HDA3UU3', 2, '2026-10-20')] },
      { order: 'after', rows: [calendar('HDA3UU3', 1, '2026-10-20'), record('HDA3UU3', 2)] },
    ])(
      'returns a record once, with its own metadata, when its calendar entry comes $order it',
      async ({ rows }) => {
        const result = await search([...rows, record('HDA3UU4', 3)], 3);
        expect(result.items).toEqual([
          expect.objectContaining({
            documentId: 'HDA3UU3',
            designation: 'UU3',
            date: '2026-10-20 11:00:00',
            sourceUrl: 'https://data.riksdagen.se/dokument/HDA3UU3.htm',
          }),
          expect.objectContaining({ documentId: 'HDA3UU4' }),
        ]);
        expect(result).toMatchObject({ returnedCount: 2, mergedRows: 1 });
      },
    );
    it('skips web-page rows and counts them apart from documents', async () => {
      const result = await search(
        [
          record('HDA3UU1', 1),
          webPage(2, 'Nu räknas rösterna'),
          webPage(3, 'The votes are being counted'),
          record('HDA3UU2', 4),
        ],
        4,
      );
      expect(result.items.map((item) => item.documentId)).toEqual(['HDA3UU1', 'HDA3UU2']);
      expect(result).toMatchObject({ skippedWebPageRows: 2, skippedMemberRows: 0, mergedRows: 0 });
    });
    it("lists calendar rows for single event occurrences under their event's record, once, at the first occurrence", async () => {
      const result = await search(
        [
          record('HDA3UU1', 1),
          calendar('HEC420261102vi1-u26348', 2, '2026-12-14 17:15:00'),
          record('HDA3UU2', 3),
          calendar('HEC420261102vi1-u26349', 4, '2026-12-15 17:15:00'),
        ],
        4,
      );
      expect(result.items.map((item) => [item.documentId, item.date])).toEqual([
        ['HDA3UU1', '2026-10-20 11:00:00'],
        ['HEC420261102VI1', '2026-12-14 17:15:00'],
        ['HDA3UU2', '2026-10-20 11:00:00'],
      ]);
      expect(result.items[1]).toMatchObject({
        sourceUrl: 'https://data.riksdagen.se/dokument/HEC420261102VI1',
        statusUrl: 'https://data.riksdagen.se/dokumentstatus/HEC420261102VI1.json',
      });
      expect(result).toMatchObject({
        occurrenceRows: 2,
        mergedRows: 1,
        skippedCalendarRows: 0,
        returnedCount: 3,
      });
    });
    it('checks a single-occurrence calendar row against the filters like any record row', async () => {
      await expect(
        search([{ ...calendar('HEC420261102vi1-u26348', 1, '2026-12-14'), rm: '2026/27' }], 1),
      ).rejects.toMatchObject({ data: { reason: 'upstream_identity_mismatch' } });
    });
    it('skips calendar rows with no record ID, such as cancelled entries, and counts them as hits', async () => {
      const cancelled = {
        database: 'kalender',
        dok_id: '',
        id: 'rd',
        doktyp: 'kam-ip',
        rm: '2025/26',
        titel: 'INSTÄLLT - Interpellationsdebatt',
        traff: '2',
      };
      const result = await search([record('HDA3UU1', 1), cancelled, record('HDA3UU2', 3)], 3);
      expect(result.items.map((item) => item.documentId)).toEqual(['HDA3UU1', 'HDA3UU2']);
      expect(result).toMatchObject({
        skippedCalendarRows: 1,
        occurrenceRows: 0,
        returnedCount: 2,
        hasMore: false,
      });
    });
    it('checks the page length against hits, not repeated occurrence rows', async () => {
      const occurrences = [
        calendar('HDC420260425vi4', 2, '2026-04-25'),
        calendar('HDC420260425vi4', 2, '2026-04-26'),
      ];
      await expect(
        search([record('HDA3UU1', 1), ...occurrences], 10, { page: 1, pageSize: 3 }),
      ).rejects.toMatchObject({
        message: 'Document search page length contradicts the published hit count.',
      });
      await expect(
        search([record('HDA3UU1', 1), ...occurrences, record('HDA3UU2', 3)], 10, {
          page: 1,
          pageSize: 3,
        }),
      ).resolves.toMatchObject({ returnedCount: 3, mergedRows: 1, hasMore: true });
    });
    it.each([
      {
        name: 'name different records',
        rows: [
          calendar('HDC420260425vi4', 1, '2026-04-25'),
          calendar('HDC420260425vi5', 1, '2026-04-25'),
        ],
      },
      { name: 'repeat a record row', rows: [record('HDA3UU1', 1), record('HDA3UU1', 1)] },
    ])('rejects rows of one hit that $name', async ({ rows }) => {
      await expect(search(rows, 1)).rejects.toMatchObject({
        message: 'Document search rows of one hit contradict each other.',
        data: { reason: 'upstream_schema_invalid' },
      });
    });
    it('drops whole leading hits, occurrence rows included, from a page read through the window edge', async () => {
      const requests: URL[] = [];
      const service = new RiksdagService({
        fetch: async (request) => {
          requests.push(new URL(String(request)));
          return Response.json({
            dokumentlista: {
              '@traffar': '12345',
              '@sida': '2500',
              dokument: [
                calendar('HDC420260425vi4', 9997, '2026-04-25'),
                record('HDA3UU1', 9998),
                calendar('HDC420260425vi4', 9997, '2026-04-26'),
                record('HDA3UU2', 9999),
                record('HDA3UU3', 10_000),
              ],
            },
          });
        },
      });
      using budget = createToolBudget();
      try {
        const result = await searchDocuments(service, { page: 770, pageSize: 13 }, budget);
        expect(
          requests.map((url) => [url.searchParams.get('p'), url.searchParams.get('sz')]),
        ).toEqual([['2500', '4']]);
        expect(result.items.map((item) => item.documentId)).toEqual([
          'HDA3UU1',
          'HDA3UU2',
          'HDA3UU3',
        ]);
        expect(result).toMatchObject({ mergedRows: 0, rowWindow: 'end', hasMore: false });
      } finally {
        service.dispose();
      }
    });
    it('drops leading hits by their number when the source lists the page out of hit order', async () => {
      // The source lists some pages by ascending date, so their highest-numbered hits come first.
      const service = new RiksdagService({
        fetch: async () =>
          Response.json({
            dokumentlista: {
              '@traffar': '12345',
              '@sida': '2500',
              dokument: [
                record('HDA3UU4', 10_000),
                record('HDA3UU3', 9999),
                record('HDA3UU2', 9998),
                calendar('HDC420260425vi4', 9997, '2026-04-25'),
                calendar('HDC420260425vi4', 9997, '2026-04-26'),
              ],
            },
          }),
      });
      using budget = createToolBudget();
      try {
        const result = await searchDocuments(service, { page: 770, pageSize: 13 }, budget);
        expect(result.items.map((item) => item.documentId)).toEqual([
          'HDA3UU4',
          'HDA3UU3',
          'HDA3UU2',
        ]);
        expect(result).toMatchObject({ returnedCount: 3, mergedRows: 0, rowWindow: 'end' });
      } finally {
        service.dispose();
      }
    });
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
