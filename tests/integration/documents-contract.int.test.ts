/** @fileoverview Document wire-to-tool dual-surface contracts. @module tests/integration/documents-contract */
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { riksdagGetDocument } from '@/mcp-server/tools/definitions/get-document.tool.js';
import { riksdagSearchDocuments } from '@/mcp-server/tools/definitions/search-documents.tool.js';
import { riksdagSearchSpeeches } from '@/mcp-server/tools/definitions/search-speeches.tool.js';
import { successEnrichment } from '@/services/riksdag/output.js';
import { getRiksdagService, initRiksdagService } from '@/services/riksdag/riksdag-service.js';
import { htmlToMarkdown } from '@/services/riksdag/text.js';
import { continuationArgs } from '../services/riksdag/continuation-fixtures.js';
import {
  convertedReport,
  convertedReportRevision,
  reportFixture,
} from '../services/riksdag/document-fixtures.js';
import { speechRow } from '../services/riksdag/speech-fixtures.js';

/** Counts converter calls below the service cache; every call still runs the real converter. */
vi.mock('@/services/riksdag/text.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/riksdag/text.js')>();
  return { ...actual, htmlToMarkdown: vi.fn(actual.htmlToMarkdown) };
});
const converter = vi.mocked(htmlToMarkdown);

afterEach(() => {
  vi.useRealTimers();
  getRiksdagService().dispose();
});

function domainText(result: Awaited<ReturnType<typeof runToolContract>>): unknown {
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('Expected domain text.');
  const firstNewline = first.text.indexOf('\n');
  const delimiter = first.text.slice(0, firstNewline).replace(/json$/, '');
  return JSON.parse(
    first.text.slice(firstNewline + 1, first.text.indexOf(`\n${delimiter}`, firstNewline)),
  );
}

