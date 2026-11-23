/**
 * @fileoverview Canonical HTML conversion, code-point slices and revision guards.
 * @module services/riksdag/text
 */
import { createRequire } from 'node:module';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { contentlessElements } from 'node-html-markdown/dist/config.js';
import {
  getTrailingWhitespaceInfo,
  nodeHtmlParserConfig,
} from 'node-html-markdown/dist/utilities.js';
import { Visitor } from 'node-html-markdown/dist/visitor.js';
import type * as Parser from 'node-html-parser';
import type * as ParserTree from 'node-html-parser/dist/nodes/html.js';

/** node-html-parser exactly as node-html-markdown resolves it, so the tree is the converter's own. */
const requireParser = createRequire(createRequire(import.meta.url).resolve('node-html-markdown'));
const { HTMLElement, NodeType } = requireParser('node-html-parser') as typeof Parser;
const { base_parse } = requireParser('node-html-parser/dist/nodes/html.js') as typeof ParserTree;

/** The parser lowercases `[a-zA-Z][-.:0-9_a-zA-Z]*` tag names, so it never produces this one. */
const SEED_TAG = 'riksdag#seed';

/** Carries the output tail into a fresh converter visit; renders as exactly that text. */
class Seed extends HTMLElement {
  readonly tail: string;
  constructor(tail: string) {
    super(SEED_TAG, {});
    this.tail = tail;
  }
}

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
    [SEED_TAG]: ({ node }) => ({ content: (node as Seed).tail }),
  },
);

/**
 * The converter's state between two sibling visits is its output's emptiness and last characters:
 * `getTrailingWhitespaceInfo` reads at most this many, and a repeated delimiter reads one.
 */
const TAIL_LENGTH = 10;
/**
 * Most nodes one converter visit covers, unless a single element the converter must visit whole is
 * larger. A wrapper at or under this size is visited whole too.
 */
const VISIT_NODES = 64;
const CONTENTLESS = new Set(contentlessElements);
const INFINITY_MARK = '{Infinity}';
const WHITESPACE = /\s/;

/**
 * Parses as node-html-parser's `parse` does with the converter's options. `base_parse` leaves
 * unclosed elements on its stack; `parse` then dissolves each one into its parent, or into its
 * grandparent when it sits directly in an unclosed element of the same tag, appending its children
 * after the target's existing ones. Here those moves are recorded as linked blocks and applied once.
 */
function parseHtml(html: string): Parser.HTMLElement {
  type Block = { nodes: Parser.Node[]; next?: Block };
  /** `base_parse` returns its stack of still-open elements, which starts with the root. */
  const stack = base_parse(html, nodeHtmlParserConfig) as [
    Parser.HTMLElement,
    ...Parser.HTMLElement[],
  ];
  const [root] = stack;
  const moved = new Map<Parser.HTMLElement, { first: Block; last: Block }>();
  let last = stack.pop();
  for (let oneBefore = stack.at(-1); last && oneBefore; oneBefore = stack.at(-1)) {
    if (last.parentNode?.parentNode) {
      const sameTag = last.parentNode === oneBefore && last.tagName === oneBefore.tagName;
      const target = sameTag ? oneBefore.parentNode : oneBefore;
      oneBefore.removeChild(last);
      const own: Block = { nodes: last.childNodes };
      const inherited = moved.get(last);
      moved.delete(last);
      if (inherited) own.next = inherited.first;
      const end = inherited?.last ?? own;
      const existing = moved.get(target);
      if (existing) {
        existing.last.next = own;
        existing.last = end;
      } else moved.set(target, { first: own, last: end });
      if (sameTag) stack.pop();
    }
    last = stack.pop();
  }
  for (const [element, { first }] of moved) {
    const children: Parser.Node[] = [];
    for (let block: Block | undefined = first; block; block = block.next) {
      for (const child of block.nodes) {
        child.parentNode = element;
        children.push(child);
      }
    }
    element.childNodes = element.childNodes.concat(children);
  }
  return root;
}

/**
 * Newlines the converter writes around an element whose visit is only those newlines and its
 * children in order, or `undefined` when its translator does more and the converter visits it whole.
 * The list, preformatted and table elements, whose visits also pass state to their children, all
 * have factory or option-carrying translators, so they never qualify.
 */
function wrapperNewlines(node: Parser.Node): number | undefined {
  if (node.nodeType !== NodeType.ELEMENT_NODE) return undefined;
  const tag = ((node as Parser.HTMLElement).tagName || '').toUpperCase();
  if (!tag) return 0;
  const config = converter.translators.get(tag);
  if (config === undefined) return 0;
  if (
    typeof config === 'function' ||
    Object.keys(config).some((key) => key !== 'surroundingNewlines' && key !== 'preserveIfEmpty')
  )
    return undefined;
  return config.surroundingNewlines ? +config.surroundingNewlines : 0;
}

type Entry = { node: Parser.Node; size: number; kept: boolean };

/**
 * The tree in document order with each subtree's node count and whether the converter keeps it (its
 * `optimizeTree` rule: text, a contentless element, an empty element its translator keeps, or any
 * kept child).
 */
