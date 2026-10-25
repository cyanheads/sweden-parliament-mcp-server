/** @fileoverview Canonical source text and reversible output rendering. @module tests/services/riksdag/text-output */
import { describe, expect, it } from 'vitest';
import { effectiveQuery, formatExact, renderExact } from '@/services/riksdag/output.js';
import {
  assertRevision,
  codePointLength,
  htmlToMarkdown,
  revisionOf,
  sliceCodePoints,
} from '@/services/riksdag/text.js';

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
