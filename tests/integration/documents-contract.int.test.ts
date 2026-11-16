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
import { continuationArgs } from '../services/riksdag/continuation-fixtures.js';
import { reportFixture } from '../services/riksdag/document-fixtures.js';
import { speechRow } from '../services/riksdag/speech-fixtures.js';

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
  it('clamps remote page size and returns every fetched row of the final page', async () => {
    initRiksdagService({
      fetch: async () =>
        Response.json({
          dokumentlista: {
            '@traffar': '50',
            dokument: Array.from({ length: 50 }, (_, i) => ({ dok_id: `HC01KU${i + 1}` })),
          },
        }),
    });
    const result = await runToolContract(riksdagSearchDocuments, { pageSize: 100000 });
    expect(assertSuccess(result).notices.join(' ')).toContain('clamped to 50');
    const first = riksdagSearchDocuments.output.parse(result.structuredContent);
    expect(first.pageSize).toBe(50);
    expect(first.remoteReturnedCount).toBe(50);
    expect(first).toMatchObject({ returnedCount: 50, hasMore: false });
    expect(first.nextCall).toBeUndefined();
    const ids = first.items.map((row) => row.documentId);
    let next = first.nextCall;
    while (next) {
      expect(next.args).toMatchObject({ page: 1, pageSize: 50, revision: first.revision });
      const continued = await runToolContract(riksdagSearchDocuments, next.args);
      const page = riksdagSearchDocuments.output.parse(continued.structuredContent);
      expect(domainText(continued)).toEqual(page);
      ids.push(...page.items.map((row) => row.documentId));
      next = page.nextCall;
    }
    expect(ids).toEqual(Array.from({ length: 50 }, (_, i) => `HC01KU${i + 1}`));
    expect(domainText(result)).toEqual(
      riksdagSearchDocuments.output.parse(result.structuredContent),
    );
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
