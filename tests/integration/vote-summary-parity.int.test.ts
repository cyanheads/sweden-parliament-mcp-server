/** @fileoverview Complete report-summary parity through nested table cells. @module tests/integration/vote-summary-parity */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, expect, it } from 'vitest';
import { riksdagGetVotes } from '@/mcp-server/tools/definitions/get-votes.tool.js';
import { getRiksdagService, initRiksdagService } from '@/services/riksdag/riksdag-service.js';

afterEach(() => getRiksdagService().dispose());

it('retains every nested table cell on both report output surfaces', async () => {
  initRiksdagService({
    fetch: async (url) =>
      Response.json(
        String(url).includes('/dokumentstatus/')
          ? {
              dokumentstatus: {
                dokument: { dok_id: 'H601NU9', doktyp: 'bet', rm: '2018/19', beteckning: 'NU9' },
                dokutskottsforslag: {
                  utskottsforslag: {
                    punkt: '2',
                    beslutstyp: 'acklamation',
                    votering_sammanfattning_html: {
                      table: [
                        {
                          thead: { tr: { th: ['Parti', 'Ja'] } },
                          tbody: {
                            tr: [
                              { th: 'S', td: ['0', '', { '#text': 'Å😀\r\n```\t' }, {}] },
                              { th: 'M', td: ['https://example.org/vote', '12'] },
                            ],
                          },
                          tfooter: { tr: { th: 'Totalt', td: ['12'] } },
                        },
                        { tbody: { tr: { th: 'Other', td: ['second table'] } } },
                      ],
                    },
                  },
                },
              },
            }
          : { voteringlista: { '@antal': '0', votering: [] } },
      ),
  });
  const result = await runToolContract(riksdagGetVotes, {
    mode: 'report',
    session: '2018/19',
    documentId: 'H601NU9',
    point: 2,
  });
  expect(result.isError).not.toBe(true);
  const domain = riksdagGetVotes.output.parse(result.structuredContent);
  expect(domain.points?.[0]?.decision.summaries).toEqual([
    {
      columns: ['Parti', 'Ja'],
      rows: [
        { label: 'S', cells: ['0', '', 'Å😀\r\n```\t', null] },
        { label: 'M', cells: ['https://example.org/vote', '12'] },
      ],
      footer: { label: 'Totalt', cells: ['12'] },
    },
    { rows: [{ label: 'Other', cells: ['second table'] }] },
  ]);
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('Expected rendered domain text.');
  const newline = first.text.indexOf('\n');
  const fence = first.text.slice(0, newline).replace(/json$/, '');
  const rendered: unknown = JSON.parse(
    first.text.slice(newline + 1, first.text.indexOf(`\n${fence}`, newline)),
  );
  expect(rendered).toEqual(domain);
  expect(first.text).toContain('](<https://example.org/vote>)');
});
