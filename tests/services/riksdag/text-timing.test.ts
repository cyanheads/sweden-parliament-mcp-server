/** @fileoverview CPU bounds for HTML-to-Markdown conversion of source-sized bodies. @module tests/services/riksdag/text-timing */
import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '@/services/riksdag/text.js';

type Shape = readonly [name: string, make: (size: number) => string, base: number];

/** `unit` repeated to exactly `size` code units; a cut inside a tag ends the body mid-markup. */
const repeat = (unit: string, size: number) =>
  unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

const SHAPES: Shape[] = [
  [
    'unclosed page nesting',
    (size) =>
      repeat(
        '<div class="page"><p>§1 Riksdagen beslutar <b>om</b> lagen.</p><table><tr><td>1</td><td>x</td></tr></table><ingenbild></div>\n',
        size,
      ),
    5000,
  ],
  [
    'paragraph blocks',
    (size) =>
      `<div>${repeat('<p>§1 Riksdagen beslutar <i>om</i> lagen.</p><h3>Rubrik</h3>', size)}</div>`,
    5000,
  ],
  ['terminal break', (size) => `<p>${repeat('§1 x', size)}\ny</p>`, 5000],
  /** One whitespace text run: its 64x span stays below the length where Bun's regex engine changes mode. */
  ['interspersed breaks', (size) => `<p>${repeat('  \r\n', size)}</p>`, 1250],
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

describe('HTML-to-Markdown CPU growth', () => {
  it('converts long runs of line breaks without backtracking', () => {
    for (const html of [
      `<p>a${'<br>'.repeat(28)}b</p>`,
      `<pre>a${'\n \n'.repeat(14)}b</pre>`,
      `<pre>a${'\r\n'.repeat(28)}{Infinity}</pre>`,
    ]) {
      expect(
        leastCpuUs(() => htmlToMarkdown(html), 1),
        JSON.stringify(html),
      ).toBeLessThan(50_000);
    }
  }, 0);

  it.each(SHAPES)(
    'keeps %s linear across a 64x span',
    (shape, make, base) => {
      const convert = (html: string) => () => {
        htmlToMarkdown(html);
      };
      const baseHtml = make(base);
      const ratios: number[] = [];
      for (let size = base * 2; size <= base * 64; size *= 2) {
        const html = make(size);
        const pairs: number[] = [];
        for (let pair = 0; pair < 3; pair++) {
          const baseUs = leastCpuUs(convert(baseHtml), 16);
          const sizeUs = leastCpuUs(convert(html), Math.max(1, Math.round((base * 16) / size)));
          expect(sizeUs, `${shape} ${size}`).toBeLessThan(1_000_000);
          pairs.push(sizeUs / Math.max(baseUs, 1));
        }
        const growth = Math.min(...pairs);
        expect(growth, `${shape} ${size}/${base}`).toBeLessThan(256);
        ratios.push(growth);
      }
      console.info(JSON.stringify({ shape, growth: ratios }));
    },
    0,
  );
});
