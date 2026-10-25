/** @fileoverview Speech mode validation before upstream access. @module tests/tools/speeches-tool */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { riksdagSearchSpeeches } from '@/mcp-server/tools/definitions/search-speeches.tool.js';
import { getRiksdagService, initRiksdagService } from '@/services/riksdag/riksdag-service.js';

afterEach(() => getRiksdagService().dispose());

describe('speech input contract', () => {
  it.each([
    {},
    { session: '' },
    { session: '2024/25', speechId: 'HC091-1' },
    { session: '2024/25', textOffset: 0 },
    { session: '2024/25', textLength: 1 },
    { mode: 'get' },
    { mode: 'get', speechId: 'synthetic-uuid-1' },
    { mode: 'get', speechId: 'HC091-1', session: '2024/25' },
    { mode: 'get', speechId: 'HC091-1', limit: 5 },
    { mode: 'get', speechId: 'HC091-1', textCount: 1 },
    { session: '2024/25', headingContains: '!?...' },
  ] as const)(
    'rejects conflicting or unresolvable arguments %j before defaults/network',
    async (input) => {
      const network = vi.fn<typeof fetch>();
      initRiksdagService({ fetch: network });
      const result = await runToolContract(riksdagSearchSpeeches, input);
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'invalid_filter' } },
        },
      });
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining('riksdag_list_reference'),
          }),
        ]),
      );
      expect(network).not.toHaveBeenCalled();
    },
  );
  it.each([
    { session: '2024/25', limit: 0 },
    { session: '2024/25', textCount: -1 },
    { mode: 'get', speechId: 'HC091-1', textLength: 0 },
  ] as const)('retains framework InvalidParams for schema input %j', async (input) => {
    const network = vi.fn<typeof fetch>();
    initRiksdagService({ fetch: network });
    const result = await runToolContract(riksdagSearchSpeeches, input);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: JsonRpcErrorCode.InvalidParams } },
    });
    expect(network).not.toHaveBeenCalled();
  });
});
