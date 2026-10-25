/** @fileoverview Strict normalization of published vocabulary and identifiers. @module tests/services/riksdag/normalize */
import { describe, expect, it } from 'vitest';
import {
  isReferenceTopic,
  matchesAllTokens,
  normalizeCode,
  normalizeDate,
  normalizeDateRange,
  normalizeDocumentId,
  normalizeMemberId,
  normalizeReport,
  normalizeSession,
  normalizeSpeechId,
  normalizeTokens,
  optionalString,
} from '@/services/riksdag/normalize.js';

describe('source identifiers and filters', () => {
  it.each(['sfs-2000-100', 'SFS 2000:100', '2000:100'])(
    'canonicalizes %s without guessing a designation',
    (id) => {
      expect(normalizeDocumentId(id)).toBe('sfs-2000-100');
    },
  );
  it('preserves significant identifier bytes and published code spelling', () => {
    expect(normalizeDocumentId(' hc01ku1 ')).toBe('HC01KU1');
    expect(normalizeMemberId(' 000123 ')).toBe('000123');
    expect(normalizeSpeechId(' hc0910-12 ')).toBe('HC0910-12');
    expect(normalizeCode(' bet ', 'document_types')).toBe('bet');
    expect(normalizeCode('Konstitutionsutskottet', 'committees')).toBe('KU');
    expect(normalizeCode('s', 'parties')).toBe('S');
  });
  it.each(['1999/00', '1999/2000'])('accepts exceptional millennium session %s', (session) => {
    expect(normalizeSession(session)).toBe('1999/2000');
  });
  it('accepts historical calendar years and future sessions outside the snapshot', () => {
    expect(normalizeSession('1867')).toBe('1867');
    expect(normalizeSession('2030/31')).toBe('2030/31');
    expect(normalizeReport('1999/00:ku1', '1999/2000')).toBe('KU1');
  });
  it.each(['2025/2026', '2025/27', '1999/99', '25/26', '0000'])(
    'rejects invalid session %s',
    (session) => {
      expect(() => normalizeSession(session)).toThrow();
    },
  );
  it('rejects unknown codes, subtype labels, arbitrary URLs and disagreeing report sessions', () => {
    for (const run of [
      () => normalizeCode('unknown', 'parties'),
      () => normalizeCode('Utlåtande', 'document_types'),
      () => normalizeMemberId('abc-123'),
      () => normalizeSpeechId('https://data.riksdagen.se/anforande/HC0910-12'),
      () => normalizeSpeechId('HC01KU1-1'),
      () => normalizeReport('2024/25:KU1', '2025/26'),
    ])
      expect(run).toThrow();
  });
  it('validates calendar leap rules and date ordering', () => {
    expect(normalizeDate('2000-02-29')).toBe('2000-02-29');
    for (const date of ['1900-02-29', '2025-02-29', '2024-04-31', '2024-00-01', '2024-01-00'])
      expect(() => normalizeDate(date)).toThrow();
    expect(normalizeDateRange(' ', undefined)).toEqual({});
    expect(normalizeDateRange('2024-02-29', '2024-02-29')).toEqual({
      dateFrom: '2024-02-29',
      dateTo: '2024-02-29',
    });
    expect(() => normalizeDateRange('2025-01-02', '2025-01-01')).toThrow();
  });
  it('matches all diacritic-insensitive tokens without broadening punctuation-only input', () => {
    expect(normalizeTokens('Åsa, ÅSA—Öberg')).toEqual(['asa', 'oberg']);
    expect(matchesAllTokens('ÖBERG, Åsa', ['asa', 'oberg'])).toBe(true);
    expect(matchesAllTokens('Åsa Andersson', ['asa', 'oberg'])).toBe(false);
    expect(() => normalizeTokens(' -- ')).toThrow();
    expect(optionalString('  ')).toBeUndefined();
    expect(optionalString(' x ')).toBe('x');
    expect(isReferenceTopic('coverage')).toBe(true);
    expect(isReferenceTopic('constructor')).toBe(false);
    expect(isReferenceTopic('__proto__')).toBe(false);
  });
});
