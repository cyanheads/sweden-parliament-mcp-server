/** @fileoverview tools/list weight guard: no restated input schemas, no repeated large output subtrees, no removed truncated fields. @module tests/tools/schema-weight */
import { createHash } from 'node:crypto';
import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { riksdagGetDocument } from '@/mcp-server/tools/definitions/get-document.tool.js';
import { riksdagGetMember } from '@/mcp-server/tools/definitions/get-member.tool.js';
import { riksdagGetVotes } from '@/mcp-server/tools/definitions/get-votes.tool.js';
import { listReference } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { riksdagSearchDocuments } from '@/mcp-server/tools/definitions/search-documents.tool.js';
import { riksdagSearchMembers } from '@/mcp-server/tools/definitions/search-members.tool.js';
import { riksdagSearchSpeeches } from '@/mcp-server/tools/definitions/search-speeches.tool.js';
import { toolCallSchema } from '@/services/riksdag/output.js';

/** Smallest serialized subtree whose repetition within one output schema counts as dead weight. */
const REPEAT_MIN_BYTES = 1000;
/** Ceiling for one continuation `args` node, which carries only its description. */
const ARGS_MAX_BYTES = 200;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Emitter = {
  '~standard': { jsonSchema: Record<'input' | 'output', (options: object) => unknown> };
};

const emit = (schema: Emitter, io: 'input' | 'output') =>
  schema['~standard'].jsonSchema[io]({ target: 'draft-2020-12' }) as Json;
const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;
const isObject = (node: Json): node is { [key: string]: Json } =>
  node !== null && typeof node === 'object' && !Array.isArray(node);

/**
 * Every subtree of at least `minBytes` (canonical compact JSON, keys sorted) that occurs more
 * than once, keyed by a SHA-256 of that serialization. Only maximal repeats are reported: a
 * repeat whose every occurrence sits inside an occurrence of another reported repeat is implied.
 */
