/** @fileoverview Public cache bounds and upstream complete-set validation. @module tests/services/riksdag/cache-wire */
import { z } from '@cyanheads/mcp-ts-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicResponseCache } from '@/services/riksdag/cache.js';
import {
  assertCompleteCandidates,
  collectionOf,
  optionalWireString,
  sourceUrl,
  wireCount,
} from '@/services/riksdag/wire.js';

afterEach(() => vi.useRealTimers());
describe('public response cache', () => {
  it('expires at the TTL boundary and retains source retrieval time on reads', () => {
    vi.useFakeTimers();
    const cache = new PublicResponseCache();
    cache.set('a', '{"x":1}', '2026-01-01', 120000);
    vi.advanceTimersByTime(119999);
    expect(cache.get('a')).toEqual({ serialized: '{"x":1}', retrievedAt: '2026-01-01' });
    vi.advanceTimersByTime(1);
    expect(cache.get('a')).toBeUndefined();
  });
  it('evicts least recently used entries at the 64-entry boundary', () => {
    const cache = new PublicResponseCache();
    for (let i = 0; i < 64; i++) cache.set(String(i), '{}', 'source', 300000);
    expect(cache.get('0')).toBeDefined();
    cache.set('64', '{}', 'source', 300000);
    expect(cache.get('1')).toBeUndefined();
    expect(cache.get('0')).toBeDefined();
    expect(cache.get('64')).toBeDefined();
  });
  it('counts UTF-8 bytes, rejects oversize values and evicts for the total byte bound', () => {
    const cache = new PublicResponseCache();
    cache.set('oversize', 'å'.repeat(16 * 1024 * 1024 + 1), 'source', 120000);
    expect(cache.get('oversize')).toBeUndefined();
    cache.set('first', 'x'.repeat(20 * 1024 * 1024), 'source', 120000);
    cache.set('second', 'x'.repeat(13 * 1024 * 1024), 'source', 120000);
    expect(cache.get('first')).toBeUndefined();
    expect(cache.get('second')).toBeDefined();
  });
});
describe('wire invariants', () => {
  it('distinguishes absent strings and counts from invented defaults', () => {
    for (const value of [null, undefined, '', '  '])
      expect(optionalWireString.parse(value)).toBeUndefined();
    expect(optionalWireString.parse('  text\r\n')).toBe('  text\r\n');
    expect(wireCount.parse('0002')).toBe(2);
    for (const value of ['-1', '1.2', '1e2', '9007199254740992', 1])
      expect(wireCount.safeParse(value).success).toBe(false);
    const rows = collectionOf(z.object({ id: z.string() }));
    expect(rows.parse(null)).toEqual([]);
    expect(rows.parse({ id: 'a' })).toEqual([{ id: 'a' }]);
    expect(rows.safeParse('a').success).toBe(false);
  });
  it('rejects missing/mismatched counts, duplicate identities and saturated candidate sets', () => {
    expect(() => assertCompleteCandidates([], 0, (row: string) => row)).not.toThrow();
    for (const [rows, count] of [
      [['a'], undefined],
      [['a'], 2],
      [['a', 'a'], 2],
    ] as const)
      expect(() => assertCompleteCandidates([...rows], count, (row) => row)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({ reason: 'upstream_schema_invalid' }),
        }),
      );
    expect(() => assertCompleteCandidates(['a'], 50000, (row) => row)).toThrow(
      expect.objectContaining({ data: { reason: 'candidate_limit_reached' } }),
    );
    expect(() =>
      assertCompleteCandidates(
        Array.from({ length: 50000 }, (_, i) => String(i)),
        50000,
        (row) => row,
      ),
    ).toThrow(expect.objectContaining({ data: { reason: 'candidate_limit_reached' } }));
  });
  it('resolves links without permitting credentials or executable protocols', () => {
    expect(sourceUrl('/dokument/HC01KU1')).toBe('https://data.riksdagen.se/dokument/HC01KU1');
    for (const url of ['javascript:alert(1)', 'https://user:secret@example.test/'])
      expect(() => sourceUrl(url)).toThrow();
  });
});
