/** @fileoverview Canonical source text and reversible output rendering. @module tests/services/riksdag/text-output */
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { describe, expect, it } from 'vitest';
import {
  effectiveQuery,
  formatExact,
  renderExact,
  toolCallSchema,
} from '@/services/riksdag/output.js';
import {
  assertRevision,
  codePointLength,
  htmlToMarkdown,
  revisionOf,
  sliceCodePoints,
} from '@/services/riksdag/text.js';

/**
 * The canonical converter as one whole-document `translate`: every revision hashes its output, so
 * `htmlToMarkdown` must return exactly this for every input.
 */
const reference = new NodeHtmlMarkdown(
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

/** Block boundaries, converter state carried across them, and parser repairs of unclosed markup. */
const BOUNDARY_SHAPES: [name: string, html: string][] = [
  ['an empty body', ''],
  ['whitespace only', '  \n\t '],
  ['an empty document', '<html><head><title>T</title></head><body></body></html>'],
  [
    'a doctype, head and style',
    '<!DOCTYPE html>\n<HTML><HEAD><STYLE>p{}</STYLE></HEAD><BODY><P>a</P></BODY></HTML>',
  ],
  [
    'headings and paragraphs',
    '<h1>Rubrik</h1><p>Första.</p><h2>Under</h2><p>Andra</p>\n<h3></h3><p>Tredje</p>',
  ],
  ['inline runs between blocks', 'lead <b>bold</b> text<p>para</p> tail <i>it</i><div>d</div>end'],
  ['repeated delimiters across siblings', '<i>a</i><i>b</i><b>c</b><b>d</b><span>_</span><i>e</i>'],
  ['a delimiter after a block', '<p>x_</p><i>y</i><div>**</div><b>z</b>'],
  [
    'nested and ordered lists',
    '<ol><li>a</li><li>b<ul><li>c</li><li> </li></ul></li></ol><ol><li>d</li><li><p>e</p></li></ol>x<ul><li>f</li></ul>',
  ],
  [
    'ordered lists split by text',
    '<ol><li>1</li></ol>mellan<ol><li>2</li><li></li><li>3</li></ol>',
  ],
  ['a stray list item', '<p>a</p><li>lone</li><li>two</li>'],
  [
    'tables',
    '<table><caption>Tabell</caption><tr><th>Namn</th><th>Antal</th></tr><tr><td>A|B</td><td>0</td></tr></table>efter<table></table><table><tr><td></td></tr></table>',
  ],
  ['table cells outside a table', '<td></td><p>a</p><th>b</th><td> </td>'],
  [
    'preformatted text',
    '<p>a</p><pre>  x\n\n  y  </pre><pre><code class="language-js">let a = 1;\n</code></pre>b',
  ],
  ['preformatted trailing whitespace', '<pre>a\n        </pre><p>b</p><pre>c\n \n   </pre>d'],
  ['line breaks and rules', 'a<br><br><hr><p>b</p><br>c<br>'],
  ['block quotes', '<blockquote><p>q</p><blockquote>r</blockquote></blockquote><p>s</p>'],
  [
    'links at block edges',
    '<a href="/dokument/X">l</a><p><a href="https://data.riksdagen.se/a">m</a></p><a>n</a><a href="javascript:x">o</a><a href="/y"></a>',
  ],
  [
    'whitespace between blocks',
    '<p>a</p>   <p>b</p>\n\n<div> </div>\t<p>c</p> <span> </span> <p>d</p>',
  ],
  ['entities at boundaries', '<p>a&nbsp;</p>&nbsp;<p>&amp;b</p>&lt;p&gt;<p>&#42;</p>&#10;<p>x</p>'],
  ['markdown-looking text at line starts', '<p>- a</p><p>1. b</p><p># c</p>+ d<div>&gt; e</div>'],
  ['a trailing single space', 'a <span>b</span> '],
  ['a trailing line break', '<p>a<br></p>'],
  [
    'empty wrappers',
    '<div><span></span></div><p>x</p><div><div></div></div><section><p>y</p></section>',
  ],
  [
    'unclosed page nesting',
    '<div id="p1"><p>a</p><ingenbild></div>\n<div id="p2"><p>b</p><table><tr><td>1</td></tr></table><ingenbild></div>\n<div><p>c</div>',
  ],
  ['unclosed same-tag pairs', '<div><div><p>a</p><div><div>b'],
  ['paragraphs closed by openings', '<p>a<p>b<div>c</div>d<p>e'],
  ['closers that match nothing', '</div></p><p>a</span></p></body></html><p>b</p>'],
  ['nested anchors', '<a href="/x">1<a href="/y">2</a>3</a><b>4<a href="/z">5<div>6</div>'],
  ['unclosed inline elements', '<b>a<i>b<p>c</p>d'],
  ['an unclosed list', '<ul><li>a<li>b<ol><li>c'],
  ['an unclosed table', '<table><tr><td>a<td>b<tr><td>c'],
  [
    'a delimiter run before a literal {Infinity}',
    '<pre>a\n \n{Infinity}</pre><p>b</p><br><br>{Infinity}',
  ],
];

/**
 * A shape alone, then repeated past a few hundred nodes after leads of 0–32 repetitions, at top
 * level and inside a wrapper, so the shape's boundaries fall on every side of each piece the
 * conversion visits separately. The leads write nothing, delimiter runs, line breaks, or blocks.
 */
function placements(html: string): string[] {
  const body = html.repeat(Math.max(4, Math.ceil(600 / Math.max(html.length, 1))));
  const leads = [' <span> </span>', '<b>a</b>', 'a<br>', '<p>p</p>\n'];
  return [
    html,
    ...leads.flatMap((lead) =>
      Array.from({ length: 33 }, (_, count) => lead.repeat(count)).flatMap((prefix) => [
        prefix + body,
        `<div>${prefix}${body}</div>`,
      ]),
    ),
  ];
}

describe('whole-document identity', () => {
  it.each(BOUNDARY_SHAPES)('matches the whole-document converter on %s', (_, html) => {
    const mismatches = placements(html).filter(
      (placed) => htmlToMarkdown(placed) !== reference.translate(placed),
    );
    expect(mismatches).toEqual([]);
  });

  it('matches the converter on every short whitespace run before a literal {Infinity}', () => {
    const alphabet = ['\n', '\r', ' ', '\t', ' ', 'x'];
    let runs = [''];
    const all = [''];
    for (let length = 1; length <= 5; length++) {
      runs = runs.flatMap((run) => alphabet.map((char) => run + char));
      all.push(...runs);
    }
    const mismatches = all.filter((run) => {
      const html = `<pre>a${run}{Infinity}${run}{Infinity}</pre>`;
      return htmlToMarkdown(html) !== reference.translate(html);
    });
    expect(mismatches).toEqual([]);
  });

  it('matches the converter on generated markup mixing blocks, inline runs and unclosed tags', () => {
    let state = 0x9e3779b9;
    const random = (limit: number) => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) % limit;
    };
    const tags = [
      'div',
      'p',
      'span',
      'b',
      'i',
      'em',
      'a href="/d"',
      'h2',
      'ul',
      'ol',
      'li',
      'table',
      'tr',
      'td',
      'th',
      'caption',
      'pre',
      'code',
      'blockquote',
      'ingenbild',
      'section',
      'font',
    ];
    const texts = [
      'a',
      ' ',
      '\n',
      '\r\n',
      '&nbsp;',
      '&amp;',
      '*',
      '_',
      '#',
      '1. ',
      '- ',
      '|',
      '{Infinity}',
      'Riksdagen',
      '<br>',
      '<hr>',
    ];
    const failures: string[] = [];
    for (let doc = 0; doc < 300; doc++) {
      let html = '';
      for (let token = 0, count = 5 + random(600); token < count; token++) {
        const tag = tags[random(tags.length)]!;
        const roll = random(10);
        if (roll < 3) html += `<${tag}>`;
        else if (roll < 5) html += `</${tag.split(' ')[0]}>`;
        else html += texts[random(texts.length)];
      }
      if (htmlToMarkdown(html) !== reference.translate(html)) failures.push(html);
    }
    expect(failures).toEqual([]);
  });
});