function repeatedSubtrees(schema: Json, minBytes = REPEAT_MIN_BYTES) {
  const seen = new Map<string, { bytes: number; paths: string[] }>();
  const canonical = (node: Json, path: string): string => {
    if (node === null || typeof node !== 'object') return JSON.stringify(node);
    const text = Array.isArray(node)
      ? `[${node.map((item, index) => canonical(item, `${path}/${index}`)).join(',')}]`
      : `{${Object.keys(node)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(node[key]!, `${path}/${key}`)}`)
          .join(',')}}`;
    const bytes = byteLength(text);
    if (bytes >= minBytes) {
      const hash = createHash('sha256').update(text).digest('hex');
      const entry = seen.get(hash) ?? { bytes, paths: [] };
      entry.paths.push(path || '/');
      seen.set(hash, entry);
    }
    return text;
  };
  canonical(schema, '');
  const repeats = [...seen.values()].filter(({ paths }) => paths.length > 1);
  const occurrences = repeats.flatMap(({ paths }) => paths);
  return repeats
    .filter(
      ({ paths }) =>
        !paths.every((path) => occurrences.some((outer) => path.startsWith(`${outer}/`))),
    )
    .sort((left, right) => right.bytes - left.bytes);
}

/** Continuation `args` nodes: any object schema whose `toolName` is a constant tool name. */
function continuationArgs(schema: Json, path = ''): { path: string; args: Json }[] {
  if (Array.isArray(schema))
    return schema.flatMap((item, index) => continuationArgs(item, `${path}/${index}`));
  if (!isObject(schema)) return [];
  const found: { path: string; args: Json }[] = [];
  const properties = schema.properties;
  if (
    isObject(properties ?? null) &&
    isObject((properties as Record<string, Json>).toolName ?? null) &&
    typeof ((properties as Record<string, Json>).toolName as Record<string, Json>).const ===
      'string'
  )
    found.push({
      path: `${path}/properties/args`,
      args: (properties as Record<string, Json>).args ?? null,
    });
  for (const [key, value] of Object.entries(schema))
    found.push(...continuationArgs(value, `${path}/${key}`));
  return found;
}

/** Problems with continuation `args`: declared properties, a missing node, or excess weight. */
function argsProblems(schema: Json): string[] {
  return continuationArgs(schema).flatMap(({ path, args }) => {
    if (!isObject(args)) return [`${path} is missing or not an object schema`];
    const problems: string[] = [];
    if (isObject(args.properties ?? null) && Object.keys(args.properties as object).length > 0)
      problems.push(
        `${path} declares properties ${Object.keys(args.properties as object).join(', ')}`,
      );
    if (args.$ref !== undefined) problems.push(`${path} references ${String(args.$ref)}`);
    const bytes = byteLength(JSON.stringify(args));
    if (bytes >= ARGS_MAX_BYTES) problems.push(`${path} is ${bytes} B (limit ${ARGS_MAX_BYTES} B)`);
    return problems;
  });
}

/** Every path at which a schema declares a property named `key`. */
function propertyPaths(schema: Json, key: string, path = ''): string[] {
  if (Array.isArray(schema))
    return schema.flatMap((item, index) => propertyPaths(item, key, `${path}/${index}`));
  if (!isObject(schema)) return [];
  return Object.entries(schema).flatMap(([name, value]) => [
    ...(name === 'properties' && isObject(value) && Object.hasOwn(value, key)
      ? [`${path}/properties/${key}`]
      : []),
    ...propertyPaths(value, key, `${path}/${name}`),
  ]);
}

/** Every `$defs` or `$ref` key path in a schema. */
function definitionKeys(schema: Json, path = ''): string[] {
  if (Array.isArray(schema))
    return schema.flatMap((item, index) => definitionKeys(item, `${path}/${index}`));
  if (!isObject(schema)) return [];
  return Object.entries(schema).flatMap(([key, value]) => [
    ...(key === '$defs' || key === '$ref' ? [`${path}/${key}`] : []),
    ...definitionKeys(value, `${path}/${key}`),
  ]);
}

const tools = [
  listReference,
  riksdagSearchDocuments,
  riksdagGetDocument,
  riksdagSearchSpeeches,
  riksdagGetVotes,
  riksdagSearchMembers,
  riksdagGetMember,
] as const;
const toolCases = tools.map((definition) => [definition.name, definition] as const);

describe('tools/list schema weight', () => {
  it('covers all seven registered tools', () => {
    expect(new Set(tools.map((definition) => definition.name)).size).toBe(7);
  });
  it.each(toolCases)('%s continuation args restate no input schema', (_name, definition) => {
    const output = emit(definition.output as unknown as Emitter, 'output');
    expect(argsProblems(output)).toEqual([]);
  });
  it.each(toolCases)('%s output repeats no subtree of 1,000 B or more', (_name, definition) => {
    const output = emit(definition.output as unknown as Emitter, 'output');
    const repeats = repeatedSubtrees(output).map(
      ({ bytes, paths }) => `${bytes} B ×${paths.length}: ${paths.join(' | ')}`,
    );
    expect(repeats).toEqual([]);
  });
  it.each(toolCases)('%s input schema carries no $defs or $ref', (_name, definition) => {
    const input = emit(definition.input as unknown as Emitter, 'input');
    expect(definitionKeys(input)).toEqual([]);
  });
  it.each(toolCases)(
    '%s output declares truncated only at the riksdag_get_document and riksdag_get_member root',
    (name, definition) => {
      const output = emit(definition.output as unknown as Emitter, 'output');
      expect(propertyPaths(output, 'truncated')).toEqual(
        name === 'riksdag_get_document' || name === 'riksdag_get_member'
          ? ['/properties/truncated']
          : [],
      );
    },
  );
});

describe('schema weight detectors', () => {
  const field = (index: number) =>
    z.string().describe(`Synthetic field ${index} with enough description text to weigh in.`);
  const big = () =>
    z.object(
      Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`f${index}`, field(index)])),
    );
  const inputSchema = z.object({
    topic: z.enum(['a', 'b']).describe('Topic.'),
    offset: z.number().int().min(0).describe('Offset.'),
  });

  it('flags a large subtree repeated at two output fields, and nothing once it is defined once', () => {
    const item = big();
    const repeated = emit(z.object({ item, items: z.array(item) }) as unknown as Emitter, 'output');
    const repeats = repeatedSubtrees(repeated);
    expect(repeats).toHaveLength(1);
    expect(repeats[0]!.bytes).toBeGreaterThanOrEqual(REPEAT_MIN_BYTES);
    expect(repeats[0]!.paths).toEqual(['/properties/item', '/properties/items/items']);
    const shared = big().meta({ id: 'SyntheticItem' });
    const defined = emit(
      z.object({ item: shared, items: z.array(shared) }) as unknown as Emitter,
      'output',
    );
    expect(repeatedSubtrees(defined)).toEqual([]);
    expect(definitionKeys(defined)).toEqual(
      expect.arrayContaining(['/$defs', '/properties/item/$ref']),
    );
  });
  it('flags a near-duplicate whose copies differ only in their use-site description', () => {
    const item = big();
    const output = emit(
      z.object({
        first: item.describe('First use.'),
        second: item.describe('Second use.'),
      }) as unknown as Emitter,
      'output',
    );
    expect(repeatedSubtrees(output).map(({ paths }) => paths)).toEqual([
      ['/properties/first/properties', '/properties/second/properties'],
    ]);
  });
  it('ignores a repeated subtree below the threshold', () => {
    const small = z.object({ a: z.string().describe('Small.') });
    expect(
      repeatedSubtrees(emit(z.object({ x: small, y: small }) as unknown as Emitter, 'output')),
    ).toEqual([]);
  });
  it('flags continuation args that restate an input schema, and passes toolCallSchema', () => {
    const restated = z.object({
      nextCall: z
        .object({ toolName: z.literal('synthetic_tool').describe('Tool.'), args: inputSchema })
        .optional(),
    });
    expect(argsProblems(emit(restated as unknown as Emitter, 'output'))).toEqual([
      '/properties/nextCall/properties/args declares properties topic, offset',
      '/properties/nextCall/properties/args is 248 B (limit 200 B)',
    ]);
    const open = z.object({ nextCall: toolCallSchema('synthetic_tool').optional() });
    expect(argsProblems(emit(open as unknown as Emitter, 'output'))).toEqual([]);
    expect(continuationArgs(emit(open as unknown as Emitter, 'output'))).toHaveLength(1);
  });
  it('flags $defs and $ref in an input schema that reuses an identified schema', () => {
    const shared = inputSchema.meta({ id: 'SyntheticInput' });
    const input = emit(z.object({ a: shared, b: shared }) as unknown as Emitter, 'input');
    expect(definitionKeys(input)).toEqual(
      expect.arrayContaining(['/$defs', '/properties/a/$ref', '/properties/b/$ref']),
    );
  });
});
