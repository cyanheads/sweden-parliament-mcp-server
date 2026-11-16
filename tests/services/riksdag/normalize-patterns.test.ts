/** @fileoverview Raw-input format patterns agree with the normalizers and advertise flag-free JSON Schema. @module tests/services/riksdag/normalize-patterns */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import {
  formatString,
  type InputFormat,
  normalizeDate,
  normalizeDocumentId,
  normalizeMemberId,
  normalizeReport,
  normalizeSession,
  normalizeSpeechId,
  optionalString,
} from '@/services/riksdag/normalize.js';

const NORMALIZERS: Record<InputFormat, (value: string) => string> = {
  session: normalizeSession,
  date: normalizeDate,
  memberId: normalizeMemberId,
  documentId: normalizeDocumentId,
  speechId: normalizeSpeechId,
  report: (value) => normalizeReport(value, '2024/25'),
};
const FORMATS = Object.keys(NORMALIZERS) as InputFormat[];

function normalizerAccepts(format: InputFormat, value: string): boolean {
  try {
    NORMALIZERS[format](value);
    return true;
  } catch {
    return false;
  }
}

function thrownMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected a rejection');
}

/**
 * `accepted`: the normalizer accepts it. `value`: the pattern admits the form and the normalizer
 * rejects the value. `format`: both reject.
 */
type Verdict = 'accepted' | 'value' | 'format';
const CORPUS: Record<InputFormat, [string, Verdict][]> = {
  session: [
    ['2024/25', 'accepted'],
    [' 2024/25 ', 'accepted'],
    ['\t2024/25\n', 'accepted'],
    ['﻿2024/25　', 'accepted'],
    ['2024/2025', 'accepted'],
    ['1999/00', 'accepted'],
    ['1999/2000', 'accepted'],
    ['2099/2100', 'accepted'],
    ['1867', 'accepted'],
    ['2024/26', 'value'],
    ['2025/2027', 'value'],
    ['2024-25', 'format'],
    ['2024/5', 'format'],
    ['2024/025', 'format'],
    ['2024 /25', 'format'],
    ['0999', 'format'],
    ['25/26', 'format'],
    ['２０２４/25', 'format'],
    ['2024/25:', 'format'],
    ['9999/10000', 'format'],
  ],
  date: [
    ['2024-12-04', 'accepted'],
    [' 2024-02-29 ', 'accepted'],
    ['1000-01-01', 'accepted'],
    ['9999-12-31', 'accepted'],
    ['2023-02-29', 'value'],
    ['2024-13-01', 'value'],
    ['2024-12-00', 'value'],
    ['2024-2-4', 'format'],
    ['0999-01-01', 'format'],
    ['2024/12/04', 'format'],
    ['20241204', 'format'],
    ['2024-12-04T00:00', 'format'],
  ],
  memberId: [
    ['0103624617217', 'accepted'],
    [' 0103624617217 ', 'accepted'],
    ['0', 'accepted'],
    [' 123 ', 'accepted'],
    ['-1', 'format'],
    ['+1', 'format'],
    ['1e3', 'format'],
    ['12 3', 'format'],
    ['１２３', 'format'],
    ['synthetic-source-uuid', 'format'],
  ],
  speechId: [
    ['HC0943-67', 'accepted'],
    ['hc0943-67', 'accepted'],
    [' HC0943-67 ', 'accepted'],
    ['HC090-67', 'accepted'],
    ['xy09431-1', 'accepted'],
    ['HC0943-067', 'format'],
    ['HC0943-0', 'format'],
    ['HC09-67', 'format'],
    ['HC0143-67', 'format'],
    ['HC0943‑67', 'format'],
    ['HC0943-67-1', 'format'],
    ['synthetic-uuid-1', 'format'],
    ['https://data.riksdagen.se/anforande/HC0910-12', 'format'],
  ],
  documentId: [
    ['HC01FÖU1', 'accepted'],
    ['hc01föu9', 'accepted'],
    ['HC01FÅU1', 'accepted'],
    ['HC01FKU1', 'accepted'],
    ['HC01FÅU1', 'accepted'],
    ['HC01FſU1', 'accepted'],
    [' HC01FöU1 ', 'accepted'],
    ['HC01', 'accepted'],
    ['sfs-2000-100', 'accepted'],
    ['SFS 2000:100', 'accepted'],
    ['sfs\t2018:218', 'accepted'],
    ['2000:100', 'accepted'],
    ['sfs-N2026-7', 'accepted'],
    ['sfs-n2026-7', 'accepted'],
    ['SFS N2026:7', 'accepted'],
    ['N2026:7', 'accepted'],
    ['H6190118-1', 'accepted'],
    ['h6190118-1', 'accepted'],
    [' HA191017-1 ', 'accepted'],
    ['HC191124-12', 'accepted'],
    ['K6190118-1', 'accepted'],
    ['HK190118-1', 'accepted'],
    ['HC01FüU1', 'value'],
    ['KU1', 'format'],
    ['HC0', 'format'],
    ['1HC01', 'format'],
    ['HC01-FöU1', 'format'],
    ['HC01FüU1', 'format'],
    ['HC01FßU1', 'format'],
    ['̈HC01', 'format'],
    ['SFS2018:218', 'format'],
    ['sfs 2018-218', 'format'],
    ['sfs-2018-0218', 'format'],
    ['sfs-N2026-07', 'format'],
    ['sfsN2026:7', 'format'],
    ['HC10134, HC10150', 'format'],
    ['https://data.riksdagen.se/dokument/HC01FöU1', 'format'],
    ['H6190118-01', 'format'],
    ['H6190118-0', 'format'],
    ['H619118-1', 'format'],
    ['H61901180-1', 'format'],
    ['H6090118-1', 'format'],
    ['H6190118-1-2', 'format'],
    ['Hö190118-1', 'format'],
    ['6H190118-1', 'format'],
    ['H6190118‑1', 'format'],
    ['H6190118 -1', 'format'],
    ['ſ6190118-1', 'format'],
    ['Å6190118-1', 'format'],
  ],
  report: [
    ['FöU1', 'accepted'],
    ['föu1', 'accepted'],
    [' FöU1 ', 'accepted'],
    ['FöU1', 'accepted'],
    ['FKU1', 'accepted'],
    ['2024/25:FöU1', 'accepted'],
    ['2024/2025:FöU1', 'accepted'],
    ['2024/25 :FöU1', 'accepted'],
    ['2024/25: FöU1', 'accepted'],
    [' 2024/25 : FöU1 ', 'accepted'],
    ['KU10', 'accepted'],
    ['2023/24:FöU1', 'value'],
    ['2024:FöU1', 'value'],
    ['FüU1', 'value'],
    ['FöU01', 'format'],
    ['FöU0', 'format'],
    ['FöU', 'format'],
    ['FſU1', 'format'],
    ['Fö U1', 'format'],
    ['FiU-1', 'format'],
    [':FöU1', 'format'],
    ['2024/25:', 'format'],
    ['a:b:c', 'format'],
  ],
};
const BLANKS = ['', ' ', '\t\n', '　﻿', '\r\n '];

