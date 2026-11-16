/** @fileoverview Speech mode validation before upstream access. @module tests/tools/speeches-tool */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { riksdagSearchSpeeches } from '@/mcp-server/tools/definitions/search-speeches.tool.js';
import { getRiksdagService, initRiksdagService } from '@/services/riksdag/riksdag-service.js';

interface JsonSchemaNode {
  $defs?: Record<string, JsonSchemaNode>;
  $ref?: string;
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  [key: string]: unknown;
}

type Emitter = (options: { target: 'draft-2020-12' }) => JsonSchemaNode;

/** The conversion the SDK applies when it serves `tools/list`. */
function emitted(schema: unknown, side: 'input' | 'output'): JsonSchemaNode {
  const { jsonSchema } = (schema as { '~standard': { jsonSchema: Record<typeof side, Emitter> } })[
    '~standard'
  ];
  return jsonSchema[side]({ target: 'draft-2020-12' });
}

describe('speech schema emission', () => {
  it('emits the speech item once under $defs and continuation args as open objects', () => {
    const output = emitted(riksdagSearchSpeeches.output, 'output');
    const item = output.$defs?.RiksdagSpeechItem;
    expect(Object.keys(output.$defs ?? {})).toEqual(['RiksdagSpeechItem']);
    expect(output.properties?.item?.$ref).toBe('#/$defs/RiksdagSpeechItem');
    expect(output.properties?.items?.items?.$ref).toBe('#/$defs/RiksdagSpeechItem');
    const continuations = {
      nextCall: output.properties?.nextCall?.properties?.args,
      nextTextCall: item?.properties?.nextTextCall?.properties?.args,
    };
    for (const [name, args] of Object.entries(continuations)) {
      expect(args, name).toMatchObject({ type: 'object' });
      expect(Object.keys(args?.properties ?? {}), name).toEqual([]);
      expect(JSON.stringify(args).length, name).toBeLessThan(200);
    }
    const input = JSON.stringify(emitted(riksdagSearchSpeeches.input, 'input'));
    expect(input).not.toContain('$defs');
    expect(input).not.toContain('$ref');
  });
  it.each([
    ['session', ['2024/25', '1999/2000', ' 2024/2025 '], ['2024-25', 'KU1']],
    ['memberId', ['0001', '0103624617217'], ['abc', '01-2']],
    ['speechId', ['HC0943-67', 'hc091-1'], ['synthetic-uuid-1', 'HC0943-067']],
    [
      'relatedDocumentId',
      ['HC01FÖU1', 'HC01FöU1', 'HC10150', 'sfs-2000-100'],
      ['KU1', 'HC10134, HC10150'],
    ],
  ] as const)('advertises a flag-free blank-admitting pattern for %s', (field, valid, invalid) => {
    const pattern = emitted(riksdagSearchSpeeches.input, 'input').properties?.[field]?.pattern;
    expect(typeof pattern).toBe('string');
    const regex = new RegExp(pattern as string);
    for (const value of ['', '  ', ...valid]) expect(regex.test(value), value).toBe(true);
    for (const value of invalid) expect(regex.test(value), value).toBe(false);
  });
});

describe('speech input contract', () => {
  afterEach(() => getRiksdagService().dispose());
  it.each([
    [{}, ['session']],
    [
      { mode: 'get', session: '2024/25', limit: 5, textCount: 1 },
      ['speechId', 'session', 'limit', 'textCount'],
    ],
    [
      { session: '2024/25', speechId: 'HC091-1', textOffset: 0, textLength: 1 },
      ['speechId', 'textOffset', 'textLength'],
    ],
  ] as const)('names missing and conflicting mode fields for %j', async (input, fields) => {
    const network = vi.fn<typeof fetch>();
    initRiksdagService({ fetch: network });
    const result = await runToolContract(riksdagSearchSpeeches, input);
    expect(result.isError).toBe(true);
    const rendered = JSON.stringify(result);
    for (const field of fields) expect(rendered).toContain(field);
    expect(network).not.toHaveBeenCalled();
  });
  it('names relatedDocumentId as a conflicting get-mode field', async () => {
    const network = vi.fn<typeof fetch>();
    initRiksdagService({ fetch: network });
    const result = await runToolContract(riksdagSearchSpeeches, {
      mode: 'get',
      speechId: 'HC091-1',
      relatedDocumentId: 'HC10698',
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          message:
            'Invalid speech get mode. Missing required fields: none. Conflicting supplied fields: relatedDocumentId.',
          data: { reason: 'invalid_filter' },
        },
      },
    });
    expect(network).not.toHaveBeenCalled();
  });
  it('names the riksdag_get_document relatedSpeechesCall chain in the description', () => {
    expect(riksdagSearchSpeeches.description).toContain('relatedDocumentId');
    expect(riksdagSearchSpeeches.description).toMatch(/riksdag_get_document.*relatedSpeechesCall/);
  });
  it.each([
    {},
    { session: '' },
    { mode: 'get', speechId: 'HC091-1', relatedDocumentId: 'HC10698' },
    { mode: 'get', speechId: 'HC091-1', relatedDocumentId: '' },
    { mode: 'get', speechId: 'HC091-1', memberId: ' ' },
    { session: '2024/26' },
    { session: '2024/25', relatedDocumentId: 'HC01FüU1' },
    { session: '2024/25', speechId: 'HC091-1' },
    { session: '2024/25', speechId: '' },
    { session: '2024/25', textOffset: 0 },
    { session: '2024/25', textLength: 1 },
    { mode: 'get' },
    { mode: 'get', speechId: '  ' },
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
  it.each([
    [{ mode: 'get', speechId: 'synthetic-uuid-1' }, 'speechId'],
    [{ session: '2024-25' }, 'session'],
    [{ session: '2024/25', memberId: 'source-uuid' }, 'memberId'],
    [{ session: '2024/25', relatedDocumentId: 'KU1' }, 'relatedDocumentId'],
    [{ session: '2024/25', relatedDocumentId: 'HC10134, HC10150' }, 'relatedDocumentId'],
  ] as const)(
    'rejects malformed %j at the schema with a message naming %s',
    async (input, field) => {
      const message =
        field === 'session'
          ? 'Invalid session; use YYYY/YY, consecutive YYYY/YYYY, or a calendar year YYYY.'
          : `Invalid ${field}; use riksdag_list_reference to check its format or code.`;
      const network = vi.fn<typeof fetch>();
      initRiksdagService({ fetch: network });
      const result = await runToolContract(riksdagSearchSpeeches, input);
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: JsonRpcErrorCode.InvalidParams,
            message: expect.stringContaining(message),
          },
        },
      });
      expect(JSON.stringify(result.content)).toContain(message);
      expect(network).not.toHaveBeenCalled();
    },
  );
  it('names relatedDocumentId when its value passes the pattern but not the normalizer', async () => {
    const message =
      'Invalid relatedDocumentId; use riksdag_list_reference to check its format or code.';
    const network = vi.fn<typeof fetch>();
    initRiksdagService({ fetch: network });
    // Decomposed ü: the pattern admits the combining mark, and NFC yields a non-Swedish letter.
    const result = await runToolContract(riksdagSearchSpeeches, {
      session: '2024/25',
      relatedDocumentId: 'HC01FüU1',
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message,
          data: { reason: 'invalid_filter', field: 'relatedDocumentId' },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain(message);
    expect(JSON.stringify(result)).not.toContain('Invalid documentId');
    expect(network).not.toHaveBeenCalled();
  });
});