describe('canonical text and output', () => {
  it('renders Markdown inline, reference and autolink URLs as usable links outside reversible source data', () => {
    const value = {
      text: '[inline](<https://data.riksdagen.se/inline>)\n\n[reference][source]\n\n[source]: https://data.riksdagen.se/reference\n\n<https://data.riksdagen.se/auto>',
      unsafe: '[secret](https://user:pass@example.test/)',
    };
    const rendered = renderExact(value);
    expect(rendered).toContain('[source 1](<https://data.riksdagen.se/inline>)');
    expect(rendered).toContain('[source 2](<https://data.riksdagen.se/reference>)');
    expect(rendered).toContain('[source 3](<https://data.riksdagen.se/auto>)');
    expect(rendered.slice(rendered.indexOf('\n```\n') + 5)).not.toContain('user:pass');
    const json = rendered.slice(rendered.indexOf('\n') + 1, rendered.indexOf('\n```\n'));
    expect(JSON.parse(json)).toEqual(value);
  });
  it('preserves headings, paragraphs, tables, lists and usable links while excluding executable content', () => {
    const result = htmlToMarkdown(
      '<h1>Rubrik</h1><p>Första stycket.</p><p>Andra <a href="/dokument/HC01KU1">källa</a>.</p><ul><li>En</li><li>Två</li></ul><table><tr><th>Namn</th><th>Antal</th></tr><tr><td>A</td><td>0</td></tr></table><script>alert(1)</script><style>.x{}</style><img src="https://example.test/x.png">',
    );
    expect(result).toContain('# Rubrik');
    expect(result).toContain('Första stycket.\n\nAndra');
    expect(result).toContain('[källa](<https://data.riksdagen.se/dokument/HC01KU1>)');
    expect(result).toContain('En');
    expect(result).toContain('Två');
    expect(result).toMatch(/\|\s*Namn\s*\|\s*Antal\s*\|/);
    expect(result).toMatch(/\|\s*A\s*\|\s*0\s*\|/);
    expect(result).not.toMatch(/alert\(1\)|\.x\{|x\.png/);
  });
  it('slices Unicode code points and preserves exact revision identity across object key order', async () => {
    expect(codePointLength('A😀å𐐀Z')).toBe(5);
    expect(sliceCodePoints('A😀å𐐀Z', 1, 3)).toBe('😀å𐐀');
    expect(sliceCodePoints('A😀', 4, 10)).toBe('');
    expect(await revisionOf({ b: [2, 1], a: 'å' })).toBe(await revisionOf({ a: 'å', b: [2, 1] }));
    expect(await revisionOf({ a: 'å', b: [1, 2] })).not.toBe(
      await revisionOf({ a: 'å', b: [2, 1] }),
    );
    expect(await revisionOf({})).toBe(
      '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    );
    expect(() => assertRevision(undefined, 'new')).not.toThrow();
    expect(() => assertRevision('old', 'new')).toThrow(
      expect.objectContaining({ data: { reason: 'revision_changed' } }),
    );
  });
  it('round-trips source control characters, Markdown and delimiter runs', () => {
    const value = {
      title: '# source\r\n\u0000\t```json\nend',
      nested: [{ false: false, zero: 0, url: 'https://data.riksdagen.se/x?q=a&b=2' }],
    };
    const rendered = renderExact(value);
    const firstNewline = rendered.indexOf('\n');
    const delimiter = rendered.slice(0, firstNewline).replace(/json$/, '');
    const jsonEnd = rendered.indexOf(`\n${delimiter}`, firstNewline);
    expect(JSON.parse(rendered.slice(firstNewline + 1, jsonEnd))).toEqual(value);
    expect(rendered).toContain('[source 1](<https://data.riksdagen.se/x?q=a&b=2>)');
    expect(formatExact(value)).toEqual([{ type: 'text', text: rendered }]);
    expect(effectiveQuery({ z: false, absent: undefined, a: 0 })).toBe('{"a":0,"z":false}');
  });
});

describe('continuation call schema', () => {
  const schema = toolCallSchema('riksdag_search_documents');
  it('keeps every argument value unchanged and pins the tool name', () => {
    const call = {
      toolName: 'riksdag_search_documents',
      args: { documentType: 'mot', offset: 20, nested: { a: [1, 'å'] }, flag: false },
    };
    expect(schema.parse(call)).toEqual(call);
    expect(schema.safeParse({ ...call, toolName: 'riksdag_get_document' }).success).toBe(false);
    expect(schema.safeParse({ toolName: call.toolName }).success).toBe(false);
    expect(schema.safeParse({ toolName: call.toolName, args: [1] }).success).toBe(false);
  });
  it('emits args as an open object that restates no input schema', () => {
    const emitted = schema['~standard'].jsonSchema.output({ target: 'draft-2020-12' }) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(emitted.properties.toolName).toMatchObject({ const: 'riksdag_search_documents' });
    const args = emitted.properties.args!;
    expect(args).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: {},
      description:
        'Complete normalized arguments for riksdag_search_documents, valid against its input schema; pass back unchanged.',
    });
    expect(new TextEncoder().encode(JSON.stringify(args)).byteLength).toBeLessThan(200);
  });
});
