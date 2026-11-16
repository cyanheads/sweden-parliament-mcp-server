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
    { mode: 'member' as const, memberId: '0001', documentId: 'HC01KU1' },
    { mode: 'member' as const, memberId: '0001', report: 'KU1', documentId: 'HC01KU1' },
    { mode: 'member' as const, memberId: '0001', point: 1 },
    { mode: 'member' as const, memberId: '0001', report: 'KU1', pointOffset: 0 },
    { mode: 'member' as const, memberId: '0001', report: '2025/26:KU1' },
    { mode: 'member' as const, memberId: '0001', pointOffset: 0 },
    { mode: 'member' as const, memberId: '0001', pointLimit: 5 },
    { mode: 'report' as const, report: '2025/26:KU1' },
    // A decomposed ü matches the raw pattern; NFC then yields a non-Swedish letter.
    { mode: 'report' as const, documentId: 'HC01FüU1' },
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
  it.each([
    { field: 'memberId', input: { mode: 'member', memberId: 'source-uuid' } },
    { field: 'report', input: { mode: 'member', memberId: '0001', report: 'KU' } },
    { field: 'report', input: { mode: 'report', report: 'KU1:2' } },
    { field: 'documentId', input: { mode: 'report', documentId: 'KU1' } },
    { field: 'session', input: { mode: 'report', report: 'KU1', session: ' ' } },
    { field: 'session', input: { mode: 'report', report: 'KU1', session: '2024-25' } },
  ] as const)(
    'rejects a malformed $field at the schema with its format message %j',
    async ({ field, input }) => {
      const network = vi.fn<typeof fetch>();
      initRiksdagService({ fetch: network });
      try {
        const result = await runToolContract(riksdagGetVotes, { session: '2024/25', ...input });
        const message =
          field === 'session'
            ? 'Invalid session; use YYYY/YY, consecutive YYYY/YYYY, or a calendar year YYYY.'
            : `Invalid ${field}; use riksdag_list_reference to check its format or code.`;
        expect(result).toMatchObject({
          isError: true,
          structuredContent: { error: { code: JsonRpcErrorCode.InvalidParams } },
        });
        expect(JSON.stringify(result.structuredContent)).toContain(message);
        expect(JSON.stringify(result.content)).toContain(message);
        expect(network).not.toHaveBeenCalled();
      } finally {
        getRiksdagService().dispose();
      }
    },
  );
  it('keeps session arithmetic a handler invalid_filter behind a matching pattern', async () => {
    const network = vi.fn<typeof fetch>();
    initRiksdagService({ fetch: network });
    try {
      const result = await runToolContract(riksdagGetVotes, {
        mode: 'report',
        session: '2024/26',
        report: 'KU1',
      });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: { data: { reason: 'invalid_filter' } } },
      });
      expect(network).not.toHaveBeenCalled();
    } finally {
      getRiksdagService().dispose();
    }
  });
  it('advertises flag-free patterns that admit every raw form the handler accepts', () => {
    const schema = (
      riksdagGetVotes.input as unknown as {
        '~standard': { jsonSchema: { input: (options: object) => unknown } };
      }
    )['~standard'].jsonSchema.input({ target: 'draft-2020-12' }) as {
      properties: Record<string, { pattern?: string }>;
    };
    const accepted: Record<string, string[]> = {
      session: [' 2024/25 ', '2024/2025', '1999/00', '2024'],
      report: ['', ' ', 'FöU1', 'föu1', '2024/25:FöU1', '2024/25 :KU1', '2024/25: FöU1'],
      documentId: ['', ' ', 'HC01FÖU1', 'hc01föu9', ' HC01KU1 '],
      memberId: ['', ' ', '098412828516', ' 0103624617217 '],
    };
    for (const [field, values] of Object.entries(accepted)) {
      const pattern = schema.properties[field]?.pattern;
      expect(pattern, field).toBeDefined();
      const regex = new RegExp(pattern ?? '');
      for (const value of values) {
        expect(regex.test(value), `${field} ${JSON.stringify(value)}`).toBe(true);
        expect(
          riksdagGetVotes.input.safeParse({ mode: 'report', session: '2024/25', [field]: value })
            .success,
        ).toBe(true);
      }
    }
    expect(new RegExp(schema.properties.session?.pattern ?? '').test(' ')).toBe(false);
  });
  it('accepts a member-mode report and point with one member/session request', async () => {
    const network = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        voteringlista: {
          '@antal': '1',
          votering: {
            votering_id: 'v1',
            intressent_id: '0001',
            rm: '2024/25',
            beteckning: 'KU1',
            punkt: '1',
          },
        },
      }),
    );
    initRiksdagService({ fetch: network });
    try {
      const result = await runToolContract(riksdagGetVotes, {
        mode: 'member',
        session: '2024/25',
        memberId: '0001',
        report: 'KU1',
        point: 1,
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ totalCount: 1, votes: [{ voteId: 'v1' }] });
      expect(network).toHaveBeenCalledTimes(1);
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