function assertSuccess(result: Awaited<ReturnType<typeof runToolContract>>) {
  expect(result.isError).not.toBe(true);
  const enrichment = z.object(successEnrichment).parse(result.structuredContent);
  expect(enrichment.source).toBe('Source: The Swedish Parliament');
  expect(enrichment.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  const text = result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  expect(text).toContain('Source: The Swedish Parliament');
  for (const notice of enrichment.notices)
    expect(text).toContain(JSON.stringify(notice).slice(1, -1));
  return enrichment;
}

/** Follows a continuation unchanged and asserts it succeeds. */
async function followCall<D extends Parameters<typeof runToolContract>[0] & { input: z.ZodObject }>(
  definition: D,
  call: { toolName: string; args: Record<string, unknown> } | undefined,
) {
  const result = await runToolContract(
    definition,
    continuationArgs(definition, call) as z.input<D['input']>,
  );
  assertSuccess(result);
  return result;
}

/** Wording a size-shortened page would carry; caller limits are the only page boundaries. */
const shorteningNotice = /shortened|response target|indivisible|returned intact/i;

/** Synthetic motion row with publication metadata comparable to a live dokumentlista row. */
function motionRow(index: number) {
  return {
    dok_id: `HC02${index + 1}`,
    doktyp: 'mot',
    typ: 'mot',
    subtyp: 'fkm',
    rm: '2024/25',
    beteckning: String(index + 1),
    titel: `Syntetisk motion ${index + 1} om ${'ö'.repeat(180)}`,
    undertitel: 'av Syntetisk Ledamot (S)',
    datum: '2024-10-01',
    publicerad: '2024-10-02 10:00:00',
    systemdatum: '2024-10-02 10:00:00',
    organ: 'FiU',
    status: 'Publicerad',
    dokument_url_html: `//data.riksdagen.se/dokument/HC02${index + 1}`,
    dokument_url_text: `//data.riksdagen.se/dokument/HC02${index + 1}.text`,
  };
}

function motionSearch(page: number, total = 120, pageSize = 50) {
  const count = Math.max(0, Math.min(pageSize, total - (page - 1) * pageSize));
  return {
    dokumentlista: {
      '@traffar': String(total),
      '@sida': String(page),
      dokument: Array.from({ length: count }, (_, i) => motionRow((page - 1) * pageSize + i)),
    },
  };
}

describe('document public contract', () => {
  it('pages combined default text and HTML at 8,000 code points beside complete selected sections', async () => {
    const fixture = reportFixture(3);
    fixture.dokumentstatus.dokument.html = `<p>${'å😀\\"\n'.repeat(4000)}</p>`;
    initRiksdagService({ fetch: async () => Response.json(fixture) });
    const result = await runToolContract(riksdagGetDocument, {
      documentId: 'HC01KU1',
      sections: ['metadata', 'activities', 'reservations', 'text', 'source_html'],
    });
    const enrichment = assertSuccess(result);
    const page = riksdagGetDocument.output.parse(result.structuredContent);
    expect(domainText(result)).toEqual(page);
    expect(page.activities).toHaveLength(3);
    expect(page.reservations).toHaveLength(3);
    expect(page).toMatchObject({
      textOffset: 0,
      textReturnedLength: 8000,
      textHasMore: true,
      htmlOffset: 0,
      htmlReturnedLength: 8000,
      htmlTotalLength: 20007,
      htmlHasMore: true,
    });
    expect(Array.from(page.sourceHtml ?? '')).toHaveLength(8000);
    expect(page.nextTextCall?.args).toMatchObject({ sections: ['text'], textOffset: 8000 });
    expect(page.nextHtmlCall?.args).toMatchObject({ sections: ['source_html'], htmlOffset: 8000 });
    expect(enrichment.notices.filter((notice) => shorteningNotice.test(notice))).toEqual([]);
  });
  it('normalizes blank revisions and emits one terminal notice per requested representation', async () => {
    initRiksdagService({ fetch: async () => Response.json(reportFixture()) });
    const result = await runToolContract(riksdagGetDocument, {
      documentId: 'HC01KU1',
      sections: ['text', 'source_html'],
      revision: '  ',
      textOffset: 10000,
      htmlOffset: 10000,
    });
    const enrichment = assertSuccess(result);
    const page = riksdagGetDocument.output.parse(result.structuredContent);
    expect(domainText(result)).toEqual(page);
    expect(JSON.parse(enrichment.effectiveQuery)).not.toHaveProperty('revision');
    expect(enrichment.notices.filter((notice) => notice.includes('beyond'))).toHaveLength(2);
    expect(page).toMatchObject({
      text: '',
      sourceHtml: '',
      textHasMore: false,
      htmlHasMore: false,
    });
  });
  it('pages selected arrays at sectionLimit beside default text pages with independent continuations', async () => {
    const fixture = reportFixture(8);
    for (const row of fixture.dokumentstatus.dokaktivitet.aktivitet) row.namn = 'a'.repeat(900);
    for (const row of fixture.dokumentstatus.dokmotforslag.motforslag) row.rubrik = 'b'.repeat(900);
    fixture.dokumentstatus.dokument.html = `<p>${'😀'.repeat(9000)}</p>`;
    initRiksdagService({ fetch: async () => Response.json(fixture) });
    const result = await runToolContract(riksdagGetDocument, {
      documentId: 'HC01KU1',
      sections: ['activities', 'reservations', 'text', 'source_html'],
      sectionLimit: 3,
    });
    const enrichment = assertSuccess(result);
    const page = riksdagGetDocument.output.parse(result.structuredContent);
    expect(domainText(result)).toEqual(page);
    expect(enrichment.notices.filter((notice) => shorteningNotice.test(notice))).toEqual([]);
    expect(page.truncated).toBe(true);
    for (const section of ['activities', 'reservations'] as const) {
      expect(page[section]).toHaveLength(3);
      const pagination = page.sectionPages?.find((entry) => entry.section === section);
      expect(pagination).toMatchObject({
        limit: 3,
        returnedCount: 3,
        totalCount: 8,
        hasMore: true,
      });
      expect(pagination?.nextCall?.args).toMatchObject({ sections: [section], sectionOffset: 3 });
      const next = riksdagGetDocument.output.parse(
        (await followCall(riksdagGetDocument, pagination?.nextCall)).structuredContent,
      );
      expect(
        section === 'activities'
          ? next.activities?.map((entry) => entry.code)
          : next.reservations?.map((entry) => entry.number),
      ).toEqual(section === 'activities' ? ['A4', 'A5', 'A6'] : ['4', '5', '6']);
      expect(next.sectionPages).toMatchObject([{ section, offset: 3, hasMore: true }]);
    }
    expect(page).toMatchObject({ textReturnedLength: 8000, htmlReturnedLength: 8000 });
    expect(page.nextTextCall?.args).toMatchObject({ sections: ['text'], textOffset: 8000 });
    expect(page.nextHtmlCall?.args).toMatchObject({ sections: ['source_html'], htmlOffset: 8000 });
    const text = riksdagGetDocument.output.parse(
      (await followCall(riksdagGetDocument, page.nextTextCall)).structuredContent,
    );
    expect(text).toMatchObject({ textOffset: 8000, textReturnedLength: 1000, textHasMore: false });
    expect(text.sectionPages).toEqual([]);
    const html = riksdagGetDocument.output.parse(
      (await followCall(riksdagGetDocument, page.nextHtmlCall)).structuredContent,
    );
    expect(html).toMatchObject({ htmlOffset: 8000, htmlReturnedLength: 1007, htmlHasMore: false });
  });
  it('reconstructs both default representations after a combined first page with stable revisions', async () => {
    const body = 'Å😀x'.repeat(5000);
    const html = `<p>${body}</p>`;
    const fixture = reportFixture(1);
    fixture.dokumentstatus.dokument.html = html;
    initRiksdagService({ fetch: async () => Response.json(fixture) });
    const firstResult = await runToolContract(riksdagGetDocument, {
      documentId: 'HC01KU1',
      sections: ['text', 'source_html'],
    });
    const first = riksdagGetDocument.output.parse(firstResult.structuredContent);
    for (const channel of ['text', 'source_html'] as const) {
      let combined = channel === 'text' ? first.text! : first.sourceHtml!;
      let next = channel === 'text' ? first.nextTextCall : first.nextHtmlCall;
      while (next) {
        expect(next.args.revision).toBe(first.revision);
        expect(next.args.sections).toEqual([channel]);
        const result = await followCall(riksdagGetDocument, next);
        const page = riksdagGetDocument.output.parse(result.structuredContent);
        expect(domainText(result)).toEqual(page);
        combined += channel === 'text' ? page.text : page.sourceHtml;
        next = channel === 'text' ? page.nextTextCall : page.nextHtmlCall;
      }
      expect(combined).toBe(channel === 'text' ? body : html);
    }
  });
  it('returns classified upstream outage instead of a successful missing document', async () => {
    vi.useFakeTimers();
    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response('unavailable', { status: 503 }));
    initRiksdagService({ fetch: network });
    const pending = runToolContract(riksdagGetDocument, { documentId: 'HC01KU1' });
    await vi.advanceTimersByTimeAsync(500);
    const result = await pending;
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: JsonRpcErrorCode.ServiceUnavailable, data: { status: 503 } },
      },
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringMatching(/503|unavailable/i) }),
      ]),
    );
    expect(network).toHaveBeenCalledTimes(2);
  });
  it('cancels while consuming a real document response body on both error surfaces', async () => {
    const caller = new AbortController();
    const ready = Promise.withResolvers<void>();
    const cancelled = vi.fn();
    const network = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{'));
              ready.resolve();
            },
            cancel: cancelled,
          }),
        ),
    );
    initRiksdagService({ fetch: network });
    const pending = runToolContract(
      riksdagGetDocument,
      { documentId: 'HC01KU1' },
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
    expect(network).toHaveBeenCalledTimes(1);
  });
  it.each(['schema', 'identity', 'invalid_filter', 'http404'])(
    'mirrors %s failure and actionable recovery on both public surfaces',
    async (kind) => {
      const network = vi.fn<typeof fetch>().mockImplementation(async () => {
        if (kind === 'http404') return new Response('', { status: 404 });
        if (kind === 'schema') return Response.json({ unexpected: {} });
        return Response.json({ dokumentstatus: { dokument: { dok_id: 'HC01KU2' } } });
      });
      initRiksdagService({ fetch: network });
      const result =
        kind === 'http404'
          ? await runToolContract(riksdagSearchDocuments, {})
          : await runToolContract(riksdagGetDocument, {
              documentId: kind === 'invalid_filter' ? 'HC01KŮ' : 'HC01KU1',
            });
      expect(result.isError).toBe(true);
      const error = z
        .object({
          error: z.object({
            code: z.number(),
            data: z
              .object({
                reason: z.string().optional(),
                recovery: z.object({ hint: z.string() }).optional(),
              })
              .optional(),
          }),
        })
        .parse(result.structuredContent).error;
      const text = result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      expect(text).toMatch(/Error:/);
      if (kind === 'http404') {
        expect(error.code).toBe(JsonRpcErrorCode.NotFound);
        expect(error.data?.reason).not.toBe('upstream_schema_invalid');
      } else {
        const reason =
          kind === 'schema'
            ? 'upstream_schema_invalid'
            : kind === 'identity'
              ? 'upstream_identity_mismatch'
              : kind;
        expect(error.data?.reason).toBe(reason);
        expect(error.data?.recovery?.hint).toBeTruthy();
        expect(text).toContain(error.data?.recovery?.hint);
      }
      if (kind === 'invalid_filter') expect(network).not.toHaveBeenCalled();
    },
  );
  it.each([
    {
      name: 'an unknown section',
      input: { documentId: 'HC01KU1', sections: ['other'] },
      message: 'sections.0: Invalid option',
    },
    {
      name: 'a malformed document ID',
      input: { documentId: 'KU1' },
      message: 'Invalid documentId; use riksdag_list_reference to check its format or code.',
    },
    {
      name: 'a blank document ID',
      input: { documentId: '  ' },
      message: 'Invalid documentId; use riksdag_list_reference to check its format or code.',
    },
  ])('rejects $name at the input schema on both public surfaces', async ({ input, message }) => {
    const network = vi.fn<typeof fetch>();
    initRiksdagService({ fetch: network });
    const result = await runToolContract<Parameters<typeof runToolContract>[0]>(
      riksdagGetDocument,
      input,
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          data: {
            reason: 'invalid_arguments',
            recovery: { hint: expect.stringContaining(message) },
          },
        },
      },
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringContaining(message) }),
      ]),
    );
    expect(network).not.toHaveBeenCalled();
  });
  it('returns heavy and oversized section entries whole at the section limit without notices', async () => {
    const fixture = reportFixture(3);
    for (const entry of fixture.dokumentstatus.dokaktivitet.aktivitet)
      entry.namn = 'x'.repeat(4000) + entry.kod;
    initRiksdagService({ fetch: async () => Response.json(fixture) });
    const result = await runToolContract(riksdagGetDocument, {
      documentId: 'HC01KU1',
      sections: ['activities'],
      sectionLimit: 3,
    });
    const enrichment = assertSuccess(result);
    const page = riksdagGetDocument.output.parse(result.structuredContent);
    expect(page.truncated).toBe(false);
    expect(page.activities?.map((entry) => entry.name)).toEqual(
      ['A1', 'A2', 'A3'].map((code) => `${'x'.repeat(4000)}${code}`),
    );
    expect(page.sectionPages).toEqual([
      {
        section: 'activities',
        totalCount: 3,
        offset: 0,
        limit: 3,
        requestedLimit: 3,
        returnedCount: 3,
        hasMore: false,
      },
    ]);
    expect(enrichment.notices).toEqual([]);
    expect(domainText(result)).toEqual(page);
    const huge = reportFixture(1);
    huge.dokumentstatus.dokaktivitet.aktivitet[0]!.namn = 'x'.repeat(20000);
    initRiksdagService({ fetch: async () => Response.json(huge) });
    const oversized = await runToolContract(riksdagGetDocument, {
      documentId: 'HC01KU1',
      sections: ['activities'],
    });
    expect(assertSuccess(oversized).notices).toEqual([]);
    expect(oversized.structuredContent).toMatchObject({
      activities: [{ name: 'x'.repeat(20000) }],
      truncated: false,
    });
    expect(domainText(oversized)).toEqual(
      riksdagGetDocument.output.parse(oversized.structuredContent),
    );
  });
  it('honors explicit long text and clamps section limits with truthful notices', async () => {
    const text = '😀'.repeat(12000);
    initRiksdagService({
      fetch: async () =>
        Response.json({
          dokumentstatus: {
            dokument: { dok_id: 'sfs-2000-100', doktyp: 'sfs', text },
            dokaktivitet: { aktivitet: [] },
          },
        }),
    });
    const result = await runToolContract(riksdagGetDocument, {
      documentId: '2000:100',
      sections: ['text', 'activities'],
      textLength: 12000,
      sectionLimit: 100000,
    });
    const enrichment = assertSuccess(result);
    expect(result.structuredContent).toMatchObject({
      text,
      textReturnedLength: 12000,
      textHasMore: false,
      sectionPages: [{ limit: 100, requestedLimit: 100000 }],
    });
    expect(enrichment.notices.filter((notice) => shorteningNotice.test(notice))).toEqual([]);
    expect(enrichment.notices.join(' ')).toContain('clamped to 100');
    expect(domainText(result)).toEqual(riksdagGetDocument.output.parse(result.structuredContent));
  });
  it('sends only verified search keys and preserves every normalized filter in continuation', async () => {
    const network = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        dokumentlista: {
          '@traffar': '3',
          '@sida': '1',
          '@nasta_sida': 'http://data.riksdagen.se/dokumentlista/?p=2&evil=x',
          '@q': 'upstream echo',
          '@varning': 'Källvarning',
          dokument: [
            { dok_id: 'hc01ku1', doktyp: 'bet', rm: '1999/2000', organ: 'KU', titel: 'Ett' },
            { dok_id: 'hc01ku2', doktyp: 'bet', rm: '1999/2000', organ: 'KU', titel: 'Två' },
          ],
        },
      }),
    );
    initRiksdagService({ fetch: network });
    const result = await runToolContract(riksdagSearchDocuments, {
      query: ' budget ',
      documentType: 'BET',
      session: '1999/00',
      committee: 'ku',
      party: 's',
      dateFrom: '1999-01-01',
      dateTo: '2000-12-31',
      pageSize: 2,
    });
    const enrichment = assertSuccess(result);
    expect(enrichment).toMatchObject({
      upstreamQuery: 'upstream echo',
      upstreamWarnings: ['Källvarning'],
    });
    const page = riksdagSearchDocuments.output.parse(result.structuredContent);
    expect(domainText(result)).toEqual(page);
    expect(page.nextCall).toEqual({
      toolName: 'riksdag_search_documents',
      args: {
        query: 'budget',
        documentType: 'bet',
        session: '1999/2000',
        committee: 'KU',
        party: 'S',
        dateFrom: '1999-01-01',
        dateTo: '2000-12-31',
        page: 2,
        pageSize: 2,
        offset: 0,
        sort: 'relevance',
      },
    });
    expect(
      riksdagSearchDocuments.input.strict().safeParse(page.nextCall?.args).error,
    ).toBeUndefined();
    expect(String(network.mock.calls[0]?.[0])).toBe(
      'https://data.riksdagen.se/dokumentlista/?doktyp=bet&from=1999-01-01&org=KU&p=1&parti=S&rm=1999%2F2000&sok=budget&sort=rel&sortorder=desc&sz=2&tom=2000-12-31&utformat=json',
    );
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('omits blank form filters and keeps sparse publication values absent', async () => {
    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ dokumentlista: { '@traffar': '1', dokument: { dok_id: 'HC01KU1' } } }),
      );
    initRiksdagService({ fetch: network });
    const result = await runToolContract(riksdagSearchDocuments, {
      query: ' ',
      documentType: '',
      session: ' ',
      committee: '',
      party: ' ',
      dateFrom: '',
      dateTo: ' ',
    });
    assertSuccess(result);
    expect(domainText(result)).toEqual(
      riksdagSearchDocuments.output.parse(result.structuredContent),
    );
    expect(String(network.mock.calls[0]?.[0])).toBe(
      'https://data.riksdagen.se/dokumentlista/?p=1&sort=datum&sortorder=desc&sz=10&utformat=json',
    );
    expect(result.structuredContent).toMatchObject({ items: [{ documentId: 'HC01KU1' }] });
    expect(domainText(result)).not.toHaveProperty('items.0.publicationStatus');
  });
  it.each([1, 3])(
    'explains empty search page %i with enrichment on both surfaces',
    async (page) => {
      initRiksdagService({
        fetch: async () => Response.json({ dokumentlista: { '@traffar': '0', dokument: null } }),
      });
      const result = await runToolContract(riksdagSearchDocuments, { query: 'synthetic', page });
      const enrichment = assertSuccess(result);
      expect(result.structuredContent).toMatchObject({
        items: [],
        totalCount: 0,
        returnedCount: 0,
        hasMore: false,
      });
      expect(enrichment.notices.join(' ')).toContain(page === 1 ? 'fewer filters' : 'page: 1');
      expect(domainText(result)).toEqual(
        riksdagSearchDocuments.output.parse(result.structuredContent),
      );
    },
  );
  it('returns oversized rows of a remote page whole and continues on the next remote page', async () => {
    const title = 'å'.repeat(8000);
    initRiksdagService({
      fetch: async () =>
        Response.json({
          dokumentlista: {
            '@traffar': '4',
            dokument: [
              { dok_id: 'HC01KU1', titel: title },
              { dok_id: 'HC01KU2', titel: title },
            ],
          },
        }),
    });
    const result = await runToolContract(riksdagSearchDocuments, { pageSize: 2 });
    const enrichment = assertSuccess(result);
    const page = riksdagSearchDocuments.output.parse(result.structuredContent);
    expect(page).toMatchObject({
      returnedCount: 2,
      pageSize: 2,
      items: [
        { documentId: 'HC01KU1', title },
        { documentId: 'HC01KU2', title },
      ],
      nextCall: { args: { page: 2, pageSize: 2, offset: 0 } },
    });
    expect(page.nextCall?.args).not.toHaveProperty('revision');
    expect(domainText(result)).toEqual(page);
    expect(enrichment.notices).toEqual([]);
  });
  it('clamps remote page size to 200 and returns every fetched row of the final page', async () => {
    const network = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        dokumentlista: {
          '@traffar': '200',
          dokument: Array.from({ length: 200 }, (_, i) => ({ dok_id: `HC01KU${i + 1}` })),
        },
      }),
    );
    initRiksdagService({ fetch: network });
    const result = await runToolContract(riksdagSearchDocuments, { pageSize: 100000 });
    expect(assertSuccess(result).notices).toContain('Requested pageSize was clamped to 200.');
    expect(new URL(String(network.mock.calls[0]?.[0])).searchParams.get('sz')).toBe('200');
    const first = riksdagSearchDocuments.output.parse(result.structuredContent);
    expect(first).toMatchObject({
      pageSize: 200,
      returnedCount: 200,
      remoteReturnedCount: 200,
      hasMore: false,
    });
    expect(first.nextCall).toBeUndefined();
    expect(first.items.map((row) => row.documentId)).toEqual(
      Array.from({ length: 200 }, (_, i) => `HC01KU${i + 1}`),
    );
    expect(domainText(result)).toEqual(first);
  });
  it('traverses every independently selected nested section beyond the first page', async () => {
    initRiksdagService({ fetch: async () => Response.json(reportFixture()) });
    const sections = [
      'decisions',
      'reservations',
      'activities',
      'properties',
      'attachments',
      'references',
    ] as const;
    const first = await runToolContract(riksdagGetDocument, {
      documentId: 'hc01ku1',
      sections: [...sections],
      sectionLimit: 1,
    });
    assertSuccess(first);
    const firstPage = riksdagGetDocument.output.parse(first.structuredContent);
    expect(domainText(first)).toEqual(firstPage);
    expect(firstPage.sectionPages).toHaveLength(6);
    for (const section of sections) {
      const pages = [firstPage];
      let next = firstPage.sectionPages?.find((page) => page.section === section)?.nextCall;
      while (next) {
        expect(next.args).toMatchObject({
          documentId: 'HC01KU1',
          revision: firstPage.revision,
          sections: [section],
          sectionLimit: 1,
        });
        const result = await followCall(riksdagGetDocument, next);
        const page = riksdagGetDocument.output.parse(result.structuredContent);
        expect(domainText(result)).toEqual(page);
        pages.push(page);
        next = page.sectionPages?.find((entry) => entry.section === section)?.nextCall;
      }
      const entries = pages.flatMap((page) =>
        (page[section] ?? []).map((entry) => JSON.stringify(entry)),
      );
      expect(entries).toHaveLength(3);
      expect(new Set(entries).size).toBe(3);
      expect(pages.at(-1)).toMatchObject({
        truncated: false,
        sectionPages: [{ section, offset: 2, totalCount: 3, returnedCount: 1, hasMore: false }],
      });
    }
  });
  it('paginates canonical Markdown and source HTML separately without losing Unicode characters', async () => {
    initRiksdagService({ fetch: async () => Response.json(reportFixture()) });
    for (const representation of ['text', 'source_html'] as const) {
      const expected =
        representation === 'text'
          ? '# Rubrik 😀\n\nFörsta stycket.\n\nAndra stycket.'
          : '<h1>Rubrik 😀</h1><p>Första stycket.</p><p>Andra stycket.</p>';
      const expectedLength = Array.from(expected).length;
      let args = riksdagGetDocument.input.parse({
        documentId: 'HC01KU1',
        sections: [representation],
        textLength: 3,
        htmlLength: 3,
      });
      let combined = '';
      let pages = 0;
      for (;;) {
        const result = await runToolContract(riksdagGetDocument, args);
        assertSuccess(result);
        const page = riksdagGetDocument.output.parse(result.structuredContent);
        expect(domainText(result)).toEqual(page);
        const chunk = (representation === 'text' ? page.text : page.sourceHtml) ?? '';
        // Every page holds the requested 3 code points until the representation runs out.
        expect(Array.from(chunk)).toHaveLength(
          Math.min(3, expectedLength - Array.from(combined).length),
        );
        pages++;
        combined += chunk;
        const next = representation === 'text' ? page.nextTextCall : page.nextHtmlCall;
        if (!next) break;
        expect(next.args).toMatchObject({
          documentId: 'HC01KU1',
          revision: page.revision,
          sections: [representation],
          textLength: 3,
          htmlLength: 3,
        });
        args = riksdagGetDocument.input.parse(next.args);
      }
      expect(combined).toBe(expected);
      expect(pages).toBe(Math.ceil(expectedLength / 3));
    }
  });
  it('preserves consolidated SFS CRLF, repeated sections and future commencement markers', async () => {
    const text =
      '1 § Gäller nu.\r\n\r\n1 § /Träder i kraft I:2030-01-01/ 😀\r\n2 § /Upphör att gälla U:2031-01-01/';
    initRiksdagService({
      fetch: async () =>
        Response.json({
          dokumentstatus: {
            dokument: {
              dok_id: 'sfs-2000-100',
              doktyp: 'sfs',
              subtyp: 'sfst',
              subtitel: 'Ändrad t.o.m. SFS 2026:1',
              text,
              publicerad: '2026-01-01 10:00',
              systemdatum: '2026-01-02 11:00',
            },
          },
        }),
    });
    const result = await runToolContract(riksdagGetDocument, {
      documentId: 'SFS 2000:100',
      textLength: 10000,
    });
    const enrichment = assertSuccess(result);
    expect(result.structuredContent).toMatchObject({
      documentId: 'sfs-2000-100',
      textRepresentation: 'source_text',
      text,
      textHasMore: false,
      metadata: {
        versionKind: 'consolidated',
        consolidationLabel: 'Ändrad t.o.m. SFS 2026:1',
        publishedAt: '2026-01-01 10:00',
        systemDate: '2026-01-02 11:00',
      },
    });
    expect(domainText(result)).toEqual(riksdagGetDocument.output.parse(result.structuredContent));
    expect(enrichment.notices).toContain(
      'Consolidated published text; not an as-enacted or point-in-time legal version.',
    );
  });
  it('retains source retrieval time on cache hits and rejects changed revisions after cache eviction', async () => {
    vi.useFakeTimers();
    const network = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => Response.json(reportFixture()))
      .mockImplementation(async () => {
        const fixture = reportFixture();
        fixture.dokumentstatus.dokument.titel = 'Ändrad titel';
        return Response.json(fixture);
      });
    initRiksdagService({ fetch: network });
    const first = await runToolContract(riksdagGetDocument, {
      documentId: 'HC01KU1',
      textLength: 2,
    });
    const firstEnrichment = assertSuccess(first);
    const page = riksdagGetDocument.output.parse(first.structuredContent);
    vi.advanceTimersByTime(1000);
    const cached = await runToolContract(riksdagGetDocument, {
      documentId: 'HC01KU1',
      sections: ['metadata'],
    });
    expect(assertSuccess(cached).retrievedAt).toBe(firstEnrichment.retrievedAt);
    expect(network).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300000);
    const changed = await runToolContract(
      riksdagGetDocument,
      riksdagGetDocument.input.strict().parse(page.nextTextCall?.args),
    );
    expect(changed).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: JsonRpcErrorCode.Conflict,
          data: {
            reason: 'revision_changed',
            recovery: { hint: expect.stringContaining('Restart') },
          },
        },
      },
    });
    expect(changed.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('Restart') }),
      ]),
    );
    expect(network).toHaveBeenCalledTimes(2);
  });
  it('returns explicit misses and missing-body successes, with complete enrichment and guidance', async () => {
    initRiksdagService({ fetch: async () => new Response('', { status: 404 }) });
    const missing = await runToolContract(riksdagGetDocument, { documentId: 'HC01KU1' });
    assertSuccess(missing);
    expect(missing.structuredContent).toMatchObject({
      found: false,
      documentId: 'HC01KU1',
      guidance: expect.stringContaining('riksdag_search_documents'),
    });
    expect(domainText(missing)).toEqual(riksdagGetDocument.output.parse(missing.structuredContent));
    initRiksdagService({
      fetch: async () => Response.json({ dokumentstatus: { dokument: { dok_id: 'HC01KU1' } } }),
    });
    const bodyless = await runToolContract(riksdagGetDocument, { documentId: 'HC01KU1' });
    assertSuccess(bodyless);
    expect(bodyless.structuredContent).toMatchObject({
      found: true,
      textAvailable: false,
      truncated: false,
    });
    expect(domainText(bodyless)).not.toHaveProperty('text');
  });
  it('returns terminal empty text, HTML and section pages beyond their ends', async () => {
    initRiksdagService({ fetch: async () => Response.json(reportFixture()) });
    const result = await runToolContract(riksdagGetDocument, {
      documentId: 'HC01KU1',
      sections: ['text', 'source_html', 'activities'],
      textOffset: 10000,
      htmlOffset: 10000,
      sectionOffset: 10000,
    });
    const enrichment = assertSuccess(result);
    expect(result.structuredContent).toMatchObject({
      text: '',
      textReturnedLength: 0,
      textHasMore: false,
      sourceHtml: '',
      htmlReturnedLength: 0,
      htmlHasMore: false,
      activities: [],
      truncated: false,
    });
    expect(enrichment.notices.join(' ')).toContain('beyond');
    expect(domainText(result)).toEqual(riksdagGetDocument.output.parse(result.structuredContent));
  });
  it('discloses root truncation when a selected section has more entries', async () => {
    initRiksdagService({
      fetch: async () =>
        Response.json({
          dokumentstatus: {
            dokument: { dok_id: 'HC01KU1' },
            dokaktivitet: { aktivitet: [{ kod: 'A' }, { kod: 'B' }] },
          },
        }),
    });
    try {
      const result = await runToolContract(riksdagGetDocument, {
        documentId: 'HC01KU1',
        sections: ['activities'],
        sectionLimit: 1,
      });
      expect(result.structuredContent).toMatchObject({
        found: true,
        truncated: true,
        activities: [{ code: 'A' }],
        sectionPages: [{ totalCount: 2, returnedCount: 1, hasMore: true }],
      });
      const first = result.content[0];
      if (first?.type !== 'text') throw new Error('Expected domain text.');
      expect(first.text).toContain('"truncated": true');
    } finally {
      getRiksdagService().dispose();
    }
  });
  it('returns 100-entry section pages and discloses truncation when any selected section has more', async () => {
    const fixture = reportFixture(120);
    fixture.dokumentstatus.dokmotforslag.motforslag.splice(3);
    initRiksdagService({ fetch: async () => Response.json(fixture) });
    const result = await runToolContract(riksdagGetDocument, {
      documentId: 'HC01KU1',
      sections: ['activities', 'reservations'],
      sectionLimit: 100,
    });
    assertSuccess(result);
    const page = riksdagGetDocument.output.parse(result.structuredContent);
    expect(domainText(result)).toEqual(page);
    expect(page.truncated).toBe(true);
    expect(page.activities?.map((entry) => entry.code)).toEqual(
      Array.from({ length: 100 }, (_, i) => `A${i + 1}`),
    );
    expect(page.reservations?.map((entry) => entry.number)).toEqual(['1', '2', '3']);
    expect(page.sectionPages).toMatchObject([
      { section: 'reservations', totalCount: 3, limit: 100, returnedCount: 3, hasMore: false },
      { section: 'activities', totalCount: 120, limit: 100, returnedCount: 100, hasMore: true },
    ]);
    const rest = riksdagGetDocument.output.parse(
      (await followCall(riksdagGetDocument, page.sectionPages?.[1]?.nextCall)).structuredContent,
    );
    expect(rest.activities?.map((entry) => entry.code)).toEqual(
      Array.from({ length: 20 }, (_, i) => `A${i + 101}`),
    );
    expect(rest).toMatchObject({
      truncated: false,
      sectionPages: [{ section: 'activities', offset: 100, returnedCount: 20, hasMore: false }],
    });
  });
  it('normalizes nested decision summary tables without losing captions, blank cells or literal zeroes', async () => {
    initRiksdagService({
      fetch: async () =>
        Response.json({
          dokumentstatus: {
            dokument: { dok_id: 'HC01KU1', doktyp: 'bet', rm: '2024/25', beteckning: 'KU1' },
            dokutskottsforslag: {
              utskottsforslag: [
                {
                  punkt: '1',
                  votering_sammanfattning_html: {
                    table: {
                      caption: { b: 'Huvudvotering', '#text': 'Publicerad sammanfattning' },
                      thead: { tr: { th: ['Parti', 'Ja', 'Nej'] } },
                      tbody: {
                        tr: [
                          { th: 'S', td: ['0', '', { '#text': '12' }] },
                          { th: 'M', td: [{ '#text': '' }, '2', '0', {}] },
                        ],
                      },
                      tfooter: { tr: { th: 'Totalt', td: ['0', { '#text': '14' }, ''] } },
                    },
                  },
                },
                { punkt: '2', votering_sammanfattning_html: 'Källans sammanfattning' },
              ],
            },
          },
        }),
    });
    try {
      const result = await runToolContract(riksdagGetDocument, {
        documentId: 'HC01KU1',
        sections: ['decisions'],
      });
      assertSuccess(result);
      expect(domainText(result)).toEqual(riksdagGetDocument.output.parse(result.structuredContent));
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        decisions: [
          {
            point: 1,
            summary: {
              caption: { heading: 'Huvudvotering', text: 'Publicerad sammanfattning' },
              columns: ['Parti', 'Ja', 'Nej'],
              rows: [
                { label: 'S', cells: ['0', '', '12'] },
                { label: 'M', cells: ['', '2', '0', null] },
              ],
              footer: { label: 'Totalt', cells: ['0', '14', ''] },
            },
          },
          { point: 2, summary: { text: 'Källans sammanfattning' } },
        ],
      });
      const first = result.content[0];
      if (first?.type !== 'text') throw new Error('Expected domain text.');
      expect(first.text).toContain('"columns"');
      expect(first.text).toContain('"heading": "Huvudvotering"');
      expect(first.text).toContain('Källans sammanfattning');
    } finally {
      getRiksdagService().dispose();
    }
  });
});

