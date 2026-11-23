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
  it('keeps committee and familyNamePrefix as optional inputs', () => {
    expect(
      riksdagSearchMembers.input.parse({ committee: 'FiU', familyNamePrefix: 'Pal' }),
    ).toMatchObject({ committee: 'FiU', familyNamePrefix: 'Pal' });
  });
  it.each(['unknown', 'S', 'kam', 'Fi', 'NR', 'KD'])(
    'rejects committee %s as invalid_filter before HTTP',
    async (committee) => {
      const network = vi.fn<typeof fetch>();
      initRiksdagService({ fetch: network });
      try {
        const result = await runToolContract(riksdagSearchMembers, { committee });
        expect(result).toMatchObject({
          isError: true,
          structuredContent: {
            error: {
              code: JsonRpcErrorCode.ValidationError,
              data: { reason: 'invalid_filter' },
            },
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
    },
  );
  it.each([
    ['committee', 'XyU'],
    ['party', 'unknown'],
    ['constituency', 'unknown'],
  ])('names the %s field in an unknown-code rejection', async (field, value) => {
    const network = vi.fn<typeof fetch>();
    initRiksdagService({ fetch: network });
    try {
      const result = await runToolContract(riksdagSearchMembers, { [field]: value });
      const message = `Invalid ${field}; use riksdag_list_reference to check its format or code.`;
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: { message, data: { reason: 'invalid_filter', field } } },
      });
      expect(
        result.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n'),
      ).toContain(message);
      expect(network).not.toHaveBeenCalled();
    } finally {
      getRiksdagService().dispose();
    }
  });
  it.each(['Pal%', '_alme', 'Sydow,B', '%'])(
    'rejects familyNamePrefix %s as invalid_filter before HTTP',
    async (familyNamePrefix) => {
      const network = vi.fn<typeof fetch>();
      initRiksdagService({ fetch: network });
      try {
        const result = await runToolContract(riksdagSearchMembers, {
          register: 'all',
          familyNamePrefix,
        });
        expect(result).toMatchObject({
          isError: true,
          structuredContent: {
            error: {
              code: JsonRpcErrorCode.ValidationError,
              message: 'familyNamePrefix cannot contain %, _ or a comma.',
              data: {
                reason: 'invalid_filter',
                field: 'familyNamePrefix',
                recovery: { hint: expect.stringContaining('nameContains') },
              },
            },
          },
        });
        const text = result.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n');
        expect(text).toContain('familyNamePrefix cannot contain');
        expect(text).toContain('nameContains');
        expect(network).not.toHaveBeenCalled();
      } finally {
        getRiksdagService().dispose();
      }
    },
  );
  it('rejects a malformed memberId at the schema with the format message on both surfaces', async () => {
    const message = 'Invalid memberId; use riksdag_list_reference to check its format or code.';
    const network = vi.fn<typeof fetch>();
    initRiksdagService({ fetch: network });
    try {
      for (const memberId of [
        'synthetic-source-uuid',
        '12345678-1234-4234-8234-123456789abc',
        '00 01',
        '０００１',
        '   ',
      ]) {
        expect(riksdagGetMember.input.safeParse({ memberId }).success).toBe(false);
        const result = await runToolContract(riksdagGetMember, { memberId });
        expect(result).toMatchObject({
          isError: true,
          structuredContent: { error: { code: JsonRpcErrorCode.InvalidParams } },
        });
        expect(JSON.stringify(result.structuredContent)).toContain(message);
        expect(
          result.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n'),
        ).toContain(message);
      }
      expect(network).not.toHaveBeenCalled();
    } finally {
      getRiksdagService().dispose();
    }
  });
  it('advertises a flag-free memberId pattern that admits padded digit IDs normalized by the handler', async () => {
    const schema = riksdagGetMember.input['~standard'].jsonSchema.input({
      target: 'draft-2020-12',
    }) as { properties: { memberId: { pattern?: string; minLength?: number } } };
    const pattern = schema.properties.memberId.pattern;
    expect(pattern).toEqual(expect.any(String));
    for (const id of ['0001', ' 0001 ', '\t0103624617217\n', '098412828516'])
      expect(new RegExp(pattern!).test(id)).toBe(true);
    for (const id of ['', 'synthetic-source-uuid', '0001a'])
      expect(new RegExp(pattern!).test(id)).toBe(false);
    initRiksdagService({ fetch: async () => Response.json({ personlista: { '@hits': '0' } }) });
    try {
      const padded = await runToolContract(riksdagGetMember, { memberId: ' 0001 ' });
      expect(padded.isError).not.toBe(true);
      expect(padded.structuredContent).toMatchObject({ found: false, memberId: '0001' });
    } finally {
      getRiksdagService().dispose();
    }
  });
});
