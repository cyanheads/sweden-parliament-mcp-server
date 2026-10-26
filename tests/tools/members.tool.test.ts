/** @fileoverview Member input validation and source-free rejection boundaries. @module tests/tools/members.tool */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { riksdagGetMember } from '@/mcp-server/tools/definitions/get-member.tool.js';
import { riksdagSearchMembers } from '@/mcp-server/tools/definitions/search-members.tool.js';
import { getRiksdagService, initRiksdagService } from '@/services/riksdag/riksdag-service.js';

describe('member tool inputs', () => {
  it('applies defaults and rejects invalid numeric boundaries', () => {
    expect(riksdagSearchMembers.input.parse({})).toEqual({
      register: 'service',
      sitting: 'all',
      offset: 0,
      limit: 20,
    });
    expect(riksdagGetMember.input.parse({ memberId: '0001' })).toEqual({
      memberId: '0001',
      assignmentOffset: 0,
      assignmentLimit: 20,
    });
    for (const input of [
      { limit: 0 },
      { offset: -1 },
      { offset: 0.5 },
      { sitting: 'elected' },
      { register: 'historical' },
    ])
      expect(riksdagSearchMembers.input.safeParse(input).success).toBe(false);
    for (const input of [
      { memberId: '' },
      { memberId: '1', assignmentLimit: 0 },
      { memberId: '1', assignmentOffset: -1 },
    ])
      expect(riksdagGetMember.input.safeParse(input).success).toBe(false);
  });
  it('rejects punctuation-only names, unknown codes and source UUIDs before HTTP', async () => {
    const network = vi.fn<typeof fetch>();
    initRiksdagService({ fetch: network });
    try {
      for (const input of [
        { nameContains: '--' },
        { party: 'unknown' },
        { constituency: 'unknown' },
      ]) {
        const result = await runToolContract(riksdagSearchMembers, input);
        expect(result).toMatchObject({
          isError: true,
          structuredContent: { error: { data: { reason: 'invalid_filter' } } },
        });
        expect(result.content).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'text',
              text: expect.stringContaining('riksdag_list_reference'),
            }),
          ]),
        );
      }
      const uuid = await runToolContract(riksdagGetMember, { memberId: 'synthetic-source-uuid' });
      expect(uuid).toMatchObject({
        isError: true,
        structuredContent: { error: { data: { reason: 'invalid_filter' } } },
      });
      const badLimit = await runToolContract(riksdagSearchMembers, { limit: 0 });
      expect(badLimit).toMatchObject({
        isError: true,
        structuredContent: { error: { code: JsonRpcErrorCode.InvalidParams } },
      });
      expect(network).not.toHaveBeenCalled();
    } finally {
      getRiksdagService().dispose();
    }
  });
});
