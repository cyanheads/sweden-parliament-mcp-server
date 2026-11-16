/** @fileoverview Shared check that an emitted continuation is a complete call for its tool. @module tests/services/riksdag/continuation-fixtures */
import type { z } from '@cyanheads/mcp-ts-core';
import { expect } from 'vitest';

/**
 * Asserts a continuation names the tool and its args are complete normalized input (strict
 * parsing succeeds and changes nothing), then returns the parsed args for the next call.
 */
export function continuationArgs<D extends { name: string; input: z.ZodObject }>(
  definition: D,
  call: { toolName: string; args: Record<string, unknown> } | undefined,
): z.output<D['input']> {
  expect(call?.toolName).toBe(definition.name);
  const parsed = definition.input.strict().parse(call?.args);
  expect(parsed).toEqual(call?.args);
  return parsed as z.output<D['input']>;
}
