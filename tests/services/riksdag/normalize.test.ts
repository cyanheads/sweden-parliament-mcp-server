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
import { REFERENCE_TABLES } from '@/services/riksdag/reference-data.js';

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
  it.each(['2025/2027', '2025/27', '1999/99', '25/26', '0000'])(
    'rejects invalid session %s',
    (session) => {
      expect(() => normalizeSession(session)).toThrow();
    },
  );
  it('normalizes consecutive full-year sessions and composite report prefixes', () => {
    expect(normalizeSession(' 2024/2025 ')).toBe('2024/25');
    expect(normalizeSession('2099/2100')).toBe('2099/00');
    expect(normalizeReport('2024/2025:KU1', '2024/25')).toBe('KU1');
    expect(() => normalizeReport('2024/2025:KU1', '2025/26')).toThrow();
  });
  it('names the accepted date and session forms and the date ordering constraint', () => {
    expect(() => normalizeSession('2024/2026')).toThrow('YYYY/YY');
    expect(() => normalizeDate('2024/13/01')).toThrow('YYYY-MM-DD');
    expect(() => normalizeDate('2024-02-30')).toThrow('YYYY-MM-DD');
    expect(() => normalizeDateRange('2025-01-02', '2025-01-01')).toThrow(
      'dateFrom must be on or before dateTo',
    );
  });
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

describe('rare identifier forms', () => {
  it.each([
    ['hc01föu9', 'HC01FÖU9'],
    ['HC01FÅU1', 'HC01FÅU1'],
    ['HC01FKU1', 'HC01FKU1'],
    ['HC01FÅU1', 'HC01FÅU1'],
    ['HC01FſU1', 'HC01FSU1'],
    ['﻿HC01FöU1　', 'HC01FÖU1'],
    [' SFS\t2018:218 ', 'sfs-2018-218'],
    ['sfs  2018:218', 'sfs-2018-218'],
  ])('keeps document ID %j canonical as %s', (input, canonical) => {
    expect(normalizeDocumentId(input)).toBe(canonical);
  });
  it.each(['SFS2018:218', 'sfs 2018-218', 'sfs-2018-0218', '2018:0218', 'HC01-FöU1', 'HC01FüU1'])(
    'rejects document ID %j',
    (input) => {
      expect(() => normalizeDocumentId(input)).toThrow('Invalid documentId');
    },
  );
  it.each([
    ['2024/25 :FöU1', '2024/25', 'FÖU1'],
    [' föu1 ', '2024/25', 'FÖU1'],
    ['1999/2000:KU1', '1999/00', 'KU1'],
  ])('keeps report %j in %s canonical as %s', (input, session, canonical) => {
    expect(normalizeReport(input, session)).toBe(canonical);
  });
  it.each(['FſU1', 'FöU01', 'Fö U1', 'FöU', 'a:b:c', '2024/25:'])('rejects report %j', (input) => {
    expect(() => normalizeReport(input, '2024/25')).toThrow('Invalid report');
  });
  it('names a disagreeing report session even around whitespace', () => {
    expect(() => normalizeReport(' 2023/24 : FöU1 ', '2024/25')).toThrow('Invalid report session');
  });
});

describe('vote-record document IDs', () => {
  it.each([
    ['H6190118-1', 'H6190118-1'],
    ['h6190118-1', 'H6190118-1'],
    [' HA191017-1 ', 'HA191017-1'],
    ['hc191124-12', 'HC191124-12'],
    ['K6190118-1', 'K6190118-1'],
  ])('canonicalizes %j to %s', (input, canonical) => {
    expect(normalizeDocumentId(input)).toBe(canonical);
    expect(normalizeDocumentId(canonical)).toBe(canonical);
  });
  it.each([
    'H6190118-01',
    'H6190118-0',
    'H619118-1',
    'H61901180-1',
    'H6090118-1',
    'H6190118-1-2',
    'Hö190118-1',
    '6H190118-1',
    'H6190118‑1',
    'H6190118-',
    'H6190118 -1',
    'ſ6190118-1',
  ])('rejects %j', (input) => {
    expect(() => normalizeDocumentId(input)).toThrow('Invalid documentId');
  });
  it('names the caller field in a rejection', () => {
    expect(() => normalizeDocumentId('H6190118-0', 'relatedDocumentId')).toThrow(
      'Invalid relatedDocumentId',
    );
  });
  it('is documented in the identifiers topic in the spelling the normalizer returns', () => {
    const explanation =
      REFERENCE_TABLES.identifiers.find((row) => row.code === 'documentId')?.explanation ?? '';
    expect(explanation).toContain(normalizeDocumentId('h6190118-1'));
  });
});

describe('report designation normalization', () => {
  it.each([
    ['FöU1', '2024/25'],
    ['2024/25:föu1', '2024/25'],
  ])('accepts decomposed %j like the composed designation', (input, session) => {
    expect(normalizeReport(input, session)).toBe('FÖU1');
  });
  it.each(['2024/25: FöU1', ' 2024/25 : FöU1 ', '2024/2025:\tFöU1'])(
    'trims each part of %j',
    (input) => {
      expect(normalizeReport(input, '2024/25')).toBe('FÖU1');
    },
  );
});

describe('N-series SFS identifiers', () => {
  it.each(['sfs-N2026-7', 'sfs-n2026-7', 'SFS N2026:7', 'sfs\tn2026:7', 'N2026:7', ' n2026:7 '])(
    'canonicalizes %j to sfs-N2026-7',
    (input) => {
      expect(normalizeDocumentId(input)).toBe('sfs-N2026-7');
    },
  );
  it.each([
    'sfs-N2026-07',
    'sfsN2026:7',
    'SFS N 2026:7',
    'N2026-7',
    'sfs-NN2026-7',
    'sfs-X2026-7',
    'N0999:7',
  ])('rejects %j', (input) => {
    expect(() => normalizeDocumentId(input)).toThrow('Invalid documentId');
  });
  it('is documented in the identifiers topic with the spellings the normalizers return', () => {
    const explanation = (code: string) =>
      REFERENCE_TABLES.identifiers.find((row) => row.code === code)?.explanation ?? '';
    for (const alias of ['sfs-N2026-7', 'SFS N2026:7', 'N2026:7']) {
      expect(explanation('sfs')).toContain(alias);
      expect(normalizeDocumentId(alias)).toBe('sfs-N2026-7');
    }
    expect(explanation('sfs')).toContain('resolve to sfs-N2026-7');
    expect(explanation('documentId')).toContain(`uppercase (${normalizeDocumentId('hc01föu1')})`);
    expect(explanation('report')).toContain('returned as published (FöU1)');
  });
  it('re-normalizes every canonical SFS form to itself', () => {
    for (const id of ['sfs-N2026-7', 'sfs-2000-100'])
      expect(normalizeDocumentId(normalizeDocumentId(id))).toBe(id);
  });
});
