/** @fileoverview CPU growth bounds for dependency-path classification. @module tests/scripts/bundle-agent-docs-timing */
import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY } from '../../scripts/clean-mcpb.js';

describe('bundle path classifier CPU growth', () => {
  it.each([
    ['digits', (size: number) => `node_modules/pkg/${'9'.repeat(size)}/SKILL.mdX`],
    [
      'terminal break',
      (size: number) =>
        `node_modules/pkg/${'§1 x'.repeat(Math.ceil(size / 4)).slice(0, size)}\ny/SKILL.mdX`,
    ],
    [
      'interspersed breaks',
      (size: number) =>
        `node_modules/pkg/${'  \r\n'.repeat(Math.ceil(size / 4)).slice(0, size)}/SKILL.mdX`,
    ],
    [
      'nested packages',
      (size: number) =>
        `node_modules/${'pkg/node_modules/'.repeat(Math.ceil(size / 17))}pkg/skillsX/SKILL.mdX`,
    ],
    [
      'scoped nested packages',
      (size: number) =>
        `node_modules/${'@scope/pkg/node_modules/'.repeat(Math.ceil(size / 24))}@scope/pkg/skillsX/SKILL.mdX`,
    ],
  ] as const)('bounds %s classification', (shape, makePath) => {
    const timings: number[] = [];
    for (let size = 5000; size <= 320000; size *= 2) {
      const path = makePath(size);
      expect(AGENT_DOC_ENTRY.test(path)).toBe(false);
      const samples: number[] = [];
      for (let run = 0; run < 3; run++) {
        const start = process.threadCpuUsage();
        for (let repeat = 0; repeat < 16; repeat++) AGENT_DOC_ENTRY.test(path);
        const usage = process.threadCpuUsage(start);
        const cpuUs = usage.user + usage.system;
        expect(cpuUs, `${shape} ${size}`).toBeLessThan(250000);
        samples.push(cpuUs);
      }
      timings.push(samples.sort((left, right) => left - right)[1]!);
    }
    expect(timings.at(-1)! / timings[0]!).toBeLessThan(256);
    console.info(
      JSON.stringify({ runtime: 'Bun' in globalThis ? 'bun' : 'node', shape, cpuUs: timings }),
    );
  });
});