describe('raw-input format patterns', () => {
  describe.each(FORMATS)('%s', (format) => {
    it.each(CORPUS[format])(
      'classifies %j as %s on the normalizer and both patterns',
      (input, verdict) => {
        expect(normalizerAccepts(format, input)).toBe(verdict === 'accepted');
        for (const blank of [false, true])
          expect(formatString(format, { blank }).safeParse(input).success).toBe(
            verdict !== 'format',
          );
      },
    );
    it.each(BLANKS)('admits blank %j only when blank is allowed', (input) => {
      expect(normalizerAccepts(format, input)).toBe(false);
      expect(optionalString(input)).toBeUndefined();
      expect(formatString(format, { blank: true }).safeParse(input).success).toBe(true);
      expect(formatString(format, { blank: false }).safeParse(input).success).toBe(false);
    });
    it('rejects a malformed value with the normalizer message', () => {
      const [malformed] = CORPUS[format].find(([, verdict]) => verdict === 'format') ?? [];
      if (malformed === undefined) throw new Error(`no malformed ${format} row`);
      const result = formatString(format, { blank: true }).safeParse(malformed);
      expect(result.error?.issues.map((issue) => issue.message)).toEqual([
        thrownMessage(() => NORMALIZERS[format](malformed)),
      ]);
    });
  });

  it('names each format in its message', () => {
    const messages = FORMATS.map(
      (format) => formatString(format, { blank: false }).safeParse('§').error?.issues[0]?.message,
    );
    expect(messages).toEqual([
      'Invalid session; use YYYY/YY, consecutive YYYY/YYYY, or a calendar year YYYY.',
      'Invalid date; use a valid Gregorian date in YYYY-MM-DD format.',
      'Invalid memberId; use riksdag_list_reference to check its format or code.',
      'Invalid documentId; use riksdag_list_reference to check its format or code.',
      'Invalid speechId; use riksdag_list_reference to check its format or code.',
      'Invalid report; use riksdag_list_reference to check its format or code.',
    ]);
  });

  it.each([
    ['documentId', 'HC01FÖU1'],
    ['documentId', 'sfs-2000-100'],
    ['documentId', 'sfs-N2026-7'],
    ['documentId', 'H6190118-1'],
    ['session', '2024/25'],
    ['session', '1999/2000'],
    ['memberId', '0103624617217'],
    ['speechId', 'HC0943-67'],
    ['date', '2024-12-04'],
  ] as const)('passes the emitted %s %s back unchanged', (format, value) => {
    expect(NORMALIZERS[format](value)).toBe(value);
    for (const blank of [false, true])
      expect(formatString(format, { blank }).safeParse(value).success).toBe(true);
  });
  it.each(['FöU1', 'FÖU1', 'KU1'])('admits the report designation %s as returned', (value) => {
    for (const blank of [false, true])
      expect(formatString('report', { blank }).safeParse(value).success).toBe(true);
  });
});

