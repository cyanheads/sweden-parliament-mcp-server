/** @fileoverview Swedish document identifiers across search, detail and report workflows. @module tests/integration/unicode-documents */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { riksdagGetDocument } from '@/mcp-server/tools/definitions/get-document.tool.js';
import { riksdagGetVotes } from '@/mcp-server/tools/definitions/get-votes.tool.js';
import { riksdagSearchDocuments } from '@/mcp-server/tools/definitions/search-documents.tool.js';
import { normalizeDocumentId } from '@/services/riksdag/normalize.js';
import { getRiksdagService, initRiksdagService } from '@/services/riksdag/riksdag-service.js';

const document = {
  dok_id: 'HC01FöU9',
  doktyp: 'bet',
  rm: '2024/25',
  beteckning: 'FöU9',
  titel: 'Syntetiskt betänkande',
};

describe('Swedish document identifiers', () => {
  afterEach(() => getRiksdagService().dispose());

  it('preserves a full remote page containing Swedish letters on both surfaces', async () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({
      ...document,
      dok_id: index === 10 ? 'HC01FöU9' : `HC01KU${index + 1}`,
    }));
    initRiksdagService({
      fetch: async () =>
        Response.json({ dokumentlista: { '@traffar': '50', '@sida': '1', dokument: rows } }),
    });
    const first = await runToolContract(riksdagSearchDocuments, {
      session: '2024/25',
      documentType: 'bet',
      pageSize: 50,
    });
    const firstPage = riksdagSearchDocuments.output.parse(first.structuredContent);
    const items = [...firstPage.items];
    const content = [...first.content];
    let next = firstPage.nextCall;
    while (next) {
      const continued = await runToolContract(riksdagSearchDocuments, next.args);
      expect(continued.isError).not.toBe(true);
      const page = riksdagSearchDocuments.output.parse(continued.structuredContent);
      items.push(...page.items);
      content.push(...continued.content);
      next = page.nextCall;
    }
    const result = {
      ...first,
      content,
      structuredContent: { ...firstPage, items, returnedCount: items.length },
    };
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      returnedCount: 50,
      pageSize: 50,
      items: expect.arrayContaining([expect.objectContaining({ documentId: 'HC01FÖU9' })]),
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('HC01FÖU9') }),
      ]),
    );
  });

  it('retrieves equivalent case and decomposed IDs and resolves their report designation', async () => {
    const paths: string[] = [];
    initRiksdagService({
      fetch: async (request) => {
        const url = new URL(String(request));
        paths.push(decodeURIComponent(url.pathname));
        return Response.json(
          url.pathname === '/dokumentlista/'
            ? { dokumentlista: { '@traffar': '1', dokument: document } }
            : { dokumentstatus: { dokument: { ...document, html: '<p>Syntetisk text.</p>' } } },
        );
      },
    });
    const detail = await runToolContract(riksdagGetDocument, { documentId: 'hc01fo\u0308u9' });
    expect(detail.isError).not.toBe(true);
    expect(detail.structuredContent).toMatchObject({ found: true, documentId: 'HC01FÖU9' });
    const votes = await runToolContract(riksdagGetVotes, {
      mode: 'report',
      session: '2024/25',
      report: 'FöU9',
    });
    expect(votes.isError).not.toBe(true);
    expect(votes.structuredContent).toMatchObject({
      found: true,
      documentId: 'HC01FÖU9',
      report: 'FÖU9',
      pointTotalCount: 0,
    });
    expect(paths).toContain('/dokumentstatus/HC01FÖU9.json');
    expect(normalizeDocumentId('SFS 2018:218')).toBe('sfs-2018-218');
    for (const invalid of [
      'HC01FöU9/../../secret',
      'https://example.test/HC01FöU9',
      'HC01FöU9?x=1',
    ])
      expect(() => normalizeDocumentId(invalid)).toThrow();
  });
});
