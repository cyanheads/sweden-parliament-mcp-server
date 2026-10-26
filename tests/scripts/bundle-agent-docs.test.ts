/** @fileoverview Bundle pruning preserves runtime skill modules while removing agent instructions. @module tests/scripts/bundle-agent-docs */
import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

const { AGENT_DOC_ENTRY, checkBundleEntries } = await import(
  new URL('../../scripts/lint-packaging.ts', import.meta.url).href
);

describe('bundle agent-document pruning', () => {
  const instructions = [
    'node_modules/library/skills/research/SKILL.md',
    'node_modules/@scope/library/framework-skills/setup/SKILL.md',
    'node_modules/library/.claude/settings.json',
    'node_modules/@scope/library/.agents/skills/setup/SKILL.md',
    'node_modules/outer/node_modules/inner/skills/research/reference.md',
    'node_modules/@scope/outer/node_modules/@scope/inner/skills/research/reference.md',
    'node_modules/library/docs/SKILL.md',
  ];
  const runtime = [
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/node.mjs',
    'node_modules/library/dist/skills/index.js',
    'node_modules/@scope/outer/node_modules/inner/dist/skills/index.js',
    'skills/published/SKILL.md',
  ];

  it('strips package-root instructions and retains nested runtime modules', () => {
    expect(filterAgentDocEntries([...instructions, ...runtime])).toEqual(instructions);
  });

  it('uses the same boundary in completed-bundle validation', () => {
    expect([...instructions, ...runtime].filter((entry) => AGENT_DOC_ENTRY.test(entry))).toEqual(
      instructions,
    );
    expect(checkBundleEntries(runtime, 'bundle.mcpb')).toEqual([]);
    expect(checkBundleEntries(instructions, 'bundle.mcpb')).toHaveLength(1);
  });
});
