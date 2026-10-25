/** @fileoverview Sparse upstream collections and malformed source-value error boundaries. @module tests/services/riksdag/upstream-boundaries */
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { riksdagGetDocument } from '@/mcp-server/tools/definitions/get-document.tool.js';
import {
  loadDocumentStatus,
  resolveReport,
  searchDocuments,
} from '@/services/riksdag/documents.js';
import {
  getRiksdagService,
  initRiksdagService,
  RiksdagService,
} from '@/services/riksdag/riksdag-service.js';
import { createToolBudget } from '@/services/riksdag/transport.js';
import { collectionOf } from '@/services/riksdag/wire.js';

describe('upstream normalization boundaries', () => {
  it('materializes an omitted collection child as an empty array', () => {
    const schema = z.object({ rows: collectionOf(z.object({ id: z.string() })) });
    expect(schema.parse({})).toEqual({ rows: [] });
  });

  it('accepts an omitted document child for an authoritative zero-hit search', async () => {
    const service = new RiksdagService({
      fetch: async () => Response.json({ dokumentlista: { '@traffar': '0' } }),
    });
    using budget = createToolBudget();
    try {
      await expect(
        searchDocuments(service, { page: 1, pageSize: 10 }, budget),
      ).resolves.toMatchObject({ items: [], totalCount: 0, hasMore: false });
    } finally {
      service.dispose();
    }
  });

  it('accepts an omitted document child as a missing exact report', async () => {
    const service = new RiksdagService({
      fetch: async () => Response.json({ dokumentlista: { '@traffar': '0' } }),
    });
    using budget = createToolBudget();
    try {
      await expect(resolveReport(service, '2024/25', 'KU1', budget)).resolves.toMatchObject({
        found: false,
      });
    } finally {
      service.dispose();
    }
  });

  it('rejects a malformed report search identity before requesting status', async () => {
    const network = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        dokumentlista: {
          '@traffar': '1',
          dokument: { dok_id: '?', rm: '2024/25', doktyp: 'bet', beteckning: 'KU1' },
        },
      }),
    );
    const service = new RiksdagService({ fetch: network });
    using budget = createToolBudget();
    try {
      await expect(resolveReport(service, '2024/25', 'KU1', budget)).rejects.toMatchObject({
        code: JsonRpcErrorCode.SerializationError,
        data: { reason: 'upstream_schema_invalid' },
      });
      expect(network).toHaveBeenCalledTimes(1);
    } finally {
      service.dispose();
    }
  });

  it.each([
    { label: 'malformed source ID', dokument: { dok_id: '?' } },
    {
      label: 'malformed source URL',
      dokument: { dok_id: 'HC01KU1', dokument_url_html: 'http://[' },
    },
    {
      label: 'malformed decision session',
      dokument: { dok_id: 'HC01KU1', rm: '2024/25' },
      dokutskottsforslag: { utskottsforslag: { punkt: '1', rm: 'bad-session' } },
    },
  ])(
    'classifies $label as source schema failure without retry or cache',
    async ({ dokument, ...rest }) => {
      const network = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => Response.json({ dokumentstatus: { dokument, ...rest } }));
      const service = new RiksdagService({ fetch: network });
      using budget = createToolBudget();
      try {
        for (let attempt = 0; attempt < 2; attempt++)
          await expect(loadDocumentStatus(service, 'HC01KU1', budget)).rejects.toMatchObject({
            code: JsonRpcErrorCode.SerializationError,
            data: { reason: 'upstream_schema_invalid', retryable: false },
          });
        expect(network).toHaveBeenCalledTimes(2);
      } finally {
        service.dispose();
      }
    },
  );

  it('returns source-schema recovery on both tool error surfaces', async () => {
    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ dokumentstatus: { dokument: { dok_id: '?' } } }),
      );
    initRiksdagService({ fetch: network });
    try {
      const result = await runToolContract(riksdagGetDocument, { documentId: 'HC01KU1' });
      const error = z
        .object({
          error: z.object({
            code: z.number(),
            data: z.object({ reason: z.string(), recovery: z.object({ hint: z.string() }) }),
          }),
        })
        .parse(result.structuredContent).error;
      expect(result.isError).toBe(true);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.SerializationError,
        data: { reason: 'upstream_schema_invalid' },
      });
      expect(error.data.recovery.hint).toBe(
        'Retry the same tool later; report repeated failures with the request identifier.',
      );
      const text = result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      expect(text).toContain(error.data.recovery.hint);
      expect(text).toContain('upstream_schema_invalid');
      expect(network).toHaveBeenCalledTimes(1);
    } finally {
      getRiksdagService().dispose();
    }
  });
});
