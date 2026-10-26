/** @fileoverview CPU bounds for final-envelope text fitting. @module tests/services/riksdag/pagination-timing */
import { describe, expect, it } from 'vitest';
import { fitTextPages } from '@/services/riksdag/pagination.js';

describe('text fitting CPU growth', () => {
  it.each([
    ['digits', (size: number) => '9'.repeat(size)],
    ['terminal break', (size: number) => `${'§1 x'.repeat(Math.ceil(size / 4)).slice(0, size)}\ny`],
    ['interspersed breaks', (size: number) => '  \r\n'.repeat(Math.ceil(size / 4)).slice(0, size)],
  ] as const)('keeps %s fitting bounded across a full span', (shape, makeText) => {
    const timings: number[] = [];
    for (let size = 5000; size <= 320000; size *= 2) {
      const text = makeText(size);
      const samples: number[] = [];
      for (let run = 0; run < 3; run++) {
        const start = process.threadCpuUsage();
        fitTextPages({
          sources: [
            { text, offset: 0 },
            { text, offset: 0 },
          ],
          enrichment: {
            effectiveQuery: '{}',
            source: 'Source: The Swedish Parliament',
            retrievedAt: '2026-01-01',
            notices: [],
          },
          build: (pages) => ({
            pages: pages.map(({ text, returnedLength }) => ({ text, returnedLength })),
          }),
        });
        const usage = process.threadCpuUsage(start);
        samples.push(usage.user + usage.system);
      }
      const elapsedUs = samples.sort((left, right) => left - right)[1]!;
      expect(elapsedUs, `${shape} ${size}`).toBeLessThan(2000000);
      timings.push(elapsedUs);
    }
    expect(timings.at(-1)! / timings[0]!).toBeLessThan(256);
    console.info(JSON.stringify({ shape, cpuUs: timings }));
  });
});