const convertedReportCall: z.input<typeof riksdagGetDocument.input> = {
  documentId: 'HC01KU1',
  sections: ['metadata', 'text', 'decisions', 'properties'],
  textLength: 5,
};
describe('document conversions across calls', () => {
  it('characterizes the converted record a call returns', async () => {
    initRiksdagService({ fetch: async () => Response.json(convertedReport()) });
    const result = await runToolContract(riksdagGetDocument, convertedReportCall);
    assertSuccess(result);
    const page = riksdagGetDocument.output.parse(result.structuredContent);
    expect(domainText(result)).toEqual(page);
    expect({
      revision: page.revision,
      outline: page.outline,
      text: page.text,
      textTotalLength: page.textTotalLength,
      nextTextCall: page.nextTextCall,
      proposals: page.decisions?.map((decision) => decision.proposal),
      properties: page.properties,
    }).toEqual({
      revision: convertedReportRevision,
      outline: [
        { section: 'metadata', available: true, itemCount: 1 },
        { section: 'decisions', available: true, itemCount: 2 },
        { section: 'reservations', available: true, itemCount: 2 },
        { section: 'activities', available: true, itemCount: 2 },
        { section: 'properties', available: true, itemCount: 3 },
        { section: 'attachments', available: true, itemCount: 2 },
        { section: 'references', available: true, itemCount: 2 },
        { section: 'stakeholders', available: false, itemCount: 0 },
        { section: 'text', available: true, textLength: 43 },
        { section: 'source_html', available: true, textLength: 60 },
      ],
      text: '# Rub',
      textTotalLength: 43,
      nextTextCall: {
        toolName: 'riksdag_get_document',
        args: {
          documentId: 'HC01KU1',
          sections: ['text'],
          textOffset: 5,
          textLength: 5,
          htmlOffset: 0,
          sectionOffset: 0,
          sectionLimit: 20,
          revision: convertedReportRevision,
        },
      },
      proposals: ['Förslag 1', 'Förslag 2'],
      properties: [
        { code: 'arendestatuskammaren', name: 'Avgjort', text: 'Kammarens uppgift' },
        { code: 'P2', name: 'Egenskap 2', text: 'Värde 2' },
        {
          code: 'notis',
          name: 'Notis',
          text: '**Kort** notis med [länk](<https://data.riksdagen.se/dokument/HC01KU1>)',
          sourceHtml: '<p><b>Kort</b> notis med <a href="/dokument/HC01KU1">länk</a></p>',
        },
      ],
    });
  });
  it('repeats a call on a cached record without converting or fetching, identically on both surfaces', async () => {
    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(convertedReport()));
    initRiksdagService({ fetch: network });
    converter.mockClear();
    const first = await runToolContract(riksdagGetDocument, convertedReportCall);
    assertSuccess(first);
    // One body, two proposals and one notice property.
    expect(converter).toHaveBeenCalledTimes(4);
    const repeat = await runToolContract(riksdagGetDocument, convertedReportCall);
    expect(converter).toHaveBeenCalledTimes(4);
    expect(network).toHaveBeenCalledTimes(1);
    expect(repeat.structuredContent).toEqual(first.structuredContent);
    expect(repeat.content).toEqual(first.content);
    expect(riksdagGetDocument.output.parse(repeat.structuredContent).revision).toBe(
      convertedReportRevision,
    );
  });
  it('shares one conversion across calls that differ only in sections, offsets, lengths and revision', async () => {
    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(convertedReport()));
    initRiksdagService({ fetch: network });
    converter.mockClear();
    assertSuccess(
      await runToolContract(riksdagGetDocument, { documentId: 'HC01KU1', sections: [] }),
    );
    expect(converter).toHaveBeenCalledTimes(4);
    const variants: Omit<z.input<typeof riksdagGetDocument.input>, 'documentId'>[] = [
      { sections: ['references'] },
      { sections: ['text'], textOffset: 3, textLength: 7 },
      { sections: ['source_html'], htmlOffset: 10, htmlLength: 4 },
      { sections: ['decisions', 'properties'], sectionOffset: 1, sectionLimit: 1 },
      { revision: convertedReportRevision },
      {},
    ];
    for (const args of variants) {
      const result = await runToolContract(riksdagGetDocument, { documentId: 'hc01ku1', ...args });
      assertSuccess(result);
      const page = riksdagGetDocument.output.parse(result.structuredContent);
      expect(page.revision).toBe(convertedReportRevision);
      expect(page.outline?.find((entry) => entry.section === 'text')).toEqual({
        section: 'text',
        available: true,
        textLength: 43,
      });
    }
    expect(converter).toHaveBeenCalledTimes(4);
    expect(network).toHaveBeenCalledTimes(1);
  });
});
/** A full-text result row as the source publishes it, `database` included. */
function fullTextRow(index: number, database: 'dokument' | 'alla' = 'dokument') {
  return {
    database,
    dok_id: `HD02${index}`,
    doktyp: 'mot',
    rm: '2025/26',
    beteckning: String(index),
    titel: `Syntetisk motion ${index} om klimat`,
    undertitel: 'av Syntetisk Ledamot (S)',
    datum: '2025-10-06',
    dokument_url_html: `//data.riksdagen.se/dokument/HD02${index}.html`,
  };
}
/** A synthetic member-profile row: the source mixes these into full-text results without a document identity. */
function memberProfileRow(index: number) {
  return {
    database: 'ledamot',
    id: `00000000-0000-4000-8000-00000000000${index}`,
    dok_id: '',
    doktyp: '',
    typ: '',
    rm: '',
    organ: '',
    beteckning: '',
    titel: `Syntetisk Ledamot ${index}  (L)`,
    status: 'Riksdagsledamot',
    tilltalsnamn: 'Syntetisk',
    efternamn: `Ledamot ${index}`,
    parti: 'L',
  };
}
function fullTextPage(rows: unknown[], page = 1) {
  return {
    dokumentlista: {
      '@traffar': '22581',
      '@sida': String(page),
      '@nasta_sida': `http://data.riksdagen.se/dokumentlista/?sz=10&p=${page + 1}&utformat=json&sok=klimat&sort=rel&sortorder=desc`,
      dokument: rows,
    },
  };
}
describe('member-profile rows in full-text search', () => {
  it('characterizes a full-text page without member-profile rows', async () => {
    initRiksdagService({
      fetch: async () =>
        Response.json(
          fullTextPage(
            Array.from({ length: 10 }, (_, i) => fullTextRow(i + 1, i === 4 ? 'alla' : 'dokument')),
          ),
        ),
    });
    const result = await runToolContract(riksdagSearchDocuments, { query: 'klimat' });
    const enrichment = assertSuccess(result);
    const page = riksdagSearchDocuments.output.parse(result.structuredContent);
    expect(domainText(result)).toEqual(page);
    expect(enrichment.notices).toEqual([]);
    expect(page).toEqual({
      items: Array.from({ length: 10 }, (_, i) => ({
        documentId: `HD02${i + 1}`,
        documentType: 'mot',
        session: '2025/26',
        designation: String(i + 1),
        title: `Syntetisk motion ${i + 1} om klimat`,
        subtitle: 'av Syntetisk Ledamot (S)',
        date: '2025-10-06',
        sourceUrl: `https://data.riksdagen.se/dokument/HD02${i + 1}.html`,
        statusUrl: `https://data.riksdagen.se/dokumentstatus/HD02${i + 1}.json`,
      })),
      page: 1,
      pageSize: 10,
      returnedCount: 10,
      offset: 0,
      remoteReturnedCount: 10,
      revision: '5e86617ff50ea0e32ff26b42472e7917d5f367e1962ee243c351fbe0441f7913',
      totalCount: 22581,
      hasMore: true,
      nextCall: {
        toolName: 'riksdag_search_documents',
        args: { query: 'klimat', sort: 'relevance', page: 2, pageSize: 10, offset: 0 },
      },
    });
  });
  it('skips member-profile rows with a counting notice on both surfaces and offsets over documents', async () => {
    const rows = [
      ...[1, 2, 3, 4, 5].map((i) => fullTextRow(i)),
      memberProfileRow(1),
      memberProfileRow(2),
      ...[6, 7, 8].map((i) => fullTextRow(i)),
    ];
    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(fullTextPage(rows)));
    initRiksdagService({ fetch: network });
    const result = await runToolContract(riksdagSearchDocuments, { query: 'klimat' });
    const enrichment = assertSuccess(result);
    const page = riksdagSearchDocuments.output.parse(result.structuredContent);
    expect(domainText(result)).toEqual(page);
    const notice =
      'Skipped 2 member-profile rows the source returned among these documents; offset indexes documents only, and totalCount still counts the skipped rows. Find members with riksdag_search_members.';
    expect(enrichment.notices).toEqual([notice]);
    expect(page).toMatchObject({
      returnedCount: 8,
      remoteReturnedCount: 8,
      totalCount: 22581,
      hasMore: true,
      nextCall: { args: { page: 2, pageSize: 10, offset: 0 } },
    });
    expect(page.items.map((row) => row.documentId)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `HD02${i}`),
    );
    const continued = await runToolContract(riksdagSearchDocuments, {
      query: 'klimat',
      offset: 6,
      revision: page.revision,
    });
    expect(assertSuccess(continued).notices).toEqual([notice]);
    expect(riksdagSearchDocuments.output.parse(continued.structuredContent)).toMatchObject({
      offset: 6,
      returnedCount: 2,
      remoteReturnedCount: 8,
      revision: page.revision,
      items: [{ documentId: 'HD027' }, { documentId: 'HD028' }],
    });
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('names a single skipped member-profile row in the singular', async () => {
    initRiksdagService({
      fetch: async () =>
        Response.json({ dokumentlista: { '@traffar': '1', dokument: memberProfileRow(1) } }),
    });
    const result = await runToolContract(riksdagSearchDocuments, { query: 'klimat' });
    expect(assertSuccess(result).notices).toEqual([
      'Skipped 1 member-profile row the source returned among these documents; offset indexes documents only, and totalCount still counts the skipped rows. Find members with riksdag_search_members.',
    ]);
    expect(riksdagSearchDocuments.output.parse(result.structuredContent)).toMatchObject({
      items: [],
      totalCount: 1,
      hasMore: false,
    });
  });
  it('continues past a page holding only member-profile rows without claiming no matches', async () => {
    initRiksdagService({
      fetch: async () => Response.json(fullTextPage([memberProfileRow(1), memberProfileRow(2)], 3)),
    });
    const result = await runToolContract(riksdagSearchDocuments, {
      query: 'klimat',
      page: 3,
      pageSize: 2,
    });
    const enrichment = assertSuccess(result);
    const page = riksdagSearchDocuments.output.parse(result.structuredContent);
    expect(domainText(result)).toEqual(page);
    expect(enrichment.notices).toEqual([
      'Skipped 2 member-profile rows the source returned among these documents; offset indexes documents only, and totalCount still counts the skipped rows. Find members with riksdag_search_members.',
    ]);
    expect(page).toMatchObject({
      items: [],
      returnedCount: 0,
      remoteReturnedCount: 0,
      hasMore: true,
      nextCall: { args: { page: 4, pageSize: 2, offset: 0 } },
    });
  });
  it('gives a page with a skipped member-profile row the revision of its document rows alone', async () => {
    const documents = [1, 2, 3].map((i) => fullTextRow(i));
    const revisions = [];
    // No published hit count: it would count the profile row and so differ between the two pages.
    for (const rows of [[documents[0], memberProfileRow(1), ...documents.slice(1)], documents]) {
      initRiksdagService({
        fetch: async () => Response.json({ dokumentlista: { dokument: rows } }),
      });
      const result = await runToolContract(riksdagSearchDocuments, { query: 'klimat' });
      const page = riksdagSearchDocuments.output.parse(result.structuredContent);
      expect(page.remoteReturnedCount).toBe(3);
      revisions.push(page.revision);
    }
    expect(revisions[0]).toBe(revisions[1]);
  });
});
describe('calendar and web-page rows in listings', () => {
  const record = (id: string, traff: number) => ({
    database: 'dokument',
    dok_id: id,
    doktyp: 'utskottsmöte',
    rm: '2025/26',
    beteckning: id.slice(4),
    titel: 'Utrikesutskottets sammanträde',
    datum: '2026-10-20 11:00:00',
    traff: String(traff),
  });
  const calendar = (id: string, traff: number, datum: string) => ({
    database: 'kalender',
    dok_id: id,
    doktyp: 'kal-vi',
    rm: '2025/26',
    titel: 'Visning av konsten i Riksdagshuset',
    datum,
    traff: String(traff),
  });
  const webPage = (traff: number) => ({
    database: 'episerver',
    dok_id: `515a17de-c53e-4f2f-9372-077d1e6b3e7${traff}`,
    doktyp: '',
    titel: 'Nu räknas rösterna',
    traff: String(traff),
  });
  const cancelled = (traff: number) => ({
    database: 'kalender',
    dok_id: '',
    id: 'rd',
    doktyp: 'kam-ip',
    rm: '2025/26',
    titel: 'INSTÄLLT - Interpellationsdebatt',
    traff: String(traff),
  });
  it.each([1, 2])(
    'names %i skipped, listed and merged rows of each kind on both surfaces',
    async (n) => {
      const rows = [
        record('HDA3UU1', 1),
        ...Array.from({ length: n }, (_, i) => webPage(2 + i)),
        ...Array.from({ length: n }, (_, i) =>
          calendar(`HEC42026110${2 + i}vi1-u2634${i}`, 4 + i, '2026-12-14'),
        ),
        ...Array.from({ length: n + 1 }, (_, i) =>
          calendar('HDC420260425vi4', 6, `2026-04-2${5 + i}`),
        ),
        { ...memberProfileRow(1), traff: '7' },
        ...(n === 2 ? [{ ...memberProfileRow(2), traff: '8' }] : []),
        ...Array.from({ length: n }, (_, i) => cancelled(9 + i)),
      ];
      initRiksdagService({
        fetch: async () =>
          Response.json({ dokumentlista: { '@traffar': String(2 + 4 * n), dokument: rows } }),
      });
      const result = await runToolContract(riksdagSearchDocuments, { session: '2025/26' });
      const enrichment = assertSuccess(result);
      const page = riksdagSearchDocuments.output.parse(result.structuredContent);
      expect(domainText(result)).toEqual(page);
      const rowWord = n === 1 ? 'row' : 'rows';
      expect(enrichment.notices).toEqual([
        `Skipped ${n} member-profile ${rowWord} the source returned among these documents; offset indexes documents only, and totalCount still counts the skipped rows. Find members with riksdag_search_members.`,
        `Skipped ${n} web-page ${rowWord} the source returned among these documents; offset indexes documents only, and totalCount still counts the skipped rows.`,
        `Skipped ${n} calendar ${rowWord} with no record ID (such as cancelled entries) the source returned among these documents; offset indexes documents only, and totalCount still counts the skipped rows.`,
        `Listed ${n} calendar ${rowWord} for single event occurrences (IDs ending in -u and a number) under their event's record ID, which riksdag_get_document reads; each record keeps the date of its first listed row.`,
        `Merged ${n} repeated ${rowWord} into the records they repeat: the source lists a recurring event once per occurrence date and some records again as calendar entries. Each record appears once, at its first position, and offset indexes the records returned.`,
      ]);
      const occurrences = Array.from({ length: n }, (_, i) => `HEC42026110${2 + i}VI1`);
      expect(page.items.map((item) => item.documentId)).toEqual([
        'HDA3UU1',
        ...occurrences,
        'HDC420260425VI4',
      ]);
      expect(page).toMatchObject({
        returnedCount: 2 + n,
        remoteReturnedCount: 2 + n,
        hasMore: false,
      });
    },
  );
});
describe('SFS N-series identifiers', () => {
  const nSeries = {
    dok_id: 'sfs-N2026-7',
    typ: 'sfs',
    doktyp: 'sfs',
    subtyp: 'sfst',
    rm: '2026',
    beteckning: 'N2026:7',
    titel: 'Förordning om upphävande av syntetiska föreskrifter',
    organ: 'Socialdepartementet',
    datum: '2026-10-15 00:00:00',
  };
  it('returns an N-series row among the newest SFS search rows', async () => {
    initRiksdagService({
      fetch: async () =>
        Response.json({
          dokumentlista: {
            '@traffar': '2',
            '@sida': '1',
            dokument: [{ ...nSeries, dok_id: 'sfs-2026-1865', beteckning: '2026:1865' }, nSeries],
          },
        }),
    });
    const result = await runToolContract(riksdagSearchDocuments, { documentType: 'sfs' });
    assertSuccess(result);
    const page = riksdagSearchDocuments.output.parse(result.structuredContent);
    expect(domainText(result)).toEqual(page);
    expect(page.items).toMatchObject([
      { documentId: 'sfs-2026-1865', designation: '2026:1865' },
      {
        documentId: 'sfs-N2026-7',
        designation: 'N2026:7',
        session: '2026',
        statusUrl: 'https://data.riksdagen.se/dokumentstatus/sfs-N2026-7.json',
        versionKind: 'consolidated',
      },
    ]);
  });
  it('reads an N-series record by its document ID', async () => {
    const paths: string[] = [];
    initRiksdagService({
      fetch: async (request) => {
        paths.push(new URL(String(request)).pathname);
        return Response.json({ dokumentstatus: { dokument: { ...nSeries, text: '' } } });
      },
    });
    const result = await runToolContract(riksdagGetDocument, { documentId: 'sfs-N2026-7' });
    assertSuccess(result);
    expect(paths).toEqual(['/dokumentstatus/sfs-N2026-7.json']);
    expect(result.structuredContent).toMatchObject({
      found: true,
      documentId: 'sfs-N2026-7',
      metadata: { documentId: 'sfs-N2026-7', designation: 'N2026:7', versionKind: 'consolidated' },
      textAvailable: false,
    });
    expect(result.structuredContent).not.toHaveProperty('relatedSpeechesCall');
  });
});

