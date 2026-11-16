/** @fileoverview Unicode code-point text continuation. @module tests/services/riksdag/pagination */
import { describe, expect, it } from 'vitest';
import type { SuccessEnrichment } from '@/services/riksdag/output.js';
import {
  DEFAULT_TEXT_PAGE_CODE_POINTS,
  pageText,
  pageTexts,
} from '@/services/riksdag/pagination.js';
import { createToolBudget } from '@/services/riksdag/transport.js';

const enrichment = (): SuccessEnrichment => ({
  effectiveQuery: '{}',
  source: 'Source: The Swedish Parliament',
  retrievedAt: '2026-01-01',
  notices: [],
});

const asPage = (text: string, returnedLength: number) => ({ text, returnedLength });

/** Follows pages from offset 0 until an empty page, returning each page's text. */
function walk(text: string, length?: number): string[] {
  const pages: string[] = [];
  let offset = 0;
  for (;;) {
    const page = pageText({
      text,
      offset,
      ...(length === undefined ? {} : { length }),
      enrichment: enrichment(),
      build: asPage,
    });
    if (page.returnedLength === 0) return pages;
    pages.push(page.text);
    offset += page.returnedLength;
  }
}

describe('code-point paging', () => {
  it('pages 8000 code points by default whatever their byte size, past the first page', () => {
    expect(DEFAULT_TEXT_PAGE_CODE_POINTS).toBe(8000);
    const text = `${'😀'.repeat(8000)}${'å'.repeat(8000)}${'𐐀'.repeat(3000)}`;
    const context = enrichment();
    const first = pageText({ text, offset: 0, enrichment: context, build: asPage });
    expect(first).toEqual({ text: '😀'.repeat(8000), returnedLength: 8000 });
    expect(new TextEncoder().encode(first.text).byteLength).toBe(32000);
    const second = pageText({ text, offset: 8000, enrichment: context, build: asPage });
    expect(second).toEqual({ text: 'å'.repeat(8000), returnedLength: 8000 });
    const third = pageText({ text, offset: 16000, enrichment: context, build: asPage });
    expect(third).toEqual({ text: '𐐀'.repeat(3000), returnedLength: 3000 });
    expect(context.notices).toEqual([]);
    const pages = walk(text);
    expect(pages.map((page) => Array.from(page).length)).toEqual([8000, 8000, 3000]);
    expect(pages.join('')).toBe(text);
  });
  it('never splits a surrogate pair at any page boundary', () => {
    const text = 'A😀å𐐀Z'.repeat(7);
    for (const length of [1, 2, 3, 4]) {
      const pages = walk(text, length);
      expect(pages.join('')).toBe(text);
      expect(pages.map((page) => Array.from(page).length)).toEqual(
        Array.from({ length: Math.ceil(35 / length) }, (_, index) =>
          Math.min(length, 35 - index * length),
        ),
      );
      for (const page of pages) expect(page.isWellFormed()).toBe(true);
    }
    expect(
      pageText({ text: 'A😀å𐐀Z', offset: 1, length: 3, enrichment: enrichment(), build: asPage }),
    ).toEqual({ text: '😀å𐐀', returnedLength: 3 });
  });
  it('honors explicit lengths above the default and zero without notices', () => {
    const text = '😀'.repeat(20000);
    const context = enrichment();
    const explicit = pageText({
      text,
      offset: 3,
      length: 12000,
      enrichment: context,
      build: asPage,
    });
    expect(explicit).toEqual({ text: '😀'.repeat(12000), returnedLength: 12000 });
    const zero = pageText({ text, offset: 3, length: 0, enrichment: context, build: asPage });
    expect(zero).toEqual({ text: '', returnedLength: 0 });
    const tail = pageText({ text, offset: 19990, length: 50, enrichment: context, build: asPage });
    expect(tail).toEqual({ text: '😀'.repeat(10), returnedLength: 10 });
    expect(context.notices).toEqual([]);
  });
  it('returns an empty terminal page, with a notice only past the end', () => {
    const atEnd = enrichment();
    expect(pageText({ text: '😀å', offset: 2, enrichment: atEnd, build: asPage })).toEqual({
      text: '',
      returnedLength: 0,
    });
    expect(atEnd.notices).toEqual([]);
    const past = enrichment();
    expect(pageText({ text: '😀å', offset: 3, enrichment: past, build: asPage })).toEqual({
      text: '',
      returnedLength: 0,
    });
    expect(past.notices).toEqual([
      'The text offset is beyond the available text; this is an empty terminal page.',
    ]);
    const empty = enrichment();
    expect(pageText({ text: '', offset: 0, enrichment: empty, build: asPage })).toEqual({
      text: '',
      returnedLength: 0,
    });
    expect(empty.notices).toEqual([]);
  });
  it('pages each channel independently with its own length, offset and past-end notice', () => {
    const context = enrichment();
    const markdown = '😀'.repeat(9000);
    const html = `<p>${'å'.repeat(20000)}</p>`;
    const page = pageTexts({
      sources: [
        { id: 'markdown', text: markdown, offset: 8000 },
        { id: 'html', text: html, offset: 0, length: 15000 },
        { id: 'late', text: 'abc', offset: 4, pastEndNotice: 'The htmlOffset is past the end.' },
      ],
      enrichment: context,
      build: (pages) =>
        pages.map(({ source, text, returnedLength, totalLength }) => ({
          id: source.id,
          text,
          returnedLength,
          totalLength,
        })),
    });
    expect(page).toEqual([
      { id: 'markdown', text: '😀'.repeat(1000), returnedLength: 1000, totalLength: 9000 },
      { id: 'html', text: html.slice(0, 15000), returnedLength: 15000, totalLength: 20007 },
      { id: 'late', text: '', returnedLength: 0, totalLength: 3 },
    ]);
    expect(context.notices).toEqual(['The htmlOffset is past the end.']);
    expect(pageTexts({ sources: [], enrichment: enrichment(), build: (pages) => pages })).toEqual(
      [],
    );
  });
  it('stops on a cancelled caller instead of returning a page', () => {
    const controller = new AbortController();
    using budget = createToolBudget(controller.signal);
    controller.abort();
    const build = () => {
      throw new Error('build must not run after cancellation');
    };
    const cancelled = expect.objectContaining({ message: 'The caller cancelled the request.' });
    expect(() =>
      pageText({ text: 'abc', offset: 0, enrichment: enrichment(), budget, build }),
    ).toThrow(cancelled);
    expect(() =>
      pageTexts({ sources: [{ text: 'abc', offset: 0 }], enrichment: enrichment(), budget, build }),
    ).toThrow(cancelled);
  });
});
