/** @fileoverview Document tool input boundaries and format projections. @module tests/tools/documents.tool */
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { riksdagGetDocument } from '@/mcp-server/tools/definitions/get-document.tool.js';
import { riksdagSearchDocuments } from '@/mcp-server/tools/definitions/search-documents.tool.js';
import { getRiksdagService, initRiksdagService } from '@/services/riksdag/riksdag-service.js';

describe('document tool boundaries', () => {
  it('applies economical defaults without interpreting a bare report as an ID', () => {
    expect(riksdagSearchDocuments.input.parse({})).toEqual({ page: 1, pageSize: 10 });
    expect(riksdagGetDocument.input.parse({ documentId: 'HC01KU1' })).toMatchObject({
      textOffset: 0,
      htmlOffset: 0,
      sectionOffset: 0,
      sectionLimit: 20,
    });
    for (const input of [{ page: 0 }, { pageSize: 10001 }, { page: 1.5 }])
      expect(riksdagSearchDocuments.input.safeParse(input).success).toBe(false);
    for (const input of [
      { documentId: '' },
      { documentId: 'HC01KU1', textOffset: -1 },
      { documentId: 'HC01KU1', textLength: 0 },
      { documentId: 'HC01KU1', htmlLength: 1.5 },
    ])
      expect(riksdagGetDocument.input.safeParse(input).success).toBe(false);
  });
  it('rejects unknown sections and invalid normalized filters before any HTTP request', async () => {
    const network = vi.fn<typeof fetch>();
    initRiksdagService({ fetch: network });
    try {
      await expect(
        riksdagGetDocument.handler(
          riksdagGetDocument.input.parse({ documentId: 'HC01KU1', sections: ['made_up'] }),
          createMockContext({ errors: riksdagGetDocument.errors }),
        ),
      ).rejects.toMatchObject({ data: { reason: 'unknown_section' } });
      for (const input of [
        { session: '2025/27' },
        { documentType: 'unknown' },
        { dateFrom: '2025-02-29' },
        { dateFrom: '2025-01-02', dateTo: '2025-01-01' },
      ])
        await expect(
          riksdagSearchDocuments.handler(
            riksdagSearchDocuments.input.parse(input),
            createMockContext({ errors: riksdagSearchDocuments.errors }),
          ),
        ).rejects.toMatchObject({ data: { reason: 'invalid_filter' } });
      expect(network).not.toHaveBeenCalled();
    } finally {
      getRiksdagService().dispose();
    }
  });
});