describe('vote-record identifiers', () => {
  /** Identity fields of the published H6190118-1 status record, with a synthetic short body. */
  const voteRecord = {
    dok_id: 'H6190118-1',
    rm: '2018/19',
    beteckning: '0118-1',
    typ: 'votering',
    subtyp: 'huvudvotering',
    doktyp: 'votering',
    organ: '-',
    nummer: '1',
    datum: '2019-01-18 00:00:00',
    titel: 'Omröstning: Prövning den 18 januari av förslag till statsminister',
    dokument_url_html: 'https://data.riksdagen.se/dokument/H6190118-1',
    dokument_url_text: 'https://data.riksdagen.se/dokument/H6190118-1/text',
    html: '<div class="votprot"><h2>Omröstning</h2><p>Syntetisk sammanfattning</p></div>',
  };
  it('reads a point-zero vote record by its document ID in any case', async () => {
    const paths: string[] = [];
    initRiksdagService({
      fetch: async (request) => {
        paths.push(new URL(String(request)).pathname);
        return Response.json({ dokumentstatus: { dokument: voteRecord } });
      },
    });
    const result = await runToolContract(riksdagGetDocument, { documentId: ' h6190118-1 ' });
    assertSuccess(result);
    const page = riksdagGetDocument.output.parse(result.structuredContent);
    expect(domainText(result)).toEqual(page);
    expect(paths).toEqual(['/dokumentstatus/H6190118-1.json']);
    expect(page).toMatchObject({
      found: true,
      documentId: 'H6190118-1',
      metadata: {
        documentId: 'H6190118-1',
        documentType: 'votering',
        subtype: 'huvudvotering',
        session: '2018/19',
        designation: '0118-1',
        statusUrl: 'https://data.riksdagen.se/dokumentstatus/H6190118-1.json',
      },
    });
    expect(page.text).toContain('Syntetisk sammanfattning');
    expect(page).not.toHaveProperty('relatedSpeechesCall');
  });
  it('returns vote-record rows of both ID forms among document search rows', async () => {
    initRiksdagService({
      fetch: async () =>
        Response.json({
          dokumentlista: {
            '@traffar': '2',
            '@sida': '1',
            dokument: [
              { ...voteRecord, dok_id: 'H619UU8p8', beteckning: 'UU8', organ: 'UU' },
              { ...voteRecord, dokument_url_html: '//data.riksdagen.se/dokument/H6190118-1.html' },
            ],
          },
        }),
    });
    const result = await runToolContract(riksdagSearchDocuments, {
      documentType: 'votering',
      session: '2018/19',
    });
    assertSuccess(result);
    const page = riksdagSearchDocuments.output.parse(result.structuredContent);
    expect(domainText(result)).toEqual(page);
    expect(page.items).toMatchObject([
      { documentId: 'H619UU8P8', designation: 'UU8' },
      {
        documentId: 'H6190118-1',
        designation: '0118-1',
        documentType: 'votering',
        statusUrl: 'https://data.riksdagen.se/dokumentstatus/H6190118-1.json',
      },
    ]);
  });
});