function flatten(root: Parser.Node): Entry[] {
  const entries: Entry[] = [];
  const open: { entry: Entry; children: Iterator<Parser.Node>; anyKept: boolean }[] = [];
  const enter = (node: Parser.Node) => {
    const entry = { node, size: 1, kept: false };
    entries.push(entry);
    open.push({ entry, children: node.childNodes.values(), anyKept: false });
  };
  enter(root);
  for (let frame = open.at(-1); frame; frame = open.at(-1)) {
    const child = frame.children.next();
    if (!child.done) {
      enter(child.value);
      continue;
    }
    open.pop();
    const { entry } = frame;
    const tag = ((entry.node as Parser.HTMLElement).tagName || '').toUpperCase();
    if (entry.node.nodeType === NodeType.TEXT_NODE || CONTENTLESS.has(tag)) entry.kept = true;
    else if (entry.node.childNodes.length > 0) entry.kept = frame.anyKept;
    else {
      const translator = tag ? converter.translators.get(tag) : undefined;
      entry.kept = typeof translator === 'function' || Boolean(translator?.preserveIfEmpty);
    }
    const parent = open.at(-1);
    if (parent) {
      parent.entry.size += entry.size;
      parent.anyKept ||= entry.kept;
    }
  }
  return entries;
}

/**
 * The converter's whole-document visit, run in pieces. Wrapper elements are walked here, writing
 * their newlines against the output tail exactly as the converter's `appendNewlines` does; every
 * other node is visited by the converter itself under a fresh root that first replays the output
 * tail, so it sees the same emptiness, trailing whitespace and last character as in one visit.
 */
function render(root: Parser.HTMLElement): string {
  const parts: string[] = [];
  let written = 0;
  let tail = '';
  let batch: Parser.Node[] = [];
  let batchNodes = 0;
  const append = (piece: string) => {
    if (!piece) return;
    parts.push(piece);
    written += piece.length;
    tail = (piece.length >= TAIL_LENGTH ? piece : tail + piece).slice(-TAIL_LENGTH);
  };
  const visitBatch = () => {
    if (batch.length === 0) return;
    const visitRoot = new HTMLElement('', {});
    const seed = written > 0 ? new Seed(tail) : undefined;
    visitRoot.childNodes = seed ? [seed, ...batch] : batch;
    append(new Visitor(converter, visitRoot).result.text.slice(seed?.tail.length ?? 0));
    batch = [];
    batchNodes = 0;
  };
  const newlines = (count: number) => {
    visitBatch();
    append('\n'.repeat(Math.max(0, count - getTrailingWhitespaceInfo(tail).newLines)));
  };
  const open: { end: number; newlines: number }[] = [];
  const close = (until: number) => {
    for (let wrapper = open.at(-1); wrapper && wrapper.end <= until; wrapper = open.at(-1)) {
      open.pop();
      if (wrapper.newlines) newlines(wrapper.newlines);
    }
  };
  const entries = flatten(root);
  let next = 0;
  for (const [index, { node, size, kept }] of entries.entries()) {
    if (index < next) continue;
    close(index);
    next = index + size;
    if (!kept) continue;
    const count = size > VISIT_NODES ? wrapperNewlines(node) : undefined;
    if (count === undefined) {
      if (batchNodes > 0 && batchNodes + size > VISIT_NODES) visitBatch();
      batch.push(node);
      batchNodes += size;
    } else {
      if (count) newlines(count);
      open.push({ end: next, newlines: count });
      next = index + 1;
    }
  }
  close(entries.length);
  visitBatch();
  return parts.join('');
}

/**
 * The converter's closing pass for these options. `maxConsecutiveNewlines: Infinity` makes it apply
 * `(?:\r?\n\s*)+((?:\r?\n\s*){Infinity})` → `$1`, where `{Infinity}` is literal text: a match is a
 * whitespace run ending at that text that holds a line break after its first one, and it keeps the
 * run from its last `\n`. Then leading and trailing `\n` go, and a single trailing space with them.
 */
function finish(raw: string): string {
  let collapsed = '';
  let copied = 0;
  for (
    let mark = raw.indexOf(INFINITY_MARK);
    mark !== -1;
    mark = raw.indexOf(INFINITY_MARK, mark + INFINITY_MARK.length)
  ) {
    let run = mark;
    while (run > copied && WHITESPACE.test(raw.charAt(run - 1))) run--;
    let first = run;
    while (first < mark && raw[first] !== '\n' && !(raw[first] === '\r' && raw[first + 1] === '\n'))
      first++;
    if (first === mark) continue;
    const last = raw.lastIndexOf('\n', mark - 1);
    if (last < first + (raw[first] === '\r' ? 2 : 1)) continue;
    collapsed += raw.slice(copied, first);
    copied = last;
  }
  collapsed += raw.slice(copied);
  let start = 0;
  let end = collapsed.length;
  while (start < end && collapsed[start] === '\n') start++;
  while (end > start && collapsed[end - 1] === '\n') end--;
  const result = collapsed.slice(start, end);
  return result.endsWith(' ') && !result.endsWith('  ') ? result.trimEnd() : result;
}

/**
 * Converts once with a maintained HTML parser; source HTML stays separately available. The result is
 * exactly the converter's whole-document `translate` of the same HTML, produced from bounded visits.
 */
export function htmlToMarkdown(html: string): string {
  return finish(render(parseHtml(html)));
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
