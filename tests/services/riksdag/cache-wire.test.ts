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
describe('derived memo beside a cached response', () => {
  const MiB = 1024 * 1024;
  const maxBytes = 32 * MiB;
  it('returns a memo with the exact entry it was derived from', () => {
    const cache = new PublicResponseCache();
    cache.set('a', '{"x":1}', 'source', 120000);
    expect(cache.get('a')).toEqual({ serialized: '{"x":1}', retrievedAt: 'source' });
    cache.memoize('a', '{"x":1}', 'derived');
    expect(cache.get('a')).toEqual({
      serialized: '{"x":1}',
      retrievedAt: 'source',
      derived: 'derived',
    });
  });
  it('refuses a memo for a missing, replaced or already memoized entry', () => {
    const cache = new PublicResponseCache();
    cache.memoize('missing', '{}', 'derived');
    expect(cache.get('missing')).toBeUndefined();
    cache.set('a', '{"x":1}', 'source', 120000);
    cache.set('a', '{"x":2}', 'source', 120000);
    cache.memoize('a', '{"x":1}', 'stale');
    expect(cache.get('a')).toEqual({ serialized: '{"x":2}', retrievedAt: 'source' });
    cache.memoize('a', '{"x":2}', 'first');
    cache.memoize('a', '{"x":2}', 'second');
    expect(cache.get('a')?.derived).toBe('first');
  });
  it('expires and is replaced together with its entry', () => {
    vi.useFakeTimers();
    const cache = new PublicResponseCache();
    cache.set('a', '{}', 'source', 120000);
    cache.memoize('a', '{}', 'derived');
    vi.advanceTimersByTime(119999);
    expect(cache.get('a')?.derived).toBe('derived');
    cache.set('a', '{}', 'source', 120000);
    expect(cache.get('a')).toEqual({ serialized: '{}', retrievedAt: 'source' });
    cache.memoize('a', '{}', 'derived');
    vi.advanceTimersByTime(120000);
    cache.memoize('a', '{}', 'late');
    expect(cache.get('a')).toBeUndefined();
  });
  it('counts memo UTF-8 bytes with its entry and skips a memo that would exceed the bound', () => {
    const cache = new PublicResponseCache();
    const wire = 'x'.repeat(maxBytes - 20);
    cache.set('a', wire, 'source', 120000);
    // 11 code units, 22 UTF-8 bytes.
    cache.memoize('a', wire, 'å'.repeat(11));
    expect(cache.get('a')?.derived).toBeUndefined();
    cache.memoize('a', wire, 'å'.repeat(10));
    expect(cache.get('a')?.derived).toBe('å'.repeat(10));
  });
  it('evicts older entries for a memo and counts memo bytes against later entries', () => {
    const cache = new PublicResponseCache();
    const wire = 'x'.repeat(16 * MiB);
    cache.set('old', 'x'.repeat(10 * MiB), 'source', 120000);
    cache.set('a', wire, 'source', 120000);
    cache.memoize('a', wire, 'y'.repeat(7 * MiB));
    expect(cache.get('old')).toBeUndefined();
    expect(cache.get('a')?.derived).toHaveLength(7 * MiB);
    cache.set('b', 'x'.repeat(9 * MiB), 'source', 120000);
    expect(cache.get('a')?.derived).toHaveLength(7 * MiB);
    expect(cache.get('b')).toBeDefined();
    cache.set('c', 'x', 'source', 120000);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });
  it('refuses a memo for an expired entry without evicting live ones', () => {
    vi.useFakeTimers();
    const cache = new PublicResponseCache();
    const wire = 'x'.repeat(16 * MiB);
    cache.set('a', wire, 'source', 1000);
    cache.set('b', 'x'.repeat(10 * MiB), 'source', 120000);
    vi.advanceTimersByTime(1000);
    cache.memoize('a', wire, 'y'.repeat(7 * MiB));
    expect(cache.get('b')).toBeDefined();
  });
  it('keeps the memoized entry while evicting for its memo when it is least recently used', () => {
    const cache = new PublicResponseCache();
    const wire = 'x'.repeat(16 * MiB);
    cache.set('a', wire, 'source', 120000);
    cache.set('old', 'x'.repeat(10 * MiB), 'source', 120000);
    cache.memoize('a', wire, 'y'.repeat(7 * MiB));
    expect(cache.get('a')?.derived).toHaveLength(7 * MiB);
    expect(cache.get('old')).toBeUndefined();
  });
  it('adds no entry for a memo at the 64-entry bound', () => {
    const cache = new PublicResponseCache();
    for (let i = 0; i < 64; i++) cache.set(String(i), '{}', 'source', 120000);
    cache.memoize('63', '{}', 'derived');
    expect(cache.get('0')).toBeDefined();
    expect(cache.get('63')?.derived).toBe('derived');
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
