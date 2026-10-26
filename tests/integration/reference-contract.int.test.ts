/** @fileoverview Dual-surface reference contract through the real tool runner. @module tests/integration/reference-contract */
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { listReference } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { measureResponse, successEnrichment } from '@/services/riksdag/output.js';

describe('reference public response contract', () => {
  it('measures the actual public JSON and content bytes including the framework trailer', async () => {
    const result = await runToolContract(listReference, { topic: 'speech_types' });
    if (!result.structuredContent) throw new Error('Expected a structured success.');
    const domain = listReference.output.parse(result.structuredContent);
    const enrichment = z.object(successEnrichment).parse(result.structuredContent);
    const bytes = new TextEncoder();
    expect(measureResponse(domain, enrichment)).toBe(
      bytes.encode(JSON.stringify(result.structuredContent)).byteLength +
        bytes.encode(JSON.stringify(result.content)).byteLength,
    );
  });
  it('publishes offline vocabulary, source dates and notices on both surfaces', async () => {
    const result = await runToolContract(listReference, {
      topic: 'sessions',
      offset: 0,
      limit: 100000,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      topic: 'sessions',
      offset: 0,
      requestedLimit: 100000,
      source: 'Source: The Swedish Parliament',
      retrievedAt: '2026-10-25',
      referenceVerifiedAt: '2026-10-25',
      referenceCatalogTimestamp: '2026-10-25 12:15:54',
    });
    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    expect(text).toContain('Source: The Swedish Parliament');
    expect(text).toContain('2026-10-25 12:15:54');
    expect(text).toContain('was clamped to 100');
    expect(text).toContain('snapshot may lag current sessions');
    expect(text).toContain('riksdag_list_reference');
    expect(text).toContain(
      '[source 1](<https://data.riksdagen.se/sv/koder/?typ=riksmote&utformat=json>)',
    );
  });
  it('preserves empty result and false/zero pagination on both surfaces', async () => {
    const result = await runToolContract(listReference, { topic: 'speech_types', offset: 100 });
    expect(result.structuredContent).toMatchObject({
      entries: [],
      returnedCount: 0,
      hasMore: false,
      totalCount: 2,
      notices: [],
    });
    const first = result.content[0];
    expect(first?.type).toBe('text');
    if (first?.type !== 'text') throw new Error('Expected the domain text block.');
    expect(first.text).toContain('"returnedCount": 0');
    expect(first.text).toContain('"hasMore": false');
    expect(first.text).toContain('"entries": []');
  });
  it('exposes invalid input and cancellation on both error surfaces', async () => {
    const invalid = await runToolContract(listReference, { topic: 'parties', limit: 0 });
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(invalid.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('riksdag_list_reference'),
        }),
      ]),
    );
    const controller = new AbortController();
    controller.abort();
    const cancelled = await runToolContract(
      listReference,
      { topic: 'coverage' },
      { context: { signal: controller.signal } },
    );
    expect(cancelled.isError).toBe(true);
    expect(cancelled.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(cancelled.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringMatching(/abort|cancel/i) }),
      ]),
    );
  });
});
