/** @fileoverview Document wire-to-tool dual-surface contracts. @module tests/integration/documents-contract */
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { riksdagGetDocument } from '@/mcp-server/tools/definitions/get-document.tool.js';
import { riksdagSearchDocuments } from '@/mcp-server/tools/definitions/search-documents.tool.js';
import { successEnrichment } from '@/services/riksdag/output.js';
import { getRiksdagService, initRiksdagService } from '@/services/riksdag/riksdag-service.js';
import { reportFixture } from '../services/riksdag/document-fixtures.js';

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

describe('document public contract', () => {
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
  it.each(['schema', 'identity', 'unknown_section', 'invalid_filter', 'http404'])(
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
              documentId: kind === 'invalid_filter' ? 'KU1' : 'HC01KU1',
              ...(kind === 'unknown_section' ? { sections: ['other'] } : {}),
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
      if (kind === 'invalid_filter' || kind === 'unknown_section')
        expect(network).not.toHaveBeenCalled();
    },
  );
  it('fits complete section entries with disclosure and leaves oversized entries intact', async () => {
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
    expect(page.truncated).toBe(true);
    expect(page.activities?.length).toBeLessThan(3);
    expect(page.activities?.[0]?.name).toBe(`${'x'.repeat(4000)}A1`);
    expect(page.sectionPages?.[0]?.nextCall?.args.sectionOffset).toBe(page.activities?.length);
    expect(enrichment.notices.join(' ')).toContain('shortened');
    expect(domainText(result)).toEqual(page);
    const huge = reportFixture(1);
    huge.dokumentstatus.dokaktivitet.aktivitet[0]!.namn = 'x'.repeat(20000);
    initRiksdagService({ fetch: async () => Response.json(huge) });
    const oversized = await runToolContract(riksdagGetDocument, {
      documentId: 'HC01KU1',
      sections: ['activities'],
    });
    expect(assertSuccess(oversized).notices.join(' ')).toContain('indivisible entry');
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
      sectionLimit: 101,
    });
    const enrichment = assertSuccess(result);
    expect(result.structuredContent).toMatchObject({
      text,
      textReturnedLength: 12000,
      textHasMore: false,
      sectionPages: [{ limit: 100, requestedLimit: 101 }],
    });
    expect(enrichment.notices.join(' ')).toContain('explicit textLength');
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
      },
    });
    expect(String(network.mock.calls[0]?.[0])).toBe(
      'https://data.riksdagen.se/dokumentlista/?doktyp=bet&from=1999-01-01&org=KU&p=1&parti=S&rm=1999%2F2000&sok=budget&sz=2&tom=2000-12-31&utformat=json',
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
      'https://data.riksdagen.se/dokumentlista/?p=1&sz=10&utformat=json',
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
  it('returns an oversized remote page intact with unchanged page size and complete continuation', async () => {
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
      items: [{ title }, { title }],
      nextCall: { args: { page: 2, pageSize: 2 } },
    });
    expect(domainText(result)).toEqual(page);
    expect(enrichment.notices.join(' ')).toContain('returned intact');
  });
  it('clamps remote page size explicitly without shortening the fetched 50 rows', async () => {
    initRiksdagService({
      fetch: async () =>
        Response.json({
          dokumentlista: {
            '@traffar': '50',
            dokument: Array.from({ length: 50 }, (_, i) => ({ dok_id: `HC01KU${i + 1}` })),
          },
        }),
    });
    const result = await runToolContract(riksdagSearchDocuments, { pageSize: 101 });
    expect(assertSuccess(result).notices.join(' ')).toContain('clamped to 50');
    expect(result.structuredContent).toMatchObject({
      pageSize: 50,
      returnedCount: 50,
      hasMore: false,
    });
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
        const result = await runToolContract(riksdagGetDocument, next.args);
        assertSuccess(result);
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
      let args = riksdagGetDocument.input.parse({
        documentId: 'HC01KU1',
        sections: [representation],
        textLength: 3,
        htmlLength: 3,
      });
      let combined = '';
      for (;;) {
        const result = await runToolContract(riksdagGetDocument, args);
        assertSuccess(result);
        const page = riksdagGetDocument.output.parse(result.structuredContent);
        expect(domainText(result)).toEqual(page);
        combined += representation === 'text' ? page.text : page.sourceHtml;
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
      expect(combined).toBe(
        representation === 'text'
          ? '# Rubrik 😀\n\nFörsta stycket.\n\nAndra stycket.'
          : '<h1>Rubrik 😀</h1><p>Första stycket.</p><p>Andra stycket.</p>',
      );
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
    const changed = await runToolContract(riksdagGetDocument, page.nextTextCall!.args);
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
