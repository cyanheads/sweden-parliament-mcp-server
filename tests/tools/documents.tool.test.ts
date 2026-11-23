/** @fileoverview Document tool input boundaries and format projections. @module tests/tools/documents.tool */
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { riksdagGetDocument } from '@/mcp-server/tools/definitions/get-document.tool.js';
import { riksdagSearchDocuments } from '@/mcp-server/tools/definitions/search-documents.tool.js';
import { getRiksdagService, initRiksdagService } from '@/services/riksdag/riksdag-service.js';

type JsonSchemaNode = {
  $defs?: Record<string, JsonSchemaNode>;
  enum?: unknown[];
  items?: JsonSchemaNode;
  pattern?: string;
  properties?: Record<string, JsonSchemaNode>;
};

function emitted(schema: { '~standard': unknown }, side: 'input' | 'output'): JsonSchemaNode {
  const standard = schema['~standard'] as {
    jsonSchema: Record<'input' | 'output', (options: { target: string }) => JsonSchemaNode>;
  };
  return standard.jsonSchema[side]({ target: 'draft-2020-12' });
}

describe('document tool schema emission', () => {
  it('emits decision summaries once under $defs and open continuation args', () => {
    const output = emitted(riksdagGetDocument.output, 'output');
    expect(Object.keys(output.$defs ?? {}).sort()).toEqual([
      'RiksdagDecisionSummary',
      'RiksdagDecisionSummaryRow',
    ]);
    const serialized = JSON.stringify(output);
    expect(serialized.match(/"#\/\$defs\/RiksdagDecisionSummary"/g)).toHaveLength(2);
    expect(serialized.match(/"#\/\$defs\/RiksdagDecisionSummaryRow"/g)).toHaveLength(2);
    const calls = [
      output.properties?.sectionPages?.items?.properties?.nextCall,
      output.properties?.nextTextCall,
      output.properties?.nextHtmlCall,
      emitted(riksdagSearchDocuments.output, 'output').properties?.nextCall,
    ];
    for (const call of calls) {
      const args = call?.properties?.args;
      expect(args).toBeDefined();
      expect(args?.properties ?? {}).toEqual({});
      expect(JSON.stringify(args).length).toBeLessThan(200);
    }
    for (const definition of [riksdagGetDocument, riksdagSearchDocuments])
      expect(JSON.stringify(emitted(definition.input, 'input'))).not.toMatch(/\$defs|\$ref/);
  });
  it('advertises identifier, session and date patterns and the ten section keys', () => {
    const getInput = emitted(riksdagGetDocument.input, 'input').properties ?? {};
    const searchInput = emitted(riksdagSearchDocuments.input, 'input').properties ?? {};
    const pattern = (node: JsonSchemaNode | undefined) => new RegExp(node?.pattern ?? '(?!)');
    for (const value of ['HC01FÖU1', 'sfs-2000-100', 'sfs-N2026-7'])
      expect(pattern(getInput.documentId).test(value)).toBe(true);
    expect(pattern(getInput.documentId).test('')).toBe(false);
    for (const [field, value] of [
      ['session', '2024/25'],
      ['session', '1999/2000'],
      ['session', ''],
      ['dateFrom', '2025-01-02'],
      ['dateTo', ' '],
      ['memberId', '0103624617217'],
    ] as const)
      expect(pattern(searchInput[field]).test(value)).toBe(true);
    expect(getInput.sections?.items?.enum).toEqual([
      'metadata',
      'decisions',
      'reservations',
      'activities',
      'properties',
      'attachments',
      'references',
      'stakeholders',
      'text',
      'source_html',
    ]);
    expect(riksdagGetDocument.errors?.map((entry) => entry.reason)).not.toContain(
      'unknown_section',
    );
  });
});

