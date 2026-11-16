/**
 * @fileoverview Lossless quoted-data rendering and continuation schemas.
 * @module services/riksdag/output
 */
import { z } from '@cyanheads/mcp-ts-core';
import { fromMarkdown } from 'mdast-util-from-markdown';

/** Every success, including misses and cache hits, declares this enrichment shape. */
export const successEnrichment = {
  effectiveQuery: z.string().describe('Normalized input, defaults and local filters.'),
  source: z.string().describe('Required attribution to the Swedish Parliament.'),
  retrievedAt: z.string().describe('Source fetch time; unchanged on cache hits.'),
  notices: z
    .array(z.string().describe('A limitation, applied bound or next-step notice.'))
    .describe('Applicable notices, possibly empty.'),
  upstreamQuery: z.string().optional().describe('Upstream query echo, not proof a filter applied.'),
  upstreamWarnings: z
    .array(z.string().describe('An upstream warning, verbatim.'))
    .optional()
    .describe('Source warnings.'),
};

/** Agent-facing success context is kept outside the handler domain result. */
export type SuccessEnrichment = z.infer<z.ZodObject<typeof successEnrichment>>;

/**
 * Output shape of a continuation call. `args` is an open object rather than a restatement of
 * the named tool's input schema, which would serialize that schema again into every output
 * schema in `tools/list`; the values are still complete normalized arguments.
 */
export function toolCallSchema<const T extends string>(toolName: T) {
  return z.object({
    toolName: z.literal(toolName).describe('Tool to call next.'),
    args: z
      .looseObject({})
      .describe(
        `Complete normalized arguments for ${toolName}, valid against its input schema; pass back unchanged.`,
      ),
  });
}

function fence(json: string): string {
  const runs = json.match(/`+/g) ?? [];
  const delimiter = '`'.repeat(runs.reduce((longest, run) => Math.max(longest, run.length + 1), 3));
  return `${delimiter}json\n${json}\n${delimiter}`;
}

interface MarkdownLinkNode {
  children?: readonly MarkdownLinkNode[];
  type: string;
  url?: string;
}

function addLink(url: string, found: Set<string>): void {
  if (!/^https?:\/\/[^\s<>]+$/i.test(url)) return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (!parsed.username && !parsed.password) found.add(url);
}

function markdownLinks(node: MarkdownLinkNode, found: Set<string>): void {
  if ((node.type === 'link' || node.type === 'definition') && node.url !== undefined)
    addLink(node.url, found);
  if (node.children) for (const child of node.children) markdownLinks(child, found);
}

function links(value: unknown, found: Set<string>): void {
  if (typeof value === 'string') {
    addLink(value, found);
    if (value.includes('[') || value.includes('<http')) markdownLinks(fromMarkdown(value), found);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) links(item, found);
    return;
  }
  if (value !== null && typeof value === 'object')
    for (const item of Object.values(value)) links(item, found);
}

/** Reversible JSON protects arbitrary CR/LF and source Markdown; URL values also get usable links. */
export function renderExact(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined)
    throw new Error('Only JSON-serializable output values can be rendered.');
  const urls = new Set<string>();
  links(value, urls);
  const renderedLinks = Array.from(urls, (url, index) => `[source ${index + 1}](<${url}>)`);
  return `${fence(serialized)}${renderedLinks.length ? `\n\n${renderedLinks.join('\n\n')}` : ''}`;
}

/** Shared format function retains every domain field on the text surface. */
export function formatExact(value: unknown): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: renderExact(value) }];
}

const trailerField = (key: string, value: unknown): string => `**${key}:**\n${renderExact(value)}`;

/** Explicit trailer renderers preserve structured notices and source-authored warning text. */
export const successEnrichmentTrailer = {
  effectiveQuery: { render: (value: string) => trailerField('effectiveQuery', value) },
  source: { render: (value: string) => trailerField('source', value) },
  retrievedAt: { render: (value: string) => trailerField('retrievedAt', value) },
  notices: { render: (value: string[]) => trailerField('notices', value) },
  upstreamQuery: {
    render: (value: string | undefined) =>
      value === undefined ? '' : trailerField('upstreamQuery', value),
  },
  upstreamWarnings: {
    render: (value: string[] | undefined) =>
      value === undefined ? '' : trailerField('upstreamWarnings', value),
  },
};

/** Stable query echo includes all normalized modes, defaults and local filter choices. */
export function effectiveQuery(input: object): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(input)
        .filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}