describe('related speeches chain', () => {
  function statusOf(dokument: Record<string, unknown>) {
    return { dokumentstatus: { dokument: { dok_id: 'HC01KU1', ...dokument } } };
  }
  it.each([
    { doktyp: 'bet', sections: undefined },
    { doktyp: 'bet', sections: [] },
    { doktyp: 'ip', sections: ['activities' as const] },
  ])(
    'offers relatedSpeechesCall for $doktyp records whatever $sections selects',
    async ({ doktyp, sections }) => {
      initRiksdagService({
        fetch: async () => Response.json(statusOf({ doktyp, rm: '2024/25', beteckning: 'KU1' })),
      });
      const result = await runToolContract(riksdagGetDocument, {
        documentId: 'hc01ku1',
        ...(sections === undefined ? {} : { sections }),
      });
      assertSuccess(result);
      const page = riksdagGetDocument.output.parse(result.structuredContent);
      expect(domainText(result)).toEqual(page);
      expect(page.relatedSpeechesCall).toEqual({
        toolName: 'riksdag_search_speeches',
        args: { session: '2024/25', relatedDocumentId: 'HC01KU1' },
      });
    },
  );
  it.each([
    { name: 'a motion', dokument: { doktyp: 'mot', rm: '2024/25' } },
    { name: 'a report without a session', dokument: { doktyp: 'bet' } },
    { name: 'a record without a type', dokument: { rm: '2024/25' } },
  ])('omits relatedSpeechesCall for $name', async ({ dokument }) => {
    initRiksdagService({ fetch: async () => Response.json(statusOf(dokument)) });
    const result = await runToolContract(riksdagGetDocument, { documentId: 'HC01KU1' });
    assertSuccess(result);
    expect(result.structuredContent).not.toHaveProperty('relatedSpeechesCall');
    expect(domainText(result)).not.toHaveProperty('relatedSpeechesCall');
  });
  it('omits relatedSpeechesCall for a missing record', async () => {
    initRiksdagService({ fetch: async () => new Response('', { status: 404 }) });
    const result = await runToolContract(riksdagGetDocument, { documentId: 'HC01KU1' });
    assertSuccess(result);
    expect(result.structuredContent).toMatchObject({ found: false });
    expect(result.structuredContent).not.toHaveProperty('relatedSpeechesCall');
  });
  it('follows relatedSpeechesCall unchanged to exactly the linked speeches', async () => {
    const rows = [
      { ...speechRow(1), rel_dok_id: 'HC01KU1' },
      { ...speechRow(2), rel_dok_id: 'HC01KU2' },
      { ...speechRow(3), rel_dok_id: 'HC01KU0, HC01KU1' },
      { ...speechRow(4) },
    ];
    const paths: string[] = [];
    initRiksdagService({
      fetch: async (request) => {
        const url = new URL(String(request));
        paths.push(url.pathname);
        if (url.pathname.startsWith('/dokumentstatus/')) return Response.json(reportFixture());
        if (url.pathname === '/anforandelista/')
          return Response.json({ anforandelista: { '@antal': '4', anforande: rows } });
        const number = Number(url.pathname.match(/-(\d+)\.json$/)?.[1]);
        return Response.json({
          anforande: { ...rows[number - 1], anforandetext: `<p>Anförande ${number}</p>` },
        });
      },
    });
    const document = riksdagGetDocument.output.parse(
      (await runToolContract(riksdagGetDocument, { documentId: 'HC01KU1', sections: [] }))
        .structuredContent,
    );
    const result = await followCall(riksdagSearchSpeeches, document.relatedSpeechesCall);
    const speeches = riksdagSearchSpeeches.output.parse(result.structuredContent);
    expect(speeches.items?.map((item) => item.speechId)).toEqual(['HC091-1', 'HC091-3']);
    expect(paths.filter((path) => path === '/anforandelista/')).toHaveLength(1);
  });
});

