/** @fileoverview CPU bounds for code-point paging. @module tests/services/riksdag/pagination-timing */
import { describe, expect, it } from 'vitest';
import { pageTexts } from '@/services/riksdag/pagination.js';

const shapes = [
  ['digits', (size: number) => '9'.repeat(size)],
  ['terminal break', (size: number) => `${'§1 x'.repeat(Math.ceil(size / 4)).slice(0, size)}\ny`],
  ['interspersed breaks', (size: number) => '  \r\n'.repeat(Math.ceil(size / 4)).slice(0, size)],
] as const;

/** Least per-call thread CPU time over several batches; a GC pause only ever adds time. */
function leastCpuUs(run: () => void, calls: number): number {
  let least = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < 5; sample++) {
    const start = process.threadCpuUsage();
    for (let call = 0; call < calls; call++) run();
    const usage = process.threadCpuUsage(start);
    least = Math.min(least, (usage.user + usage.system) / calls);
  }
  return least;
}

describe('code-point paging CPU growth', () => {
  it.each(shapes)(
    'keeps %s paging linear across a 64x span',
    (shape, makeText) => {
      const BASE = 5000;
      const page = (text: string) => () =>
        pageTexts({
          sources: [
            { text, offset: 0 },
            { text, offset: Math.max(0, text.length - 100), length: 50 },
          ],
          enrichment: { effectiveQuery: '{}', source: 'S', retrievedAt: 'now', notices: [] },
          build: (pages) => pages.map(({ returnedLength }) => returnedLength),
        });
      const baseText = makeText(BASE);
      const ratios: number[] = [];
      for (let size = BASE * 2; size <= BASE * 64; size *= 2) {
        const text = makeText(size);
        const pairs: number[] = [];
        for (let pair = 0; pair < 3; pair++) {
          const baseUs = leastCpuUs(page(baseText), 64);
          const sizeUs = leastCpuUs(page(text), Math.max(1, Math.round((BASE * 64) / size)));
          expect(sizeUs, `${shape} ${size}`).toBeLessThan(200_000);
          pairs.push(sizeUs / Math.max(baseUs, 1));
        }
        const growth = Math.min(...pairs);
        expect(growth, `${shape} ${size}/${BASE}`).toBeLessThan(256);
        ratios.push(growth);
      }
      console.info(JSON.stringify({ shape, growth: ratios }));
    },
    0,
  );
});