describe('document tool boundaries', () => {
  it('applies economical defaults without interpreting a bare report as an ID', () => {
    expect(riksdagSearchDocuments.input.parse({})).toEqual({ page: 1, pageSize: 10, offset: 0 });
    expect(riksdagGetDocument.input.parse({ documentId: 'HC01KU1' })).toMatchObject({
      textOffset: 0,
      htmlOffset: 0,
      sectionOffset: 0,
      sectionLimit: 20,
    });
    for (const input of [{ page: 0 }, { pageSize: 0 }, { page: 1.5 }])
      expect(riksdagSearchDocuments.input.safeParse(input).success).toBe(false);
    for (const input of [
      { documentId: '' },
      { documentId: '   ' },
      { documentId: 'KU1' },
      { documentId: 'HC01KU1', sections: ['made_up'] },
      { documentId: 'HC01KU1', sections: ['TEXT'] },
      { documentId: 'HC01KU1', textOffset: -1 },
      { documentId: 'HC01KU1', textLength: 0 },
      { documentId: 'HC01KU1', htmlLength: 1.5 },
    ])
      expect(riksdagGetDocument.input.safeParse(input).success).toBe(false);
    for (const input of [{ session: '2024-25' }, { dateFrom: '2025/01/02' }, { memberId: 'x' }])
      expect(riksdagSearchDocuments.input.safeParse(input).success).toBe(false);
  });
  it('admits every accepted raw form and blank optional filters at the schema', () => {
    for (const documentId of [' hc01ku1 ', 'hc01föu9', 'SFS 2000:100', 'sfs-N2026-7'])
      expect(riksdagGetDocument.input.safeParse({ documentId }).success).toBe(true);
    expect(riksdagGetDocument.input.parse({ documentId: 'HC01KU1', sections: [] })).toMatchObject({
      sections: [],
    });
    expect(
      riksdagSearchDocuments.input.safeParse({
        session: ' ',
        dateFrom: '',
        dateTo: ' ',
        memberId: '',
      }).success,
    ).toBe(true);
    expect(
      riksdagSearchDocuments.input.safeParse({
        session: ' 1999/00 ',
        dateFrom: '2025-01-02',
        memberId: ' 0103624617217 ',
      }).success,
    ).toBe(true);
  });
  it('rejects value-level identifier and filter failures before any HTTP request', async () => {
    const network = vi.fn<typeof fetch>();
    initRiksdagService({ fetch: network });
    try {
      await expect(
        riksdagGetDocument.handler(
          riksdagGetDocument.input.parse({ documentId: 'HC01KŮ' }),
          createMockContext({ errors: riksdagGetDocument.errors }),
        ),
      ).rejects.toMatchObject({ data: { reason: 'invalid_filter' } });
      for (const input of [
        { session: '2025/27' },
        { documentType: 'unknown' },
        { dateFrom: '2025-02-29' },
        { dateFrom: '2025-01-02', dateTo: '2025-01-01' },
      ])
        await expect(
          riksdagSearchDocuments.handler(
            riksdagSearchDocuments.input.parse(input),
            createMockContext({ errors: riksdagSearchDocuments.errors }),
          ),
        ).rejects.toMatchObject({ data: { reason: 'invalid_filter' } });
      expect(network).not.toHaveBeenCalled();
    } finally {
      getRiksdagService().dispose();
    }
  });
  it('names dateFrom or dateTo in malformed and impossible date failures', async () => {
    for (const field of ['dateFrom', 'dateTo'] as const) {
      const parsed = riksdagSearchDocuments.input.safeParse({ [field]: '2025/01/02' });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toMatch(new RegExp(`^Invalid ${field};`));
    }
    const network = vi.fn<typeof fetch>();
    initRiksdagService({ fetch: network });
    try {
      for (const field of ['dateFrom', 'dateTo'] as const)
        await expect(
          riksdagSearchDocuments.handler(
            riksdagSearchDocuments.input.parse({ [field]: '2025-02-29' }),
            createMockContext({ errors: riksdagSearchDocuments.errors }),
          ),
        ).rejects.toMatchObject({
          message: expect.stringMatching(new RegExp(`^Invalid ${field};`)),
          data: { reason: 'invalid_filter', field },
        });
      expect(network).not.toHaveBeenCalled();
    } finally {
      getRiksdagService().dispose();
    }
  });
  it('sends a committee code typed without its Swedish letter as the code and names committee when none matches', async () => {
    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ dokumentlista: { '@traffar': '0' } }));
    initRiksdagService({ fetch: network });
    try {
      for (const [committee, org] of [
        ['fou', 'FöU'],
        ['UFOU', 'UFöU'],
      ] as const) {
        network.mockClear();
        await riksdagSearchDocuments.handler(
          riksdagSearchDocuments.input.parse({ documentType: 'bet', committee }),
          createMockContext({ errors: riksdagSearchDocuments.errors }),
        );
        expect(new URL(String(network.mock.calls[0]?.[0])).searchParams.get('org')).toBe(org);
      }
      network.mockClear();
      await expect(
        riksdagSearchDocuments.handler(
          riksdagSearchDocuments.input.parse({ committee: 'saru' }),
          createMockContext({ errors: riksdagSearchDocuments.errors }),
        ),
      ).rejects.toMatchObject({
        message: expect.stringMatching(/^Invalid committee;/),
        data: { reason: 'invalid_filter', field: 'committee' },
      });
      expect(network).not.toHaveBeenCalled();
    } finally {
      getRiksdagService().dispose();
    }
  });
});