describe('caller limits are the only page boundaries', () => {
  it('returns all 50 documents of a heavy remote page and continues on the next remote page', async () => {
    initRiksdagService({
      fetch: async (request) =>
        Response.json(motionSearch(Number(new URL(String(request)).searchParams.get('p')))),
    });
    const result = await runToolContract(riksdagSearchDocuments, {
      documentType: 'mot',
      session: '2024/25',
      pageSize: 50,
    });
    const enrichment = assertSuccess(result);
    const page = riksdagSearchDocuments.output.parse(result.structuredContent);
    expect(domainText(result)).toEqual(page);
    expect(page.returnedCount).toBe(50);
    expect(page.items.map((row) => row.documentId)).toEqual(
      Array.from({ length: 50 }, (_, i) => `HC02${i + 1}`),
    );
    expect(result.structuredContent).not.toHaveProperty('truncated');
    expect(domainText(result)).not.toHaveProperty('truncated');
    expect(enrichment.notices.filter((notice) => shorteningNotice.test(notice))).toEqual([]);
    expect(page.nextCall).toEqual({
      toolName: 'riksdag_search_documents',
      args: expect.objectContaining({ page: 2, pageSize: 50, offset: 0 }),
    });
    const second = riksdagSearchDocuments.output.parse(
      (await followCall(riksdagSearchDocuments, page.nextCall)).structuredContent,
    );
    expect(second).toMatchObject({ page: 2, returnedCount: 50, hasMore: true });
    expect(second.items[0]?.documentId).toBe('HC0251');
    const third = riksdagSearchDocuments.output.parse(
      (await followCall(riksdagSearchDocuments, second.nextCall)).structuredContent,
    );
    expect(third).toMatchObject({ page: 3, returnedCount: 20, hasMore: false });
    expect(third.items.at(-1)?.documentId).toBe('HC02120');
    expect(third.nextCall).toBeUndefined();
  });
  /** Serves `motionSearch` the way the source pages: any `sz` above 200 returns 200 rows. */
  function motionSource(total: number, requests: URL[] = []): typeof fetch {
    return async (request) => {
      const url = new URL(String(request));
      requests.push(url);
      return Response.json(
        motionSearch(
          Number(url.searchParams.get('p')),
          total,
          Math.min(Number(url.searchParams.get('sz')), 200),
        ),
      );
    };
  }
  it.each([
    { requested: 51, applied: 51 },
    { requested: 137, applied: 137 },
    { requested: 200, applied: 200 },
    { requested: 201, applied: 200 },
  ])('applies pageSize $requested as $applied source rows', async ({ requested, applied }) => {
    const requests: URL[] = [];
    initRiksdagService({ fetch: motionSource(905, requests) });
    const result = await runToolContract(riksdagSearchDocuments, {
      documentType: 'mot',
      session: '2024/25',
      pageSize: requested,
    });
    const enrichment = assertSuccess(result);
    const page = riksdagSearchDocuments.output.parse(result.structuredContent);
    expect(domainText(result)).toEqual(page);
    expect(requests.map((url) => url.searchParams.get('sz'))).toEqual([String(applied)]);
    expect(page).toMatchObject({
      pageSize: applied,
      returnedCount: applied,
      remoteReturnedCount: applied,
      totalCount: 905,
      hasMore: true,
      nextCall: { args: { page: 2, pageSize: applied, offset: 0 } },
    });
    expect(enrichment.notices.filter((notice) => notice.includes('clamped'))).toEqual(
      requested > 200 ? ['Requested pageSize was clamped to 200.'] : [],
    );
  });
  it('returns every hit once in ceil(totalCount / 200) calls at the 200-row ceiling', async () => {
    const requests: URL[] = [];
    initRiksdagService({ fetch: motionSource(905, requests) });
    let result = await runToolContract(riksdagSearchDocuments, {
      documentType: 'mot',
      session: '2024/25',
      pageSize: 200,
    });
    const ids: string[] = [];
    for (let call = 1; ; call++) {
      assertSuccess(result);
      const page = riksdagSearchDocuments.output.parse(result.structuredContent);
      expect(domainText(result)).toEqual(page);
      ids.push(...page.items.map((row) => row.documentId));
      if (!page.nextCall) {
        expect(call).toBe(5);
        break;
      }
      expect(page.nextCall.args).toMatchObject({ page: call + 1, pageSize: 200, offset: 0 });
      result = await followCall(riksdagSearchDocuments, page.nextCall);
    }
    expect(ids).toEqual(Array.from({ length: 905 }, (_, i) => `HC02${i + 1}`));
    expect(requests.map((url) => url.searchParams.get('sz'))).toEqual(Array(5).fill('200'));
  });
  it('resolves an in-page offset with its revision on a 200-row page and rejects a changed page', async () => {
    let title = 'Ett';
    const network = vi.fn<typeof fetch>().mockImplementation(async (request) => {
      const body = motionSearch(Number(new URL(String(request)).searchParams.get('p')), 905, 200);
      body.dokumentlista.dokument[0]!.titel = title;
      return Response.json(body);
    });
    initRiksdagService({ fetch: network });
    const filters = { documentType: 'mot', session: '2024/25', pageSize: 200 };
    const first = riksdagSearchDocuments.output.parse(
      (await runToolContract(riksdagSearchDocuments, filters)).structuredContent,
    );
    const continued = await runToolContract(riksdagSearchDocuments, {
      ...filters,
      offset: 150,
      revision: first.revision,
    });
    assertSuccess(continued);
    const page = riksdagSearchDocuments.output.parse(continued.structuredContent);
    expect(domainText(continued)).toEqual(page);
    expect(page).toMatchObject({
      offset: 150,
      returnedCount: 50,
      remoteReturnedCount: 200,
      revision: first.revision,
      nextCall: { args: { page: 2, pageSize: 200, offset: 0 } },
    });
    expect(page.items).toEqual(first.items.slice(150));
    expect(network).toHaveBeenCalledTimes(1);
    title = 'Ändrad';
    initRiksdagService({ fetch: network });
    const changed = await runToolContract(riksdagSearchDocuments, {
      ...filters,
      offset: 150,
      revision: first.revision,
    });
    expect(changed).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: JsonRpcErrorCode.Conflict, data: { reason: 'revision_changed' } },
      },
    });
  });
  it('returns every selected section of a heavy report complete with no shortening notices', async () => {
    const fixture = reportFixture(3);
    for (const decision of fixture.dokumentstatus.dokutskottsforslag.utskottsforslag)
      decision.forslag = `<p>${'ä'.repeat(1200)}</p>`;
    const status = fixture.dokumentstatus as Record<string, unknown>;
    status.dokaktivitet = {
      aktivitet: Array.from({ length: 7 }, (_, i) => ({
        kod: `A${i + 1}`,
        namn: `Händelse ${i + 1}`,
      })),
    };
    status.dokreferens = {
      referens: Array.from({ length: 13 }, (_, i) => ({
        referenstyp: 'behandlar',
        ref_dok_id: `HC02${i + 1}`,
        ref_dok_titel: `Motion ${i + 1}`,
      })),
    };
    initRiksdagService({ fetch: async () => Response.json(fixture) });
    const result = await runToolContract(riksdagGetDocument, {
      documentId: 'HC01KU1',
      sections: ['decisions', 'reservations', 'activities', 'references'],
    });
    const enrichment = assertSuccess(result);
    const page = riksdagGetDocument.output.parse(result.structuredContent);
    expect(domainText(result)).toEqual(page);
    expect(page.decisions).toHaveLength(3);
    expect(page.reservations).toHaveLength(3);
    expect(page.activities).toHaveLength(7);
    expect(page.references).toHaveLength(13);
    expect(page.truncated).toBe(false);
    expect(page.sectionPages).toEqual(
      [
        ['decisions', 3],
        ['reservations', 3],
        ['activities', 7],
        ['references', 13],
      ].map(([section, count]) => ({
        section,
        totalCount: count,
        offset: 0,
        limit: 20,
        requestedLimit: 20,
        returnedCount: count,
        hasMore: false,
      })),
    );
    for (const surface of [result.structuredContent, domainText(result)])
      for (const entry of (surface as { sectionPages: object[] }).sectionPages)
        expect(entry).not.toHaveProperty('truncated');
    expect(enrichment.notices.filter((notice) => shorteningNotice.test(notice))).toEqual([]);
  });
  it('resolves an in-page offset continuation against its remote-page revision', async () => {
    let title = 'Ett';
    initRiksdagService({
      fetch: async () =>
        Response.json({
          dokumentlista: {
            '@traffar': '5',
            '@sida': '1',
            dokument: [
              { dok_id: 'HC01KU1', titel: title },
              { dok_id: 'HC01KU2', titel: 'Två' },
              { dok_id: 'HC01KU3', titel: 'Tre' },
            ],
          },
        }),
    });
    const first = riksdagSearchDocuments.output.parse(
      (await runToolContract(riksdagSearchDocuments, { query: 'ord', pageSize: 3 }))
        .structuredContent,
    );
    const continued = await runToolContract(riksdagSearchDocuments, {
      query: 'ord',
      pageSize: 3,
      offset: 1,
      revision: first.revision,
    });
    assertSuccess(continued);
    const page = riksdagSearchDocuments.output.parse(continued.structuredContent);
    expect(domainText(continued)).toEqual(page);
    expect(page).toMatchObject({
      offset: 1,
      returnedCount: 2,
      remoteReturnedCount: 3,
      revision: first.revision,
      items: [{ documentId: 'HC01KU2' }, { documentId: 'HC01KU3' }],
      nextCall: { args: { page: 2, pageSize: 3, offset: 0 } },
    });
    expect(page.nextCall?.args).not.toHaveProperty('revision');
    expect(
      riksdagSearchDocuments.input.strict().safeParse(page.nextCall?.args).error,
    ).toBeUndefined();
    getRiksdagService().dispose();
    title = 'Ändrad';
    initRiksdagService({
      fetch: async () =>
        Response.json({
          dokumentlista: {
            '@traffar': '5',
            '@sida': '1',
            dokument: [
              { dok_id: 'HC01KU1', titel: title },
              { dok_id: 'HC01KU2', titel: 'Två' },
              { dok_id: 'HC01KU3', titel: 'Tre' },
            ],
          },
        }),
    });
    const changed = await runToolContract(riksdagSearchDocuments, {
      query: 'ord',
      pageSize: 3,
      offset: 1,
      revision: first.revision,
    });
    expect(changed).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: JsonRpcErrorCode.Conflict, data: { reason: 'revision_changed' } },
      },
    });
  });
});

