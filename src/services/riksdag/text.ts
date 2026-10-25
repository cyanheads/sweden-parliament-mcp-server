/**
 * @fileoverview Canonical HTML conversion, code-point slices and revision guards.
 * @module services/riksdag/text
 */
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { NodeHtmlMarkdown } from 'node-html-markdown';

const converter = new NodeHtmlMarkdown(
  {
    ignore: ['script', 'style', 'iframe', 'object', 'embed', 'img'],
    maxConsecutiveNewlines: Number.POSITIVE_INFINITY,
    useInlineLinks: false,
  },
  {
    a: ({ node }) => {
      const href = node.getAttribute('href');
      if (!href) return {};
      let url: URL;
      try {
        url = new URL(href, 'https://data.riksdagen.se');
      } catch {
        return {};
      }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return {};
      return {
        prefix: '[',
        postfix: `](<${url.href.replaceAll('<', '%3C').replaceAll('>', '%3E')}>)`,
      };
    },
  },
);

/** Converts once with a maintained HTML parser; source HTML stays separately available. */
export function htmlToMarkdown(html: string): string {
  return converter.translate(html);
}

/** Counts Unicode code points rather than UTF-16 code units. */
export function codePointLength(text: string): number {
  return Array.from(text).length;
}

/** Slices the canonical representation without splitting surrogate pairs. */
export function sliceCodePoints(text: string, offset: number, length: number): string {
  return Array.from(text)
    .slice(offset, offset + length)
    .join('');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

/** Hashes a complete normalized record; callers exclude fetch time and hydration. */
export async function revisionOf(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A continuation never silently joins pages from different record revisions. */
export function assertRevision(expected: string | undefined, actual: string): void {
  if (expected !== undefined && expected !== actual)
    throw new McpError(
      JsonRpcErrorCode.Conflict,
      'The source record changed during continuation.',
      { reason: 'revision_changed' },
    );
}