describe('advertised JSON Schema patterns', () => {
  const inputs = [
    ...BLANKS,
    ...FORMATS.flatMap((format) => CORPUS[format].map(([input]) => input)),
  ];
  it.each(FORMATS.flatMap((format) => [false, true].map((blank) => [format, blank] as const)))(
    'emits %s (blank %s) as flag-free ASCII that a client evaluates like the server',
    (format, blank) => {
      const schema = formatString(format, { blank });
      const emitted = z.toJSONSchema(schema);
      expect(schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' })).toEqual(emitted);
      expect(emitted).toMatchObject({ type: 'string', pattern: expect.any(String) });
      const pattern = String(emitted.pattern);
      expect(pattern).toMatch(/^[\x20-\x7E]+$/);
      for (const client of [new RegExp(pattern), new RegExp(pattern, 'u')])
        for (const input of inputs)
          expect(client.test(input), JSON.stringify(input)).toBe(schema.safeParse(input).success);
    },
  );
});

describe('pattern and normalizer agreement under mutation', () => {
  const alphabet = [
    ...'0124579/-: \tHCFUKNnsfSaoöÖåÄx_é',
    ' ',
    '﻿',
    ' ',
    '\n',
    '̈',
    '̊',
    'ſ',
    'K',
    'Å',
    ';',
    '０',
  ];
  const seeds = [
    '2024/25',
    '2024/2025',
    '1999/00',
    '2024',
    '2024-12-04',
    '0103624617217',
    'HC0943-67',
    'HC01FöU1',
    'HC01FöU1',
    'sfs-2018-218',
    'SFS 2018:218',
    'sfs-N2026-7',
    'N2026:7',
    'H6190118-1',
    'HA191017-12',
    'FöU1',
    '2024/25 :FöU1',
    '2024/25: FöU1',
    '',
  ];
  let state = 42;
  const random = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const pick = () => alphabet[Math.floor(random() * alphabet.length)] ?? '';
  const corpus = new Set(seeds);
  for (const seed of seeds)
    for (let round = 0; round < 400; round++) {
      const chars = [...seed];
      for (let edit = Math.floor(random() * 3); edit >= 0; edit--) {
        const at = Math.floor(random() * (chars.length + 1));
        const op = random();
        if (op < 0.4) chars.splice(at, 0, pick());
        else if (op < 0.7) chars.splice(at, 1);
        else chars[at] = pick();
      }
      corpus.add(chars.join(''));
    }

  it.each(FORMATS.flatMap((format) => [false, true].map((blank) => [format, blank] as const)))(
    'admits every %s value the handler path accepts (blank %s)',
    (format, blank) => {
      const schema = formatString(format, { blank });
      let accepted = 0;
      const rejected: string[] = [];
      for (const input of corpus) {
        if (!(normalizerAccepts(format, input) || (blank && optionalString(input) === undefined)))
          continue;
        accepted++;
        if (!schema.safeParse(input).success) rejected.push(input);
      }
      expect(rejected).toEqual([]);
      expect(accepted).toBeGreaterThan(10);
    },
  );
});

describe('schema rejection through the tool boundary', () => {
  const probe = tool('format_probe', {
    description: 'Echo normalized identifiers.',
    input: z.object({
      documentId: formatString('documentId', { blank: false }).min(1).describe('Document ID.'),
      session: formatString('session', { blank: true }).optional().describe('Session.'),
    }),
    output: z.object({
      documentId: z.string().describe('Normalized document ID.'),
      session: z.string().optional().describe('Normalized session.'),
    }),
    handler: (input) => {
      const session = optionalString(input.session);
      return {
        documentId: normalizeDocumentId(input.documentId),
        ...(session ? { session: normalizeSession(session) } : {}),
      };
    },
  });
  const text = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');

  it.each([
    [{ documentId: ' hc01föu9 ', session: '  ' }, { documentId: 'HC01FÖU9' }],
    [
      { documentId: 'N2026:7', session: ' 2024/2025 ' },
      { documentId: 'sfs-N2026-7', session: '2024/25' },
    ],
  ])('passes rare form %j through to the handler', async (input, expected) => {
    const result = await runToolContract(probe, input);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(expected);
    expect(text(result)).toContain(expected.documentId);
  });
  it.each([
    [
      { documentId: 'HC01-FöU1' },
      'Invalid documentId; use riksdag_list_reference to check its format or code.',
    ],
    [
      { documentId: '   ' },
      'Invalid documentId; use riksdag_list_reference to check its format or code.',
    ],
    [
      { documentId: 'HC01', session: '2024-25' },
      'Invalid session; use YYYY/YY, consecutive YYYY/YYYY, or a calendar year YYYY.',
    ],
  ])('rejects %j at the schema with the format message', async (input, message) => {
    const result = await runToolContract(probe, input);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: JsonRpcErrorCode.InvalidParams } },
    });
    expect(text(result)).toContain(message);
  });
  it('leaves value checks behind a matching pattern to the handler', async () => {
    const result = await runToolContract(probe, { documentId: 'HC01', session: '2024/26' });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'invalid_filter' } },
      },
    });
    expect(text(result)).toContain('Invalid session; use YYYY/YY');
  });
});