describe("the source's 10,000-row search window", () => {
  /**
   * Serves `motionSearch` the way the list route pages: a page ending past row 10,000 is an HTTP
   * 400, and the next-page link is published while hits remain, even when it points past the window.
   */
  function windowSource(total: number, requests: URL[] = []): typeof fetch {
    return async (request) => {
      const url = new URL(String(request));
      requests.push(url);
      const page = Number(url.searchParams.get('p'));
      const size = Number(url.searchParams.get('sz'));
      if (page * size > 10_000)
        return new Response('Bad Request', {
          status: 400,
          headers: { 'content-type': 'text/html' },
        });
      const body = motionSearch(page, total, size);
      return Response.json(
        page * size < total
          ? {
              dokumentlista: {
                ...body.dokumentlista,
                '@nasta_sida': `http://data.riksdagen.se/dokumentlista/?sz=${size}&p=${page + 1}&utformat=json`,
              },
            }
          : body,
      );
    };
  }
  const filters = { documentType: 'mot', session: '2024/25' };
  const windowEnd =
    'This page ends at row 10,000, the last row the source serves for one search, and more rows match. Narrow with session, documentType or dateFrom and dateTo to reach them, then start again at page 1.';
  const pastWindow =
    'This page starts after row 10,000, the last row the source serves for one search, so no request was made. Page 1 shows how many rows match; when more than 10,000 do, narrow with session, documentType or dateFrom and dateTo.';
  const remotePages = (requests: URL[]) =>
    requests.map((url) => [url.searchParams.get('p'), url.searchParams.get('sz')]);
  const motionIds = (first: number, last: number) =>
    Array.from({ length: last - first + 1 }, (_, i) => `HC02${first + i}`);

  it.each([
    { pageSize: 200, page: 51 },
    { pageSize: 50, page: 201 },
    { pageSize: 30, page: 335 },
    { pageSize: 1, page: 10_001 },
  ])(
    'answers page $page at pageSize $pageSize, past the window, empty without a request',
    async ({ pageSize, page }) => {
      const network = vi.fn<typeof fetch>().mockImplementation(windowSource(12_345));
      initRiksdagService({ fetch: network });
      const result = await runToolContract(riksdagSearchDocuments, { ...filters, pageSize, page });
      const enrichment = assertSuccess(result);
      const out = riksdagSearchDocuments.output.parse(result.structuredContent);
      expect(domainText(result)).toEqual(out);
      expect(network).not.toHaveBeenCalled();
      expect(enrichment.notices).toEqual([pastWindow]);
      expect(out).toMatchObject({
        items: [],
        page,
        pageSize,
        returnedCount: 0,
        remoteReturnedCount: 0,
        hasMore: false,
      });
      expect(out).not.toHaveProperty('totalCount');
      expect(out.nextCall).toBeUndefined();
    },
  );
  it('stops at the page ending on row 10,000 while more rows match', async () => {
    const requests: URL[] = [];
    initRiksdagService({ fetch: windowSource(12_345, requests) });
    const result = await runToolContract(riksdagSearchDocuments, {
      ...filters,
      pageSize: 200,
      page: 50,
    });
    const enrichment = assertSuccess(result);
    const out = riksdagSearchDocuments.output.parse(result.structuredContent);
    expect(domainText(result)).toEqual(out);
    expect(enrichment.notices).toEqual([windowEnd]);
    expect(out).toMatchObject({
      page: 50,
      pageSize: 200,
      returnedCount: 200,
      totalCount: 12_345,
      hasMore: false,
    });
    expect(out.items.map((row) => row.documentId)).toEqual(motionIds(9801, 10_000));
    expect(out.nextCall).toBeUndefined();
    expect(remotePages(requests)).toEqual([['50', '200']]);
  });
  it.each([
    { pageSize: 30, page: 334, remote: ['1000', '10'], first: 9991 },
    { pageSize: 60, page: 167, remote: ['250', '40'], first: 9961 },
    { pageSize: 7, page: 1429, remote: ['2500', '4'], first: 9997 },
    { pageSize: 193, page: 52, remote: ['50', '200'], first: 9844 },
  ])(
    'reads page $page at pageSize $pageSize, straddling row 10,000, through the page ending there',
    async ({ pageSize, page, remote, first }) => {
      const requests: URL[] = [];
      initRiksdagService({ fetch: windowSource(12_345, requests) });
      const result = await runToolContract(riksdagSearchDocuments, { ...filters, pageSize, page });
      const enrichment = assertSuccess(result);
      const out = riksdagSearchDocuments.output.parse(result.structuredContent);
      expect(domainText(result)).toEqual(out);
      expect(remotePages(requests)).toEqual([remote]);
      expect(enrichment.notices).toEqual([windowEnd]);
      expect(out.items.map((row) => row.documentId)).toEqual(motionIds(first, 10_000));
      expect(out).toMatchObject({
        page,
        pageSize,
        returnedCount: 10_001 - first,
        remoteReturnedCount: 10_001 - first,
        totalCount: 12_345,
        hasMore: false,
      });
      expect(out.nextCall).toBeUndefined();
    },
  );
  it('follows nextCall onto the straddling page and no further', async () => {
    const requests: URL[] = [];
    initRiksdagService({ fetch: windowSource(12_345, requests) });
    const first = riksdagSearchDocuments.output.parse(
      (await runToolContract(riksdagSearchDocuments, { ...filters, pageSize: 30, page: 333 }))
        .structuredContent,
    );
    expect(first).toMatchObject({ returnedCount: 30, hasMore: true });
    expect(first.nextCall?.args).toMatchObject({ page: 334, pageSize: 30, offset: 0 });
    const last = await followCall(riksdagSearchDocuments, first.nextCall);
    const out = riksdagSearchDocuments.output.parse(last.structuredContent);
    expect(out.items.map((row) => row.documentId)).toEqual(motionIds(9991, 10_000));
    expect(out).toMatchObject({ page: 334, hasMore: false });
    expect(out.nextCall).toBeUndefined();
    expect(remotePages(requests)).toEqual([
      ['333', '30'],
      ['1000', '10'],
    ]);
  });
  it('walks onto the straddling page without repeating or losing a hit when pages list hits out of order', async () => {
    /**
     * The source numbers each hit with its row in the whole result (`traff`) and lists some pages by
     * ascending date, so a page's highest-numbered hits can come first.
     */
    const source = windowSource(12_345);
    const requests: URL[] = [];
    initRiksdagService({
      fetch: async (request) => {
        requests.push(new URL(String(request)));
        const response = await source(request);
        if (!response.ok) return response;
        const body = (await response.json()) as ReturnType<typeof motionSearch>;
        const page = Number(body.dokumentlista['@sida']);
        const size = Number(new URL(String(request)).searchParams.get('sz'));
        const numbered = body.dokumentlista.dokument.map((row, i) => ({
          ...row,
          traff: String((page - 1) * size + i + 1),
        }));
        return Response.json({
          dokumentlista: { ...body.dokumentlista, dokument: numbered.reverse() },
        });
      },
    });
    const first = riksdagSearchDocuments.output.parse(
      (await runToolContract(riksdagSearchDocuments, { ...filters, pageSize: 193, page: 51 }))
        .structuredContent,
    );
    const last = riksdagSearchDocuments.output.parse(
      (await followCall(riksdagSearchDocuments, first.nextCall)).structuredContent,
    );
    expect(remotePages(requests)).toEqual([
      ['51', '193'],
      ['50', '200'],
    ]);
    const ids = (page: typeof first) => page.items.map((row) => row.documentId);
    expect(ids(last).toSorted()).toEqual(motionIds(9844, 10_000).toSorted());
    expect([...ids(first), ...ids(last)].toSorted()).toEqual(motionIds(9651, 10_000).toSorted());
    expect(last).toMatchObject({ page: 52, returnedCount: 157, hasMore: false });
  });
  it.each([
    { total: 10_000, pageSize: 200, page: 50, remote: ['50', '200'], first: 9801, last: 10_000 },
    { total: 9995, pageSize: 30, page: 334, remote: ['1000', '10'], first: 9991, last: 9995 },
  ])(
    'adds no window notice when the $total hits end inside the window',
    async ({ total, pageSize, page, remote, first, last }) => {
      const requests: URL[] = [];
      initRiksdagService({ fetch: windowSource(total, requests) });
      const result = await runToolContract(riksdagSearchDocuments, { ...filters, pageSize, page });
      const enrichment = assertSuccess(result);
      const out = riksdagSearchDocuments.output.parse(result.structuredContent);
      expect(enrichment.notices).toEqual([]);
      expect(remotePages(requests)).toEqual([remote]);
      expect(out.items.map((row) => row.documentId)).toEqual(motionIds(first, last));
      expect(out).toMatchObject({ totalCount: total, hasMore: false });
      expect(out.nextCall).toBeUndefined();
    },
  );
});
