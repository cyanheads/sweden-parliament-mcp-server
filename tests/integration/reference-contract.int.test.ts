/** @fileoverview Dual-surface reference contract through the real tool runner. @module tests/integration/reference-contract */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { listReference } from '@/mcp-server/tools/definitions/list-reference.tool.js';

describe('reference public response contract', () => {
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
      limit: 100,
      requestedLimit: 100000,
      returnedCount: 57,
      totalCount: 57,
      hasMore: false,
      source: 'Source: The Swedish Parliament',
      retrievedAt: '2026-10-25',
      referenceVerifiedAt: '2026-10-25',
      referenceCatalogTimestamp: '2026-10-25 12:15:54',
    });
    expect(result.structuredContent).not.toHaveProperty('nextCall');
    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    expect(text).toContain('Source: The Swedish Parliament');
    expect(text).toContain('2026-10-25 12:15:54');
    expect(text).toContain('"returnedCount": 57');
    expect(text).toContain('was clamped to 100');
    expect(text).toContain('snapshot may lag current sessions');
    expect(text).not.toContain('"nextCall"');
    expect(text).toContain(
      '[source 1](<https://data.riksdagen.se/sv/koder/?typ=riksmote&utformat=json>)',
    );
  });
  it('returns the full 100-entry page and its applied-limit continuation on both surfaces', async () => {
    const result = await runToolContract(listReference, { topic: 'document_types', limit: 100 });
    expect(result.isError).not.toBe(true);
    const page = listReference.output.parse(result.structuredContent);
    expect(page).toMatchObject({ totalCount: 132, returnedCount: 100, limit: 100, hasMore: true });
    expect(page.entries).toHaveLength(100);
    expect(page.nextCall).toEqual({
      toolName: 'riksdag_list_reference',
      args: { topic: 'document_types', offset: 100, limit: 100 },
    });
    expect(result.structuredContent).not.toHaveProperty('truncated');
    expect(result.structuredContent).toMatchObject({ notices: [] });
    const first = result.content[0];
    if (first?.type !== 'text') throw new Error('Expected the domain text block.');
    const json = first.text.slice(first.text.indexOf('\n') + 1, first.text.indexOf('\n```\n'));
    expect(JSON.parse(json)).toEqual(page);
    expect(first.text).not.toContain('"truncated"');
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
