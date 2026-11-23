/** @fileoverview CPU bounds for the raw-input format patterns on caller-sized input. @module tests/services/riksdag/normalize-pattern-timing */
import { describe, expect, it } from 'vitest';
import { formatString, type InputFormat, normalizeReport } from '@/services/riksdag/normalize.js';

/** Keyed by every `InputFormat`, so a new format fails the typecheck until it is timed here. */
const FORMATS = Object.keys({
  session: true,
  date: true,
  memberId: true,
  documentId: true,
  speechId: true,
  report: true,
} satisfies Record<InputFormat, true>) as InputFormat[];
const SCHEMAS = FORMATS.flatMap((format) =>
  [false, true].map(
    (blank) => [`${format} (blank ${blank})`, formatString(format, { blank })] as const,
  ),
);
type Shape = readonly [name: string, make: (size: number) => string];
const LINE_BREAK_SHAPES: Shape[] = [
  ['terminal break', (size) => `${'§1 x'.repeat(Math.ceil(size / 4)).slice(0, size)}\ny`],
  ['interspersed breaks', (size) => '  \r\n'.repeat(Math.ceil(size / 4)).slice(0, size)],
];
const SHAPES: Shape[] = [
  ['spaces then x', (size) => `${' '.repeat(size)}x`],
  ['spaces', (size) => ' '.repeat(size)],
  ['tabs then newline', (size) => `${'\t'.repeat(size)}\n`],
  ...LINE_BREAK_SHAPES,
];
/** Runs inside each format's body, where its own quantifiers meet the closing whitespace. */
const BODY_SHAPES: [InputFormat, ...Shape][] = [
  ['memberId', 'digit run', (size) => `${'1'.repeat(size)}x`],
  ['memberId', 'digits then spaces', (size) => `${'1'.repeat(size / 2)}${' '.repeat(size / 2)}x`],
  ['speechId', 'speech number run', (size) => `HC09${'1'.repeat(size)}x`],
  ['documentId', 'letter run', (size) => `H${'a'.repeat(size)} x`],
  ['documentId', 'SFS whitespace gap', (size) => `sfs${' '.repeat(size)}x`],
  ['documentId', 'vote-record number run', (size) => `H6190118-${'1'.repeat(size)}x`],
  ['documentId', 'vote-record prefix run', (size) => `H6${'1'.repeat(size)}-1x`],
  ['documentId', 'vote-record trailing spaces', (size) => `H6190118-1${' '.repeat(size)}x`],
  ['report', 'designation run', (size) => `F${'ö'.repeat(size)}x`],
  ['report', 'prefix whitespace gap', (size) => `2024/25${' '.repeat(size)}x`],
  ['report', 'post-colon whitespace gap', (size) => `2024/25:${' '.repeat(size)}x`],
];
/** Caller designations through the report normalizer, committee-prefix lookup included. */
const REPORT_SHAPES: Shape[] = [
  ['ASCII prefix run', (size) => `${'f'.repeat(size)}1`],
  ['folded prefix number run', (size) => `fou${'1'.repeat(size)}`],
  ['post-colon whitespace gap', (size) => `2024/25:${' '.repeat(size)}fou1`],
  ...LINE_BREAK_SHAPES,
];

/** Least per-call thread CPU time over several batches; a GC pause only ever adds time. */
function leastCpuUs(run: () => void, calls: number): number {
  let least = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < 3; sample++) {
    const start = process.threadCpuUsage();
    for (let call = 0; call < calls; call++) run();
    const usage = process.threadCpuUsage(start);
    least = Math.min(least, (usage.user + usage.system) / calls);
  }
  return least;
}

/** Doubles 5k → 320k, checking the absolute and growth bounds at each size before the next. */
function expectLinear(
  label: string,
  run: (value: string) => unknown,
  make: (size: number) => string,
) {
  const BASE = 5000;
  const parse = (input: string) => () => {
    run(input);
  };
  const baseInput = make(BASE);
  for (let size = BASE * 2; size <= BASE * 64; size *= 2) {
    const input = make(size);
    const pairs: number[] = [];
    for (let pair = 0; pair < 3; pair++) {
      const baseUs = leastCpuUs(parse(baseInput), 16);
      const sizeUs = leastCpuUs(parse(input), Math.max(1, Math.round((BASE * 16) / size)));
      expect(sizeUs, `${label} ${size}`).toBeLessThan(50_000);
      pairs.push(sizeUs / Math.max(baseUs, 1));
    }
    expect(Math.min(...pairs), `${label} ${size}/${BASE}`).toBeLessThan(256);
  }
}

describe('format pattern CPU growth', () => {
  it.each(
    SCHEMAS.flatMap(([label, schema]) =>
      SHAPES.map(([shape, make]) => [label, shape, schema, make] as const),
    ),
  )(
    'keeps %s linear on %s across a 64x span',
    (label, shape, schema, make) => {
      expectLinear(`${label} ${shape}`, (value) => schema.safeParse(value), make);
    },
    0,
  );
  it.each(
    BODY_SHAPES.flatMap(([format, shape, make]) =>
      [false, true].map((blank) => [format, blank, shape, make] as const),
    ),
  )(
    'keeps %s (blank %s) linear on a %s across a 64x span',
    (format, blank, shape, make) => {
      const schema = formatString(format, { blank });
      expectLinear(`${format} ${shape}`, (value) => schema.safeParse(value), make);
    },
    0,
  );
  it.each(REPORT_SHAPES)(
    'keeps normalizeReport linear on a %s across a 64x span',
    (shape, make) => {
      expectLinear(
        `normalizeReport ${shape}`,
        (value) => {
          try {
            normalizeReport(value, '2024/25');
          } catch {
            // A rejection is a timed outcome like an accepted key.
          }
        },
        make,
      );
    },
    0,
  );
});
