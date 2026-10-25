/** @fileoverview Measured whole-entry and Unicode text continuation. @module tests/services/riksdag/pagination */
import { describe, expect, it } from 'vitest';
import { measureResponse, type SuccessEnrichment } from '@/services/riksdag/output.js';
import { fitRows, fitText, RESPONSE_TARGET_BYTES } from '@/services/riksdag/pagination.js';

const enrichment = (): SuccessEnrichment => ({
  effectiveQuery: '{}',
  source: 'Source: The Swedish Parliament',
  retrievedAt: '2026-01-01',
  notices: [],
});
describe('response fitting', () => {
  it('keeps rows whole and advances complete continuation by actual shown rows', () => {
    const context = enrichment();
    const rows = Array.from({ length: 20 }, (_, id) => ({ id, text: 'å'.repeat(1200) }));
    const build = (items: typeof rows, limit: number, truncated: boolean) => ({
      items,
      limit,
      truncated,
      nextCall: {
        toolName: 'example',
        args: {
          party: 'S',
          mode: 'search',
          session: '2025/26',
          offset: 5 + items.length,
          limit: 20,
        },
      },
    });
    const page = fitRows({ rows, offset: 5, limit: 15, enrichment: context, build });
    expect(page.truncated).toBe(true);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.length).toBeLessThan(15);
    expect(page.items[0]).toEqual({ id: 5, text: 'å'.repeat(1200) });
    expect(page.nextCall.args).toEqual({
      party: 'S',
      mode: 'search',
      session: '2025/26',
      offset: 5 + page.items.length,
      limit: 20,
    });
    expect(measureResponse(page, context)).toBeLessThanOrEqual(RESPONSE_TARGET_BYTES);
    expect(context.notices.join(' ')).toContain('shortened');
  });
  it('returns oversized indivisible fields intact with a notice', () => {
    const context = enrichment();
    const page = fitRows({
      rows: [{ value: 'x'.repeat(30000) }, { value: 'later' }],
      offset: 0,
      limit: 2,
      enrichment: context,
      build: (items) => ({ items, nextOffset: items.length }),
    });
    expect(page).toEqual({ items: [{ value: 'x'.repeat(30000) }], nextOffset: 1 });
    expect(context.notices.join(' ')).toContain('indivisible entry');
  });
  it('reduces default Unicode text by measured size and honors explicit larger lengths', () => {
    const text = '😀'.repeat(2000);
    const context = enrichment();
    const build = (chunk: string, returnedLength: number) => ({
      text: chunk,
      duplicated: chunk,
      extra: 'x'.repeat(10000),
      nextTextCall: {
        toolName: 'example',
        args: { documentId: 'HC01KU1', revision: 'abc', textOffset: 10 + returnedLength },
      },
    });
    const page = fitText({ text, offset: 10, enrichment: context, build });
    expect(Array.from(page.text).length).toBeLessThan(1000);
    expect(page.text).toMatch(/^(😀)+$/u);
    expect(page.nextTextCall.args.textOffset).toBe(10 + Array.from(page.text).length);
    expect(measureResponse(page, context)).toBeLessThanOrEqual(RESPONSE_TARGET_BYTES);
    const explicitContext = enrichment();
    const explicit = fitText({
      text,
      offset: 10,
      length: 1500,
      enrichment: explicitContext,
      build,
    });
    expect(Array.from(explicit.text).length).toBe(1500);
    expect(explicitContext.notices.join(' ')).toContain('explicit textLength');
  });
  it('returns terminal empty text past the end', () => {
    const context = enrichment();
    expect(
      fitText({
        text: '😀',
        offset: 2,
        enrichment: context,
        build: (text, length) => ({ text, length }),
      }),
    ).toEqual({ text: '', length: 0 });
    expect(context.notices.join(' ')).toContain('beyond');
  });
});
