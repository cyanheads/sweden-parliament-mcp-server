/** @fileoverview Flat vote-mode validation before defaults or upstream calls. @module tests/tools/votes.tool */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { riksdagGetVotes } from '@/mcp-server/tools/definitions/get-votes.tool.js';
import { getRiksdagService, initRiksdagService } from '@/services/riksdag/riksdag-service.js';

describe('vote mode contracts', () => {
  it.each([
    { mode: 'report' as const },
    { mode: 'report' as const, report: 'KU1', memberId: '0001' },
    { mode: 'report' as const, report: 'KU1', party: 'S' },
    { mode: 'report' as const, report: 'KU1', offset: 0 },
    { mode: 'report' as const, report: 'KU1', limit: 20 },
    { mode: 'report' as const, report: 'KU1', point: 1, pointOffset: 0 },
    { mode: 'report' as const, report: 'KU1', point: 1, pointLimit: 5 },
    { mode: 'member' as const },
    { mode: 'member' as const, memberId: '0001', report: 'KU1' },
    { mode: 'member' as const, memberId: '0001', documentId: 'HC01KU1' },
    { mode: 'member' as const, memberId: '0001', point: 1 },
    { mode: 'member' as const, memberId: '0001', pointOffset: 0 },
    { mode: 'member' as const, memberId: '0001', pointLimit: 5 },
    { mode: 'member' as const, memberId: 'source-uuid' },
    { mode: 'report' as const, report: '2025/26:KU1' },
  ])('rejects conflicting or missing mode inputs %j', async (args) => {
    const network = vi.fn<typeof fetch>();
    initRiksdagService({ fetch: network });
    try {
      const result = await runToolContract(riksdagGetVotes, { ...args, session: '2024/25' });
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
    } finally {
      getRiksdagService().dispose();
    }
  });
  it('requires session and mode and rejects invalid numeric values at input parsing', () => {
    for (const args of [
      {},
      { mode: 'report' },
      { session: '2024/25' },
      { mode: 'report', session: '2024/25', point: 0 },
      { mode: 'member', session: '2024/25', limit: 0 },
      { mode: 'report', session: '2024/25', pointOffset: -1 },
    ])
      expect(riksdagGetVotes.input.safeParse(args).success).toBe(false);
    expect(
      riksdagGetVotes.input.parse({
        mode: 'report',
        session: '2024/25',
        report: ' ',
        documentId: ' HC01KU1 ',
        memberId: '',
      }),
    ).toEqual({
      mode: 'report',
      session: '2024/25',
      report: undefined,
      documentId: 'HC01KU1',
      memberId: undefined,
    });
  });
});
