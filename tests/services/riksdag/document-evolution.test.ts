/** @fileoverview Document source variants and complete public continuation. @module tests/services/riksdag/document-evolution */
import { z } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { riksdagGetDocument } from '@/mcp-server/tools/definitions/get-document.tool.js';
import { riksdagSearchDocuments } from '@/mcp-server/tools/definitions/search-documents.tool.js';
import { successEnrichment } from '@/services/riksdag/output.js';
import { getRiksdagService, initRiksdagService } from '@/services/riksdag/riksdag-service.js';

afterEach(() => {
  vi.useRealTimers();
  getRiksdagService().dispose();
});
function status(extra: Record<string, unknown> = {}) {
  return { dokumentstatus: { dokument: { dok_id: 'HC01KU1' }, ...extra } };
}
function publicDomain(result: Awaited<ReturnType<typeof runToolContract>>) {
  expect(result.isError).not.toBe(true);
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('Expected text');
  const newline = first.text.indexOf('\n');
  const fence = first.text.slice(0, newline).replace(/json$/, '');
  return JSON.parse(first.text.slice(newline + 1, first.text.indexOf(`\n${fence}`, newline)));
}
describe('document source evolution', () => {
  it.each([
    { raw: { undertitel: 'List', subtitel: 'Status' }, list: 'List', detail: 'Status' },
    { raw: { undertitel: ' ', subtitel: 'Status' }, list: 'Status', detail: 'Status' },
    { raw: { undertitel: 'List', subtitel: ' ' }, list: 'List', detail: 'List' },
    { raw: { undertitel: '', subtitel: ' ' }, list: undefined, detail: undefined },
    { raw: {}, list: undefined, detail: undefined },
  ])('retains list and status subtitle precedence %j', async ({ raw, list, detail }) => {
    const document = { dok_id: 'sfs-2000-100', doktyp: 'sfs', ...raw };
    initRiksdagService({
      fetch: async (request) =>
        Response.json(
          new URL(String(request)).pathname === '/dokumentlista/'
            ? { dokumentlista: { dokument: document } }
            : { dokumentstatus: { dokument: document } },
        ),
    });
    const search = await runToolContract(riksdagSearchDocuments, {});
    const searchDomain = publicDomain(search);
    expect(searchDomain.items[0].subtitle).toBe(list);
    expect(searchDomain.items[0].consolidationLabel).toBe(list);
    expect(search.structuredContent).toMatchObject(searchDomain);
    const statusResult = await runToolContract(riksdagGetDocument, {
      documentId: 'sfs-2000-100',
      sections: ['metadata'],
    });
    const statusDomain = publicDomain(statusResult);
    expect(statusDomain.metadata.subtitle).toBe(detail);
    expect(statusDomain.metadata.consolidationLabel).toBe(detail);
    expect(statusResult.structuredContent).toMatchObject(statusDomain);
  });
  it('preserves modern table arrays, historical singleton and empty table arrays', async () => {
    const modern = {
      caption: { b: 'A', '#text': 'B' },
      thead: { tr: { th: ['Party', 'Ja'] } },
      tbody: { tr: { th: 'S', td: ['0'] } },
      tfooter: { tr: { th: 'Totalt', td: ['0'] } },
    };
    initRiksdagService({
      fetch: async () =>
        Response.json(
          status({
            dokutskottsforslag: {
              utskottsforslag: [
                { punkt: '1', votering_sammanfattning_html: { table: [modern, modern] } },
                {
                  punkt: '2',
                  votering_sammanfattning_html: {
                    table: {
                      tr: [
                        { td: { h4: 'Historical', p: 'Proposal' } },
                        { th: ['Party', 'Ja'] },
                        { td: ['S', '0'] },
                        { td: ['Totalt', '0'] },
                      ],
                    },
                  },
                },
                { punkt: '3', votering_sammanfattning_html: { table: [] } },
              ],
            },
          }),
        ),
    });
    const result = await runToolContract(riksdagGetDocument, {
      documentId: 'HC01KU1',
      sections: ['decisions'],
    });
    const domain = publicDomain(result);
    expect(result.structuredContent).toMatchObject(domain);
    const normalized = {
      caption: { heading: 'A', text: 'B' },
      columns: ['Party', 'Ja'],
      rows: [{ label: 'S', cells: ['0'] }],
      footer: { label: 'Totalt', cells: ['0'] },
    };
    expect(domain.decisions[0]).toEqual({ point: 1, summaries: [normalized, normalized] });
    expect(domain.decisions[1]).toEqual({
      point: 2,
      summary: {
        heading: 'Historical',
        proposal: 'Proposal',
        columns: ['Party', 'Ja'],
        rows: [{ cells: ['S', '0'] }, { cells: ['Totalt', '0'] }],
      },
    });
    expect(domain.decisions[2]).toEqual({ point: 3, summaries: [] });
  });
  it.each([undefined, null, {}, { intressent: null }, { intressent: { namn: 'Sparse' } }])(
    'accepts sparse stakeholder container %j and terminal offsets',
    async (container) => {
      initRiksdagService({
        fetch: async () =>
          Response.json(status(container === undefined ? {} : { dokintressent: container })),
      });
      const result = await runToolContract(riksdagGetDocument, {
        documentId: 'HC01KU1',
        sections: ['stakeholders'],
        sectionOffset: 100,
        sectionLimit: 101,
      });
      const domain = publicDomain(result);
      expect(result.structuredContent).toMatchObject(domain);
      expect(domain.stakeholders).toEqual([]);
      expect(domain.sectionPages[0]).toMatchObject({
        hasMore: false,
        returnedCount: 0,
        limit: 100,
      });
      expect(String(z.object(successEnrichment).parse(result.structuredContent).notices)).toContain(
        'clamped',
      );
    },
  );
  it.each(['bad', 4, { intressent: 'bad' }, { intressent: [{ namn: 42 }] }])(
    'rejects malformed stakeholder container %j',
    async (container) => {
      initRiksdagService({
        fetch: async () => Response.json(status({ dokintressent: container })),
      });
      const result = await runToolContract(riksdagGetDocument, {
        documentId: 'HC01KU1',
        sections: ['stakeholders'],
      });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: { data: { reason: 'upstream_schema_invalid' } } },
      });
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'text', text: expect.stringContaining('Retry') }),
        ]),
      );
    },
  );
  it('rejects malformed search inputs before fetching', async () => {
    const network = vi.fn<typeof fetch>();
    initRiksdagService({ fetch: network });
    for (const input of [{ memberId: 'x' }, { sort: 'other' }, { offset: -1 }]) {
      const result = await runToolContract<Parameters<typeof runToolContract>[0]>(
        riksdagSearchDocuments,
        input,
      );
      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining('Error'),
      });
    }
    expect(network).not.toHaveBeenCalled();
  });
  it('returns an empty terminal search slice beyond the remote-page end', async () => {
    initRiksdagService({
      fetch: async () =>
        Response.json({ dokumentlista: { '@traffar': '20', dokument: [{ dok_id: 'HC01KU1' }] } }),
    });
    const result = await runToolContract(riksdagSearchDocuments, { offset: 3, pageSize: 1 });
    const domain = publicDomain(result);
    expect(domain).toMatchObject({ items: [], returnedCount: 0, hasMore: false, offset: 3 });
    expect(result.structuredContent).toMatchObject(domain);
    expect(String(z.object(successEnrichment).parse(result.structuredContent).notices)).toContain(
      'beyond',
    );
  });
  it('rejects changed remote-page revisions with recovery on both surfaces', async () => {
    vi.useFakeTimers();
    let title = 'old';
    initRiksdagService({
      fetch: async () =>
        Response.json({
          dokumentlista: { '@traffar': '1', dokument: { dok_id: 'HC01KU1', titel: title } },
        }),
    });
    const first = await runToolContract(riksdagSearchDocuments, {});
    const domain = publicDomain(first);
    title = 'new';
    await vi.advanceTimersByTimeAsync(120001);
    const changed = await runToolContract(riksdagSearchDocuments, { revision: domain.revision });
    expect(changed).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          data: {
            reason: 'revision_changed',
            recovery: { hint: expect.stringContaining('offset zero') },
          },
        },
      },
    });
    expect(changed.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('offset zero'),
    });
  });
  it('rejects malformed stakeholder IDs before caching the status', async () => {
    let calls = 0;
    initRiksdagService({
      fetch: async () => {
        calls++;
        return Response.json(
          status({ dokintressent: { intressent: { intressent_id: 'not-an-IID' } } }),
        );
      },
    });
    for (let i = 0; i < 2; i++) {
      const result = await runToolContract(riksdagGetDocument, {
        documentId: 'HC01KU1',
        sections: ['stakeholders'],
      });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            data: {
              reason: 'upstream_schema_invalid',
              recovery: { hint: expect.stringContaining('Retry') },
            },
          },
        },
      });
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'text', text: expect.stringContaining('Retry') }),
        ]),
      );
    }
    expect(calls).toBe(2);
  });
  it('characterizes modern singleton summaries and plain property values', async () => {
    initRiksdagService({
      fetch: async () =>
        Response.json(
          status({
            dokuppgift: { uppgift: { kod: 'other', text: 'literal <x> &amp;' } },
            dokutskottsforslag: {
              utskottsforslag: {
                punkt: '1',
                votering_sammanfattning_html: {
                  table: {
                    caption: { b: 'Heading', '#text': 'Proposal' },
                    thead: { tr: { th: ['Party', 'Ja'] } },
                    tbody: { tr: { th: 'S', td: ['0', ''] } },
                    tfooter: { tr: { th: 'Totalt', td: ['0'] } },
                  },
                },
              },
            },
          }),
        ),
    });
    const result = await runToolContract(riksdagGetDocument, {
      documentId: 'HC01KU1',
      sections: ['decisions', 'properties'],
    });
    const domain = riksdagGetDocument.output.parse(result.structuredContent);
    expect(publicDomain(result)).toEqual(domain);
    expect(domain.decisions?.[0]?.summary).toEqual({
      caption: { heading: 'Heading', text: 'Proposal' },
      columns: ['Party', 'Ja'],
      rows: [{ label: 'S', cells: ['0', ''] }],
      footer: { label: 'Totalt', cells: ['0'] },
    });
    expect(domain.properties?.[0]?.text).toBe('literal <x> &amp;');
  });
  it('preserves route subtitles with nonblank route-specific precedence', async () => {
    initRiksdagService({
      fetch: async (request) =>
        Response.json(
          new URL(String(request)).pathname === '/dokumentlista/'
            ? {
                dokumentlista: {
                  dokument: { dok_id: 'HC01KU1', undertitel: 'List author', subtitel: 'Fallback' },
                },
              }
            : {
                dokumentstatus: {
                  dokument: {
                    dok_id: 'HC01KU1',
                    doktyp: 'sfs',
                    subtitel: '  ',
                    undertitel: 'Consolidation',
                  },
                },
              },
        ),
    });
    const search = await runToolContract(riksdagSearchDocuments, {});
    expect(publicDomain(search)).toMatchObject({ items: [{ subtitle: 'List author' }] });
    expect(search.structuredContent).toMatchObject({ items: [{ subtitle: 'List author' }] });
    const detail = await runToolContract(riksdagGetDocument, {
      documentId: 'HC01KU1',
      sections: ['metadata'],
    });
    expect(publicDomain(detail)).toMatchObject({
      metadata: { subtitle: 'Consolidation', consolidationLabel: 'Consolidation' },
    });
  });
  it('converts only proposal and known HTML properties and retains originals', async () => {
    const html = '<p>godk&auml;nner<BR/>A &amp;lt; B <a href="https://example.test/">länk</a></p>';
    initRiksdagService({
      fetch: async () =>
        Response.json(
          status({
            dokutskottsforslag: { utskottsforslag: { punkt: '1', forslag: html } },
            dokuppgift: {
              uppgift: [
                { kod: 'notis', text: html },
                { kod: 'utsknotis', text: html },
                { kod: 'other', text: 'literal <x> &amp;' },
                { kod: 'notis' },
              ],
            },
          }),
        ),
    });
    const result = await runToolContract(riksdagGetDocument, {
      documentId: 'HC01KU1',
      sections: ['decisions', 'properties'],
    });
    const domain = publicDomain(result);
    expect(result.structuredContent).toMatchObject(domain);
    expect(domain.decisions[0]).toMatchObject({
      proposal: 'godkänner  \nA &lt; B [länk](<https://example.test/>)',
      proposalSourceHtml: html,
    });
    expect(domain.properties).toEqual([
      { code: 'notis', text: domain.decisions[0].proposal, sourceHtml: html },
      { code: 'utsknotis', text: domain.decisions[0].proposal, sourceHtml: html },
      { code: 'other', text: 'literal <x> &amp;' },
      { code: 'notis' },
    ]);
  });
  it('retains every historical direct-row summary in arrays', async () => {
    const table = (heading: string) => ({
      tr: [
        { td: { h4: heading, p: 'Proposal' } },
        { th: ['Party', 'Ja'] },
        { td: ['S', '0'] },
        { td: ['Totalt', '0'] },
      ],
    });
    initRiksdagService({
      fetch: async () =>
        Response.json(
          status({
            dokutskottsforslag: {
              utskottsforslag: {
                punkt: '1',
                votering_sammanfattning_html: { table: [table('sakfrågan'), table('motivfrågan')] },
              },
            },
          }),
        ),
    });
    const result = await runToolContract(riksdagGetDocument, {
      documentId: 'HC01KU1',
      sections: ['decisions'],
    });
    const domain = publicDomain(result);
    expect(result.structuredContent).toMatchObject(domain);
    expect(domain.decisions[0]).not.toHaveProperty('summary');
    expect(domain.decisions[0].summaries).toEqual(
      ['sakfrågan', 'motivfrågan'].map((heading) => ({
        heading,
        proposal: 'Proposal',
        columns: ['Party', 'Ja'],
        rows: [{ cells: ['S', '0'] }, { cells: ['Totalt', '0'] }],
      })),
    );
  });
  it('retains sparse stakeholders and traverses their independent pages', async () => {
    initRiksdagService({
      fetch: async () =>
        Response.json(
          status({
            dokintressent: {
              intressent: [
                {
                  intressent_id: '00123',
                  namn: 'A',
                  partibet: 'S',
                  ordning: '1',
                  roll: 'undertecknare',
                },
                { namn: 'Missing ID' },
                {},
              ],
            },
          }),
        ),
    });
    let args: unknown = { documentId: 'HC01KU1', sections: ['stakeholders'], sectionLimit: 1 };
    const rows = [];
    for (let i = 0; i < 3; i++) {
      const result = await runToolContract(
        riksdagGetDocument,
        riksdagGetDocument.input.parse(args),
      );
      const domain = publicDomain(result);
      expect(result.structuredContent).toMatchObject(domain);
      expect(domain.outline).toContainEqual({
        section: 'stakeholders',
        available: true,
        itemCount: 3,
      });
      rows.push(...domain.stakeholders);
      args = domain.sectionPages[0].nextCall?.args;
    }
    expect(rows).toEqual([
      { memberId: '00123', name: 'A', party: 'S', order: '1', role: 'undertecknare' },
      { name: 'Missing ID' },
      {},
    ]);
    expect(args).toBeUndefined();
  });
  it.each([
    { query: 'word', sort: undefined, expected: 'rel' },
    { query: ' ', sort: undefined, expected: 'datum' },
    { query: 'word', sort: 'date', expected: 'datum' },
    { sort: 'relevance', expected: 'rel' },
  ] as const)('applies upstream sorting and IID filters %j', async ({ query, sort, expected }) => {
    let called: URL | undefined;
    initRiksdagService({
      fetch: async (request) => {
        called = new URL(String(request));
        return Response.json({ dokumentlista: { dokument: [], '@traffar': '0' } });
      },
    });
    const result = await runToolContract(riksdagSearchDocuments, {
      query,
      sort,
      memberId: ' 00123 ',
    });
    publicDomain(result);
    expect(called?.searchParams.get('sort')).toBe(expected);
    expect(called?.searchParams.get('iid')).toBe('00123');
    expect(
      JSON.parse(z.object(successEnrichment).parse(result.structuredContent).effectiveQuery),
    ).toMatchObject({
      memberId: '00123',
      sort: expected === 'rel' ? 'relevance' : 'date',
    });
  });
  it('fits rows and exhausts each stable remote page before advancing without loss', async () => {
    const calls: URL[] = [];
    initRiksdagService({
      fetch: async (request) => {
        const url = new URL(String(request));
        calls.push(url);
        const page = Number(url.searchParams.get('p'));
        return Response.json({
          dokumentlista: {
            '@traffar': '5',
            '@sida': String(page),
            dokument: Array.from({ length: page === 1 ? 3 : 2 }, (_, i) => ({
              dok_id: `HC01KU${(page - 1) * 3 + i + 1}`,
              titel: 'å'.repeat(1800),
            })),
          },
        });
      },
    });
    let args: unknown = { query: 'word', memberId: '00123', pageSize: 3 };
    const ids: string[] = [];
    for (let i = 0; i < 10 && args; i++) {
      const result = await runToolContract(
        riksdagSearchDocuments,
        riksdagSearchDocuments.input.parse(args),
      );
      const domain = publicDomain(result);
      expect(result.structuredContent).toMatchObject(domain);
      expect(domain.pageSize).toBe(3);
      expect(domain.offset).toBeTypeOf('number');
      expect(domain.revision).toBeTypeOf('string');
      expect(
        Buffer.byteLength(JSON.stringify(result.content)) +
          Buffer.byteLength(JSON.stringify(result.structuredContent)),
      ).toBeLessThanOrEqual(24576);
      ids.push(...domain.items.map((row: { documentId: string }) => row.documentId));
      args = domain.nextCall?.args;
      if (args) expect(args).toMatchObject({ memberId: '00123', sort: 'relevance', pageSize: 3 });
    }
    expect(args).toBeUndefined();
    expect(ids).toEqual(['HC01KU1', 'HC01KU2', 'HC01KU3', 'HC01KU4', 'HC01KU5']);
    expect(calls.every((url) => url.searchParams.get('sz') === '3')).toBe(true);
  });
});
