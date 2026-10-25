/** @fileoverview Offline reference pagination and declared tool inputs. @module tests/tools/list-reference.tool */
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { listReference } from '@/mcp-server/tools/definitions/list-reference.tool.js';

describe('riksdag_list_reference', () => {
  it.each([
    'document_types',
    'committees',
    'parties',
    'constituencies',
    'speech_types',
    'sessions',
    'identifiers',
    'coverage',
  ] as const)('traverses every %s entry with complete continuation arguments', async (topic) => {
    let input = listReference.input.parse({ topic, limit: 3 });
    let returned = 0;
    const identities = new Set<string>();
    for (;;) {
      const page = await listReference.handler(input, createMockContext());
      expect(listReference.output.safeParse(page).success).toBe(true);
      expect(page.offset).toBe(returned);
      expect(page.returnedCount).toBe(page.entries.length);
      for (const entry of page.entries) {
        const identity = JSON.stringify(entry);
        expect(identities.has(identity)).toBe(false);
        identities.add(identity);
      }
      returned += page.entries.length;
      if (!page.hasMore) {
        expect(page.nextCall).toBeUndefined();
        expect(returned).toBe(page.totalCount);
        break;
      }
      expect(page.nextCall).toEqual({
        toolName: 'riksdag_list_reference',
        args: { topic, offset: returned, limit: 3 },
      });
      input = listReference.input.parse(page.nextCall?.args);
    }
    expect(returned).toBeGreaterThan(0);
  });
  it('returns a terminal empty page past the end and clamps excessive requests', async () => {
    const page = await listReference.handler(
      listReference.input.parse({ topic: 'parties', offset: 10000, limit: 101 }),
      createMockContext(),
    );
    expect(page).toMatchObject({
      entries: [],
      offset: 10000,
      limit: 100,
      requestedLimit: 101,
      returnedCount: 0,
      hasMore: false,
      truncated: false,
    });
    expect(page.nextCall).toBeUndefined();
  });
  it('rejects unknown topics, non-integer offsets and impossible limits', () => {
    for (const args of [
      { topic: 'other' },
      { topic: 'parties', offset: -1 },
      { topic: 'parties', offset: 0.5 },
      { topic: 'parties', limit: 0 },
      { topic: 'parties', limit: 10001 },
    ])
      expect(listReference.input.safeParse(args).success).toBe(false);
  });
  it('retains distinct document subtype values and source series leading zeros', async () => {
    const entries = [];
    let input = listReference.input.parse({ topic: 'document_types', limit: 100 });
    for (;;) {
      const page = await listReference.handler(input, createMockContext());
      entries.push(...page.entries);
      if (!page.nextCall) break;
      input = listReference.input.parse(page.nextCall.args);
    }
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'bet',
          subtype: '',
          seriesCode: '01',
          labelSv: 'Betänkande',
        }),
        expect.objectContaining({ code: 'bet', subtype: 'utl', labelSv: 'Utlåtande' }),
        expect.objectContaining({ code: 'utskottsdokument', subtype: 'EU-frågor' }),
        expect.objectContaining({ code: 'utskottsdokument', subtype: 'Uppföljningsaktivite' }),
      ]),
    );
  });
});
