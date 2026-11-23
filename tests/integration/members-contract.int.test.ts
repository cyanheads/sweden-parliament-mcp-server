/** @fileoverview Member register wire-to-tool response contracts. @module tests/integration/members-contract */
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { riksdagGetMember } from '@/mcp-server/tools/definitions/get-member.tool.js';
import { riksdagSearchMembers } from '@/mcp-server/tools/definitions/search-members.tool.js';
import { successEnrichment } from '@/services/riksdag/output.js';
import { getRiksdagService, initRiksdagService } from '@/services/riksdag/riksdag-service.js';
import { continuationArgs } from '../services/riksdag/continuation-fixtures.js';
import {
  memberDetail,
  memberRows,
  registerPayload,
  rosterAssignment,
  rosterRows,
  rosterRowWithoutCurrentAssignment,
  SOURCE_TIME,
} from '../services/riksdag/member-fixtures.js';

afterEach(() => {
  vi.useRealTimers();
  getRiksdagService().dispose();
});
function assertSuccess(result: Awaited<ReturnType<typeof runToolContract>>) {
  expect(result.isError).not.toBe(true);
  const enrichment = z.object(successEnrichment).parse(result.structuredContent);
  expect(enrichment.source).toBe('Source: The Swedish Parliament');
  const body = text(result);
  expect(body).toContain('Source: The Swedish Parliament');
  expect(body).toContain(enrichment.retrievedAt);
  for (const notice of enrichment.notices)
    expect(body).toContain(JSON.stringify(notice).slice(1, -1));
  return enrichment;
}
function domainText(result: Awaited<ReturnType<typeof runToolContract>>): unknown {
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('Expected domain text.');
  const firstNewline = first.text.indexOf('\n');
  const delimiter = first.text.slice(0, firstNewline).replace(/json$/, '');
  return JSON.parse(
    first.text.slice(firstNewline + 1, first.text.indexOf(`\n${delimiter}`, firstNewline)),
  );
}
const SERVICE_NOTICE =
  'Service-register status is not proof of elected membership; minister and unknown labels remain unknown.';
function rosterItem(
  iid: string,
  givenName: string,
  familyName: string,
  party: string,
  constituency: string,
  status: string,
  serviceClassification: 'serving' | 'not_serving' | 'unknown',
) {
  const sourceRecordId = `00000000-0000-4000-8000-00000000${iid}`;
  return {
    memberId: iid,
    sourceRecordId,
    detailAvailable: true,
    name: `${givenName} ${familyName}`,
    givenName,
    familyName,
    party,
    constituency,
    status,
    serviceClassification,
    sourceUrl: `https://data.riksdagen.se/person/${sourceRecordId}`,
  };
}
const ROSTER_ITEMS = [
  rosterItem(
    '0101',
    'Anna',
    'Palmén Synthetic',
    'S',
    'Stockholms kommun',
    'Tjänstgörande riksdagsledamot',
    'serving',
  ),
  rosterItem(
    '0102',
    'Bertil',
    'Synthetic',
    'SD',
    'Skåne läns västra',
    'Tjänstgörande riksdagsledamot',
    'serving',
  ),
  rosterItem(
    '0103',
    'Cecilia',
    'von Synthetic',
    'S',
    'Stockholms län',
    'Tjänstgörande ersättare',
    'serving',
  ),
  rosterItem(
    '0104',
    'David',
    'Synthetic',
    'M',
    'Stockholms kommun',
    'Tidigare riksdagsledamot',
    'not_serving',
  ),
];
const HISTORICAL_UUID = '12345678-1234-4234-8234-123456789abc';
describe('member calls without committee or familyNamePrefix', () => {
  it('send the same URLs and return the same rows, counts, notices and revisions', async () => {
    const historical = {
      intressent_id: HISTORICAL_UUID,
      sourceid: HISTORICAL_UUID,
      tilltalsnamn: 'Olof',
      efternamn: 'Palme',
      sorteringsnamn: 'Palme,Olof',
      status: 'Tidigare riksdagsledamot',
      person_url_xml: `https://data.riksdagen.se/person/${HISTORICAL_UUID}`,
      personuppdrag: '',
    };
    const network = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const query = new URL(String(url)).searchParams;
      if (query.get('rdlstatus') === 'samtliga')
        return Response.json(registerPayload([...rosterRows(), historical], 6));
      const party = query.get('parti');
      return Response.json(
        registerPayload(rosterRows().filter((row) => party === null || row.parti === party)),
      );
    });
    initRiksdagService({ fetch: network });
    const cases = [
      {
        args: {},
        url: 'https://data.riksdagen.se/personlista/?rdlstatus=tjanst&utformat=json',
        expected: {
          items: ROSTER_ITEMS,
          candidateCount: 4,
          sourceReportedCount: 4,
          totalCount: 4,
          returnedCount: 4,
          offset: 0,
          limit: 20,
          requestedLimit: 20,
          revision: '0fa0847ee0d7764f0b1e08e3e34a8605738da07a7c31bfb06b59ffa0a3f93706',
          hasMore: false,
          effectiveQuery: '{"limit":20,"offset":0,"register":"service","sitting":"all"}',
          source: 'Source: The Swedish Parliament',
          notices: [SERVICE_NOTICE],
        },
      },
      {
        args: { party: 'SD' },
        url: 'https://data.riksdagen.se/personlista/?parti=SD&rdlstatus=tjanst&utformat=json',
        expected: {
          items: [ROSTER_ITEMS[1]],
          candidateCount: 1,
          sourceReportedCount: 1,
          totalCount: 1,
          returnedCount: 1,
          offset: 0,
          limit: 20,
          requestedLimit: 20,
          revision: '0caefad85fcdca42c4ca98bbcafca2c629de3b2675bbdbd8f84745a97a7d9ce7',
          hasMore: false,
          effectiveQuery:
            '{"limit":20,"offset":0,"party":"SD","register":"service","sitting":"all"}',
          source: 'Source: The Swedish Parliament',
          notices: [SERVICE_NOTICE],
        },
      },
      {
        args: { register: 'all' as const, nameContains: 'Palme' },
        url: 'https://data.riksdagen.se/personlista/?rdlstatus=samtliga&utformat=json',
        expected: {
          items: [
            ROSTER_ITEMS[0],
            {
              sourceRecordId: HISTORICAL_UUID,
              detailAvailable: false,
              name: 'Olof Palme',
              givenName: 'Olof',
              familyName: 'Palme',
              status: 'Tidigare riksdagsledamot',
              serviceClassification: 'not_serving',
              sourceUrl: `https://data.riksdagen.se/person/${HISTORICAL_UUID}`,
            },
          ],
          candidateCount: 5,
          sourceReportedCount: 6,
          totalCount: 2,
          returnedCount: 2,
          offset: 0,
          limit: 20,
          requestedLimit: 20,
          revision: 'fe72d65c410fd78ff6b5381e3dad5853712a597f8fef0a42f166392ebb639435',
          hasMore: false,
          effectiveQuery:
            '{"limit":20,"nameContains":"Palme","offset":0,"register":"all","sitting":"all"}',
          source: 'Source: The Swedish Parliament',
          notices: [
            SERVICE_NOTICE,
            'All-register scope covers returned source records, not an independently verified historical census. Cold requests can reach the normal timeout.',
            'Source-reported hits (6) differ from returned candidate records (5); totals count returned records.',
            'Some entries have no published member IID: detailAvailable is false and sourceRecordId is a distinct register UUID. Read their sourceUrl; do not pass the UUID to riksdag_get_member.',
          ],
        },
      },
    ];
    for (const [index, { args, url, expected }] of cases.entries()) {
      const result = await runToolContract(riksdagSearchMembers, args);
      assertSuccess(result);
      expect(String(network.mock.calls[index]?.[0])).toBe(url);
      const { retrievedAt: _retrievedAt, ...rest } = result.structuredContent as Record<
        string,
        unknown
      >;
      expect(rest).toEqual(expected);
      expect(domainText(result)).toEqual(
        riksdagSearchMembers.output.parse(result.structuredContent),
      );
    }
    expect(network).toHaveBeenCalledTimes(3);
  });
});
const FIU_ROSTER = [
  {
    ...ROSTER_ITEMS[0],
    committeeAssignments: [
      rosterAssignment('Suppleant', '2026-10-06 11:00:00', '2030-10-01 10:59:00'),
    ],
  },
  {
    ...ROSTER_ITEMS[1],
    committeeAssignments: [
      rosterAssignment('Suppleant', '2026-10-06 11:00:00', '2030-10-01 10:59:00'),
      rosterAssignment('Suppleant', '2026-10-06 11:00:00', '2030-10-01 10:59:00'),
    ],
  },
  {
    ...ROSTER_ITEMS[2],
    committeeAssignments: [rosterAssignment('Extra suppleant', '2026-11-01', '2026-11-23')],
  },
  {
    ...ROSTER_ITEMS[3],
    committeeAssignments: [
      rosterAssignment('Ordförande', '2026-10-06 11:31:00', '2030-09-23 10:59:00'),
    ],
  },
];
/** Answers each `personlista` URL as the source would for the synthetic FiU roster. */
function rosterNetwork() {
  return vi.fn<typeof fetch>().mockImplementation(async (url) => {
    const query = new URL(String(url)).searchParams;
    const organ = query.get('org');
    const prefix = query.get('enamn');
    const party = query.get('parti');
    if (organ !== null && organ !== 'FiU') return Response.json(registerPayload([], 0));
    const rows = rosterRows().filter(
      (row) =>
        (party === null || row.parti === party) &&
        (prefix === null || row.sorteringsnamn.toLowerCase().startsWith(prefix.toLowerCase())),
    );
    const assignments = rows.reduce(
      (total, row) =>
        total +
        row.personuppdrag.uppdrag.filter(
          (entry) => entry.organ_kod === 'FiU' && entry.tom >= '2026-11-23',
        ).length,
      0,
    );
    return Response.json(registerPayload(rows, organ === null ? rows.length : assignments));
  });
}
function text(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}
describe('committee rosters and family-name prefixes', () => {
  it.each(['FiU', 'fiu', ' Finansutskottet ', 'Committee on Finance'])(
    'resolves committee %s to org=FiU and returns each holder’s current FiU roles on both surfaces',
    async (committee) => {
      const network = rosterNetwork();
      initRiksdagService({ fetch: network });
      const result = await runToolContract(riksdagSearchMembers, { committee });
      const enrichment = assertSuccess(result);
      expect(network.mock.calls.map(([url]) => String(url))).toEqual([
        'https://data.riksdagen.se/personlista/?org=FiU&rdlstatus=tjanst&utformat=json',
      ]);
      const page = riksdagSearchMembers.output.parse(result.structuredContent);
      expect(page).toMatchObject({
        items: FIU_ROSTER,
        candidateCount: 4,
        sourceReportedCount: 5,
        totalCount: 4,
        hasMore: false,
      });
      expect(domainText(result)).toEqual(page);
      expect(text(result)).toContain('"committeeAssignments"');
      expect(enrichment.effectiveQuery).toBe(
        '{"committee":"FiU","limit":20,"offset":0,"register":"service","sitting":"all"}',
      );
      expect(enrichment.notices).toEqual([
        SERVICE_NOTICE,
        'Source-reported hits (5) count FiU assignments and differ from returned member records (4); totals count returned records.',
      ]);
    },
  );
  it.each([
    ['fou', 'FöU'],
    ['UFOU', 'UFöU'],
  ])('resolves the ASCII committee spelling %s to org=%s', async (committee, code) => {
    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json(registerPayload(rosterRows(code.toUpperCase()), 5)),
      );
    initRiksdagService({ fetch: network });
    const result = await runToolContract(riksdagSearchMembers, { committee });
    const enrichment = assertSuccess(result);
    expect(new URL(String(network.mock.calls[0]?.[0])).searchParams.get('org')).toBe(code);
    expect(enrichment.effectiveQuery).toContain(`"committee":"${code}"`);
    expect(result.structuredContent).toMatchObject({
      items: [
        { memberId: '0101', committeeAssignments: [{ organ: code.toUpperCase() }] },
        { memberId: '0102' },
        { memberId: '0103' },
        { memberId: '0104' },
      ],
    });
  });
  it('sends committee with party upstream and returns the same roster from the all register', async () => {
    const network = rosterNetwork();
    initRiksdagService({ fetch: network });
    const withParty = await runToolContract(riksdagSearchMembers, { committee: 'FiU', party: 's' });
    const partyEnrichment = assertSuccess(withParty);
    expect(withParty.structuredContent).toMatchObject({
      items: [FIU_ROSTER[0], FIU_ROSTER[2]],
      sourceReportedCount: 2,
      totalCount: 2,
    });
    expect(partyEnrichment.notices).toEqual([SERVICE_NOTICE]);
    const all = await runToolContract(riksdagSearchMembers, { committee: 'FiU', register: 'all' });
    const allEnrichment = assertSuccess(all);
    expect(all.structuredContent).toMatchObject({ items: FIU_ROSTER, totalCount: 4 });
    expect(allEnrichment.notices).toContain(
      'All-register scope covers returned source records, not an independently verified historical census.',
    );
    expect(allEnrichment.notices.join(' ')).not.toContain('normal timeout');
    expect(network.mock.calls.map(([url]) => String(url))).toEqual([
      'https://data.riksdagen.se/personlista/?org=FiU&parti=S&rdlstatus=tjanst&utformat=json',
      'https://data.riksdagen.se/personlista/?org=FiU&rdlstatus=samtliga&utformat=json',
    ]);
  });
  it('narrows a roster with familyNamePrefix upstream and nameContains, constituency and sitting locally', async () => {
    const network = rosterNetwork();
    initRiksdagService({ fetch: network });
    const result = await runToolContract(riksdagSearchMembers, {
      committee: 'FiU',
      familyNamePrefix: 'syn',
      nameContains: 'cecilia',
      constituency: 'Stockholms län',
      sitting: 'serving',
    });
    assertSuccess(result);
    expect(String(network.mock.calls[0]?.[0])).toBe(
      'https://data.riksdagen.se/personlista/?enamn=syn&org=FiU&rdlstatus=tjanst&utformat=json',
    );
    expect(result.structuredContent).toMatchObject({
      items: [FIU_ROSTER[2]],
      candidateCount: 3,
      totalCount: 1,
    });
    const narrowed = await runToolContract(riksdagSearchMembers, {
      committee: 'FiU',
      familyNamePrefix: 'syn',
      sitting: 'not_serving',
    });
    expect(narrowed.structuredContent).toMatchObject({ items: [FIU_ROSTER[3]], totalCount: 1 });
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('pages a roster with committee and familyNamePrefix in nextCall, then reaches offset past the end', async () => {
    const network = rosterNetwork();
    initRiksdagService({ fetch: network });
    const first = await runToolContract(riksdagSearchMembers, { committee: 'fiu', limit: 2 });
    assertSuccess(first);
    const page = riksdagSearchMembers.output.parse(first.structuredContent);
    expect(page.items).toEqual(FIU_ROSTER.slice(0, 2));
    expect(page.nextCall).toEqual({
      toolName: 'riksdag_search_members',
      args: {
        register: 'service',
        committee: 'FiU',
        sitting: 'all',
        offset: 2,
        limit: 2,
        revision: page.revision,
      },
    });
    const second = await runToolContract(
      riksdagSearchMembers,
      continuationArgs(riksdagSearchMembers, page.nextCall),
    );
    assertSuccess(second);
    expect(second.structuredContent).toMatchObject({
      items: FIU_ROSTER.slice(2),
      revision: page.revision,
      hasMore: false,
    });
    expect(domainText(second)).toEqual(riksdagSearchMembers.output.parse(second.structuredContent));
    const past = await runToolContract(riksdagSearchMembers, { committee: 'FiU', offset: 99 });
    assertSuccess(past);
    expect(past.structuredContent).toMatchObject({ items: [], totalCount: 4, hasMore: false });
    const clamped = await runToolContract(riksdagSearchMembers, { committee: 'FiU', limit: 101 });
    expect(assertSuccess(clamped).notices).toContain('Requested limit was clamped to 100.');
    expect(clamped.structuredContent).toMatchObject({ limit: 100, requestedLimit: 101 });
    expect(network).toHaveBeenCalledTimes(1);
    const prefixed = await runToolContract(riksdagSearchMembers, {
      familyNamePrefix: 'Syn',
      limit: 1,
    });
    expect(
      riksdagSearchMembers.output.parse(prefixed.structuredContent).nextCall?.args,
    ).toMatchObject({ familyNamePrefix: 'Syn', offset: 1 });
  });
  it('carries committee and familyNamePrefix in the revision', async () => {
    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(registerPayload(rosterRows())));
    initRiksdagService({ fetch: network });
    const plain = riksdagSearchMembers.output.parse(
      (await runToolContract(riksdagSearchMembers, { limit: 1 })).structuredContent,
    );
    const prefixed = riksdagSearchMembers.output.parse(
      (await runToolContract(riksdagSearchMembers, { familyNamePrefix: 'Syn', limit: 1 }))
        .structuredContent,
    );
    expect(prefixed.items).toEqual(plain.items);
    expect(prefixed.revision).not.toBe(plain.revision);
    const crossed = await runToolContract(riksdagSearchMembers, {
      familyNamePrefix: 'Syn',
      revision: plain.revision,
    });
    expect(crossed).toMatchObject({
      isError: true,
      structuredContent: { error: { data: { reason: 'revision_changed' } } },
    });
  });
  it('keeps a holder with no current committee assignment with an empty list and a notice', async () => {
    initRiksdagService({
      fetch: async () =>
        Response.json(registerPayload([...rosterRows(), rosterRowWithoutCurrentAssignment()], 5)),
    });
    const result = await runToolContract(riksdagSearchMembers, { committee: 'FiU' });
    const enrichment = assertSuccess(result);
    expect(result.structuredContent).toMatchObject({
      items: [...FIU_ROSTER, { memberId: '0105', committeeAssignments: [] }],
      sourceReportedCount: 5,
      totalCount: 5,
    });
    expect(enrichment.notices).toEqual([
      SERVICE_NOTICE,
      `Some returned members hold no FiU assignment current at the source time (${SOURCE_TIME}); their committeeAssignments is empty.`,
    ]);
    expect(domainText(result)).toEqual(riksdagSearchMembers.output.parse(result.structuredContent));
  });
  it('fails upstream_identity_mismatch on both surfaces when a row lacks the committee', async () => {
    initRiksdagService({
      fetch: async () =>
        Response.json(
          registerPayload([
            ...rosterRows(),
            { intressent_id: '0109', personuppdrag: { uppdrag: { organ_kod: 'SkU' } } },
          ]),
        ),
    });
    const result = await runToolContract(riksdagSearchMembers, { committee: 'FiU' });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: JsonRpcErrorCode.SerializationError,
          data: {
            reason: 'upstream_identity_mismatch',
            recovery: { hint: expect.stringContaining('committee') },
          },
        },
      },
    });
    expect(text(result)).toContain('committee');
  });
  it('reports a committee with no current holders', async () => {
    const network = rosterNetwork();
    initRiksdagService({ fetch: network });
    const result = await runToolContract(riksdagSearchMembers, { committee: 'CKrU' });
    const enrichment = assertSuccess(result);
    expect(result.structuredContent).toMatchObject({ items: [], candidateCount: 0, totalCount: 0 });
    expect(enrichment.notices).toContain(
      'The source returned no current holders of CKrU for these filters; committee rosters cover current holders only.',
    );
    expect(enrichment.notices.join('\n')).not.toContain('local filters');
    expect(String(network.mock.calls[0]?.[0])).toBe(
      'https://data.riksdagen.se/personlista/?org=CKrU&rdlstatus=tjanst&utformat=json',
    );
  });
  it('finds a historical family name from one enamn request and never sends fnamn', async () => {
    const historical = {
      intressent_id: HISTORICAL_UUID,
      sourceid: HISTORICAL_UUID,
      tilltalsnamn: 'Olof',
      efternamn: 'Palme',
      sorteringsnamn: 'Palme,Olof',
      status: 'Tidigare riksdagsledamot',
      person_url_xml: `https://data.riksdagen.se/person/${HISTORICAL_UUID}`,
      personuppdrag: '',
    };
    const network = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const prefix = new URL(String(url)).searchParams.get('enamn');
      return Response.json(registerPayload(prefix === 'Palme' ? [historical] : []));
    });
    initRiksdagService({ fetch: network });
    const result = await runToolContract(riksdagSearchMembers, {
      register: 'all',
      familyNamePrefix: ' Palme ',
    });
    const enrichment = assertSuccess(result);
    expect(result.structuredContent).toMatchObject({
      items: [{ sourceRecordId: HISTORICAL_UUID, name: 'Olof Palme' }],
      candidateCount: 1,
      sourceReportedCount: 1,
      totalCount: 1,
    });
    expect(enrichment.effectiveQuery).toBe(
      '{"familyNamePrefix":"Palme","limit":20,"offset":0,"register":"all","sitting":"all"}',
    );
    expect(enrichment.notices).toContain(
      'All-register scope covers returned source records, not an independently verified historical census.',
    );
    expect(domainText(result)).toEqual(riksdagSearchMembers.output.parse(result.structuredContent));
    const missing = await runToolContract(riksdagSearchMembers, {
      register: 'all',
      familyNamePrefix: 'akesson',
    });
    const missingEnrichment = assertSuccess(missing);
    expect(missing.structuredContent).toMatchObject({ items: [], candidateCount: 0 });
    expect(missingEnrichment.notices).toContain(
      'The source returned no records for this familyNamePrefix. Matching keeps accents (Åkesson, not akesson) and uses the sort name (Family,Given), which can drop particles such as von; nameContains with register all matches any part of a name.',
    );
    expect(missingEnrichment.notices.join('\n')).not.toContain('local filters');
    const decomposed = await runToolContract(riksdagSearchMembers, {
      register: 'all',
      familyNamePrefix: 'Åkesson',
      party: 'SD',
    });
    assertSuccess(decomposed);
    const urls = network.mock.calls.map(([url]) => String(url));
    expect(urls).toEqual([
      'https://data.riksdagen.se/personlista/?enamn=Palme&rdlstatus=samtliga&utformat=json',
      'https://data.riksdagen.se/personlista/?enamn=akesson&rdlstatus=samtliga&utformat=json',
      'https://data.riksdagen.se/personlista/?enamn=%C3%85kesson&parti=SD&rdlstatus=samtliga&utformat=json',
    ]);
    for (const url of urls) expect(new URL(url).searchParams.has('fnamn')).toBe(false);
  });
  it('treats blank committee and familyNamePrefix as unset', async () => {
    const network = rosterNetwork();
    initRiksdagService({ fetch: network });
    const result = await runToolContract(riksdagSearchMembers, {
      committee: ' ',
      familyNamePrefix: '',
    });
    assertSuccess(result);
    expect(result.structuredContent).toMatchObject({ items: ROSTER_ITEMS });
    expect(String(network.mock.calls[0]?.[0])).toBe(
      'https://data.riksdagen.se/personlista/?rdlstatus=tjanst&utformat=json',
    );
  });
});
describe('member public contracts', () => {
  it('keeps all-register scope, substring filtering and source counts across cached continuations', async () => {
    const rows = [
      {
        intressent_id: '0001',
        tilltalsnamn: 'Göran',
        efternamn: 'Synthetic',
        status: 'Tjänstgörande ersättare',
      },
      {
        intressent_id: '0002',
        tilltalsnamn: 'Göran',
        efternamn: 'Synthetic',
        status: 'Tjänstgörande statsrådsersättare',
      },
      {
        intressent_id: '12345678-1234-4234-8234-123456789abc',
        sourceid: '12345678-1234-4234-8234-123456789abc',
        tilltalsnamn: 'Göran',
        efternamn: 'Synthetic',
        personuppdrag: '',
      },
    ];
    const network = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      Response.json({
        personlista: {
          '@hits': new URL(String(url)).searchParams.get('rdlstatus') === 'samtliga' ? '4' : '3',
          person: rows,
        },
      }),
    );
    initRiksdagService({ fetch: network });
    const first = await runToolContract(riksdagSearchMembers, {
      register: 'all',
      nameContains: 'oran ynthe',
      limit: 1,
    });
    const enrichment = assertSuccess(first);
    expect(enrichment.effectiveQuery).toContain('all');
    expect(enrichment.notices.join(' ')).toContain('Source-reported hits (4)');
    const page = riksdagSearchMembers.output.parse(first.structuredContent);
    expect(page).toMatchObject({
      sourceReportedCount: 4,
      candidateCount: 3,
      totalCount: 3,
      nextCall: { args: { register: 'all' } },
    });
    expect(domainText(first)).toEqual(page);
    const second = await runToolContract(
      riksdagSearchMembers,
      continuationArgs(riksdagSearchMembers, page.nextCall),
    );
    const secondPage = riksdagSearchMembers.output.parse(second.structuredContent);
    expect(assertSuccess(second).retrievedAt).toBe(enrichment.retrievedAt);
    expect(domainText(second)).toEqual(secondPage);
    const third = await runToolContract(
      riksdagSearchMembers,
      continuationArgs(riksdagSearchMembers, secondPage.nextCall),
    );
    assertSuccess(third);
    expect(third.structuredContent).toMatchObject({
      items: [{ detailAvailable: false, sourceRecordId: rows[2]!.sourceid }],
      hasMore: false,
    });
    expect(domainText(third)).toEqual(riksdagSearchMembers.output.parse(third.structuredContent));
    for (const args of [
      { register: 'all', offset: 99 },
      { register: 'all', nameContains: 'absent' },
    ] as const) {
      const empty = await runToolContract(riksdagSearchMembers, args);
      assertSuccess(empty);
      expect(empty.structuredContent).toMatchObject({ items: [], hasMore: false });
      expect(domainText(empty)).toEqual(riksdagSearchMembers.output.parse(empty.structuredContent));
    }
    const serving = await runToolContract(riksdagSearchMembers, {
      register: 'all',
      sitting: 'serving',
    });
    assertSuccess(serving);
    expect(serving.structuredContent).toMatchObject({ totalCount: 2 });
    expect(network).toHaveBeenCalledTimes(1);
    expect(String(network.mock.calls[0]?.[0])).toBe(
      'https://data.riksdagen.se/personlista/?rdlstatus=samtliga&utformat=json',
    );
    const wrongScope = await runToolContract(riksdagSearchMembers, { revision: page.revision });
    expect(wrongScope).toMatchObject({
      isError: true,
      structuredContent: { error: { data: { reason: 'revision_changed' } } },
    });
    expect(wrongScope.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('Restart') }),
      ]),
    );
  });
  it('uses shared substitute classification in exact member detail', async () => {
    initRiksdagService({
      fetch: async () =>
        Response.json({
          personlista: {
            '@hits': '1',
            person: { intressent_id: '0001', status: 'Tjänstgörande talmansersättare' },
          },
        }),
    });
    const result = await runToolContract(riksdagGetMember, { memberId: '0001' });
    assertSuccess(result);
    expect(result.structuredContent).toMatchObject({
      serviceClassification: 'serving',
      status: 'Tjänstgörande talmansersättare',
    });
    expect(domainText(result)).toEqual(riksdagGetMember.output.parse(result.structuredContent));
  });
  it.each(['schema', 'wrong-iid', 'multiple-iid', 'assignment-identity'])(
    'preserves %s errors and recovery on both public surfaces',
    async (kind) => {
      const payload =
        kind === 'schema'
          ? { personlista: { '@hits': '2', person: { intressent_id: '0001' } } }
          : kind === 'multiple-iid'
            ? {
                personlista: {
                  '@hits': '2',
                  person: [{ intressent_id: '0001' }, { intressent_id: '0002' }],
                },
              }
            : {
                personlista: {
                  '@hits': '1',
                  person:
                    kind === 'wrong-iid'
                      ? { intressent_id: '0002' }
                      : {
                          intressent_id: '0001',
                          personuppdrag: { uppdrag: { intressent_id: '0002' } },
                        },
                },
              };
      initRiksdagService({ fetch: async () => Response.json(payload) });
      const result = await runToolContract(riksdagGetMember, { memberId: '0001' });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: JsonRpcErrorCode.SerializationError,
            data: {
              reason: kind === 'schema' ? 'upstream_schema_invalid' : 'upstream_identity_mismatch',
              recovery: { hint: expect.any(String) },
            },
          },
        },
      });
      const error = z
        .object({
          error: z.object({ data: z.object({ recovery: z.object({ hint: z.string() }) }) }),
        })
        .parse(result.structuredContent).error;
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining(error.data.recovery.hint),
          }),
        ]),
      );
    },
  );
  it('preserves search revision across local filters/page sizes and detects candidate drift after cache expiry', async () => {
    vi.useFakeTimers();
    let changed = false;
    const network = vi.fn<typeof fetch>().mockImplementation(async () => {
      const rows = memberRows();
      if (changed) rows[0]!.efternamn = 'Changed Synthetic';
      return Response.json({ personlista: { '@hits': '4', person: rows } });
    });
    initRiksdagService({ fetch: network });
    const first = await runToolContract(riksdagSearchMembers, { limit: 1 });
    const firstEnrichment = assertSuccess(first);
    const page = riksdagSearchMembers.output.parse(first.structuredContent);
    vi.advanceTimersByTime(1000);
    const filtered = await runToolContract(riksdagSearchMembers, {
      limit: 3,
      sitting: 'serving',
      nameContains: 'asa',
    });
    expect(assertSuccess(filtered).retrievedAt).toBe(firstEnrichment.retrievedAt);
    expect(filtered.structuredContent).toMatchObject({ revision: page.revision, totalCount: 2 });
    expect(network).toHaveBeenCalledTimes(1);
    changed = true;
    vi.advanceTimersByTime(300000);
    const drift = await runToolContract(
      riksdagSearchMembers,
      continuationArgs(riksdagSearchMembers, page.nextCall),
    );
    expect(drift).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: JsonRpcErrorCode.Conflict, data: { reason: 'revision_changed' } },
      },
    });
    expect(drift.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('Restart') }),
      ]),
    );
  });
  it('explains zero filtered matches and normalizes blank form values without dropping unknown service records', async () => {
    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ personlista: { '@hits': '4', person: memberRows() } }),
      );
    initRiksdagService({ fetch: network });
    const noMatch = await runToolContract(riksdagSearchMembers, { nameContains: 'not present' });
    expect(assertSuccess(noMatch).notices.join(' ')).toContain('fewer name tokens');
    expect(noMatch.structuredContent).toMatchObject({
      candidateCount: 4,
      totalCount: 0,
      returnedCount: 0,
      items: [],
      hasMore: false,
    });
    expect(domainText(noMatch)).toEqual(
      riksdagSearchMembers.output.parse(noMatch.structuredContent),
    );
    const blank = await runToolContract(riksdagSearchMembers, {
      nameContains: ' ',
      constituency: '',
      party: ' ',
    });
    assertSuccess(blank);
    expect(blank.structuredContent).toMatchObject({ totalCount: 4 });
    expect(String(network.mock.calls[0]?.[0])).toBe(
      'https://data.riksdagen.se/personlista/?rdlstatus=tjanst&utformat=json',
    );
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('filters all name tokens, constituency and service before stable local pagination', async () => {
    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ personlista: { '@hits': '4', person: memberRows() } }),
      );
    initRiksdagService({ fetch: network });
    const result = await runToolContract(riksdagSearchMembers, {
      nameContains: ' asa OBERG ',
      party: 's',
      constituency: 'stockholms kommun',
      sitting: 'serving',
      limit: 1,
    });
    assertSuccess(result);
    const page = riksdagSearchMembers.output.parse(result.structuredContent);
    expect(page).toMatchObject({
      candidateCount: 4,
      totalCount: 2,
      returnedCount: 1,
      items: [{ memberId: '0001' }],
    });
    expect(domainText(result)).toEqual(page);
    expect(page.nextCall?.args).toMatchObject({
      nameContains: 'asa OBERG',
      party: 'S',
      constituency: 'Stockholms kommun',
      sitting: 'serving',
      offset: 1,
      limit: 1,
      revision: page.revision,
    });
    const next = await runToolContract(
      riksdagSearchMembers,
      continuationArgs(riksdagSearchMembers, page.nextCall),
    );
    assertSuccess(next);
    expect(next.structuredContent).toMatchObject({
      revision: page.revision,
      items: [{ memberId: '0002' }],
      hasMore: false,
    });
    expect(domainText(next)).toEqual(riksdagSearchMembers.output.parse(next.structuredContent));
    expect(String(network.mock.calls[0]?.[0])).toBe(
      'https://data.riksdagen.se/personlista/?parti=S&rdlstatus=tjanst&utformat=json',
    );
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('retains unknown service in all and excludes it from not_serving', async () => {
    initRiksdagService({
      fetch: async () => Response.json({ personlista: { '@hits': '4', person: memberRows() } }),
    });
    const all = await runToolContract(riksdagSearchMembers, {});
    assertSuccess(all);
    const allPage = riksdagSearchMembers.output.parse(all.structuredContent);
    expect(allPage.items.map((entry) => entry.memberId)).toEqual(['0001', '0002', '0003', '0004']);
    expect(allPage.items[3]).toMatchObject({
      status: 'Statsråd',
      serviceClassification: 'unknown',
    });
    const former = await runToolContract(riksdagSearchMembers, { sitting: 'not_serving' });
    assertSuccess(former);
    expect(former.structuredContent).toMatchObject({
      items: [{ memberId: '0003' }],
      totalCount: 1,
    });
    expect(domainText(former)).toEqual(riksdagSearchMembers.output.parse(former.structuredContent));
  });
  it('retains source-only identity with actionable no-detail guidance on both surfaces', async () => {
    const network = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        personlista: {
          '@hits': '1',
          person: {
            intressent_id: '',
            sourceid: 'synthetic-european-id',
            status: 'Europaparlamentariker',
          },
        },
      }),
    );
    initRiksdagService({ fetch: network });
    const result = await runToolContract(riksdagSearchMembers, {});
    const enrichment = assertSuccess(result);
    expect(result.structuredContent).toMatchObject({
      items: [
        {
          sourceRecordId: 'synthetic-european-id',
          detailAvailable: false,
          sourceUrl: 'https://data.riksdagen.se/person/synthetic-european-id',
        },
      ],
    });
    expect(domainText(result)).toEqual(riksdagSearchMembers.output.parse(result.structuredContent));
    expect(enrichment.notices.join(' ')).toContain('do not pass the UUID');
    const invalid = await runToolContract(riksdagGetMember, { memberId: 'synthetic-european-id' });
    expect(invalid.isError).toBe(true);
    expect(network).toHaveBeenCalledTimes(1);
  });
  it.each([100, 101, 100000])(
    'reports requested search limit %i and traverses full applied-limit pages without repeats',
    async (limit) => {
      const rows = Array.from({ length: 105 }, (_, i) => ({
        intressent_id: String(i).padStart(4, '0'),
        tilltalsnamn: 'Synthetic',
        efternamn: 'x'.repeat((i % 7) * 40) + String(i),
      }));
      initRiksdagService({
        fetch: async () => Response.json({ personlista: { '@hits': '105', person: rows } }),
      });
      let args = riksdagSearchMembers.input.parse({ limit });
      const ids: string[] = [];
      for (;;) {
        const result = await runToolContract(riksdagSearchMembers, args);
        const enrichment = assertSuccess(result);
        const page = riksdagSearchMembers.output.parse(result.structuredContent);
        expect(domainText(result)).toEqual(page);
        expect(page.limit).toBe(100);
        expect(page.returnedCount).toBe(Math.min(100, 105 - ids.length));
        expect(page.requestedLimit).toBe(args.limit);
        expect(page.offset).toBe(ids.length);
        if (ids.length === 0)
          expect(enrichment.notices.some((notice) => notice.includes('clamped'))).toBe(limit > 100);
        for (const member of page.items) ids.push(member.memberId!);
        if (!page.nextCall) break;
        expect(page.nextCall.args.offset).toBe(ids.length);
        args = continuationArgs(riksdagSearchMembers, page.nextCall);
      }
      expect(ids).toEqual(Array.from({ length: 105 }, (_, i) => String(i).padStart(4, '0')));
    },
  );
  it.each([100, 101, 100000])(
    'reports requested assignment limit %i and preserves all source-order assignments',
    async (assignmentLimit) => {
      const person = memberDetail(105);
      initRiksdagService({
        fetch: async () => Response.json({ personlista: { '@hits': '1', person } }),
      });
      let args = riksdagGetMember.input.parse({ memberId: '0001', assignmentLimit });
      const organs: string[] = [];
      for (;;) {
        const result = await runToolContract(riksdagGetMember, args);
        const enrichment = assertSuccess(result);
        const page = riksdagGetMember.output.parse(result.structuredContent);
        expect(domainText(result)).toEqual(page);
        expect(page.requestedAssignmentLimit).toBe(args.assignmentLimit);
        expect(page.assignmentLimit).toBe(100);
        expect(page.returnedCount).toBe(Math.min(100, 105 - organs.length));
        expect(page.assignmentOffset).toBe(organs.length);
        if (!organs.length)
          expect(enrichment.notices.some((notice) => notice.includes('clamped'))).toBe(
            assignmentLimit > 100,
          );
        organs.push(...(page.assignments ?? []).map((entry) => entry.organ!));
        if (!page.nextCall) break;
        expect(page.nextCall.args.assignmentOffset).toBe(organs.length);
        args = continuationArgs(riksdagGetMember, page.nextCall);
      }
      expect(organs).toEqual(Array.from({ length: 105 }, (_, i) => `ORG${105 - i}`));
    },
  );
  it('returns oversized assignment rows whole and never shortens the requested page', async () => {
    const person = memberDetail(2);
    person.personuppdrag.uppdrag[0]!.uppgift = ['x'.repeat(20000)];
    initRiksdagService({
      fetch: async () => Response.json({ personlista: { '@hits': '1', person } }),
    });
    const result = await runToolContract(riksdagGetMember, {
      memberId: '0001',
      assignmentLimit: 2,
    });
    const enrichment = assertSuccess(result);
    expect(result.structuredContent).toMatchObject({
      assignments: [{ descriptions: ['x'.repeat(20000)] }, { organ: 'ORG1' }],
      assignmentTotal: 2,
      returnedCount: 2,
      assignmentLimit: 2,
      hasMore: false,
      truncated: false,
    });
    expect(result.structuredContent).not.toHaveProperty('nextCall');
    expect(enrichment.notices.join(' ')).not.toMatch(/indivisible|response target|shortened/);
    expect(domainText(result)).toEqual(riksdagGetMember.output.parse(result.structuredContent));
  });
  it.each([
    [100, 100],
    [101, 100],
  ])(
    'returns min(assignmentLimit %i, remaining) heavy assignments and continues with the applied %i',
    async (assignmentLimit, applied) => {
      const person = memberDetail(105);
      for (const assignment of person.personuppdrag.uppdrag) assignment.uppgift = ['å'.repeat(400)];
      initRiksdagService({
        fetch: async () => Response.json({ personlista: { '@hits': '1', person } }),
      });
      const result = await runToolContract(riksdagGetMember, { memberId: '0001', assignmentLimit });
      const enrichment = assertSuccess(result);
      const page = riksdagGetMember.output.parse(result.structuredContent);
      expect(domainText(result)).toEqual(page);
      expect(page).toMatchObject({
        assignmentTotal: 105,
        returnedCount: applied,
        assignmentLimit: applied,
        requestedAssignmentLimit: assignmentLimit,
        hasMore: true,
        truncated: true,
      });
      expect(page.assignments).toHaveLength(applied);
      expect(page.nextCall).toEqual({
        toolName: 'riksdag_get_member',
        args: {
          memberId: '0001',
          assignmentOffset: applied,
          assignmentLimit: applied,
          revision: page.revision,
        },
      });
      expect(enrichment.notices.join(' ')).not.toMatch(/indivisible|response target|shortened/);
      const rest = await runToolContract(
        riksdagGetMember,
        continuationArgs(riksdagGetMember, page.nextCall),
      );
      assertSuccess(rest);
      expect(rest.structuredContent).toMatchObject({
        returnedCount: 5,
        assignmentOffset: applied,
        assignmentLimit: applied,
        hasMore: false,
        truncated: false,
      });
      expect(rest.structuredContent).not.toHaveProperty('nextCall');
    },
  );
  it('returns exact misses, empty assignment history and offsets beyond the end with enrichment', async () => {
    initRiksdagService({ fetch: async () => Response.json({ personlista: { '@hits': '0' } }) });
    const missing = await runToolContract(riksdagGetMember, { memberId: '0001' });
    assertSuccess(missing);
    expect(missing.structuredContent).toMatchObject({
      found: false,
      memberId: '0001',
      guidance: expect.stringContaining('leading zeros'),
    });
    expect(domainText(missing)).toEqual(riksdagGetMember.output.parse(missing.structuredContent));
    initRiksdagService({
      fetch: async () =>
        Response.json({ personlista: { '@hits': '1', person: { intressent_id: '0001' } } }),
    });
    const empty = await runToolContract(riksdagGetMember, {
      memberId: '0001',
      assignmentOffset: 1000,
    });
    assertSuccess(empty);
    expect(empty.structuredContent).toMatchObject({
      found: true,
      assignments: [],
      assignmentTotal: 0,
      returnedCount: 0,
      hasMore: false,
    });
    expect(domainText(empty)).toEqual(riksdagGetMember.output.parse(empty.structuredContent));
    const search = await runToolContract(riksdagSearchMembers, { offset: 1000 });
    assertSuccess(search);
    expect(search.structuredContent).toMatchObject({
      candidateCount: 1,
      totalCount: 1,
      items: [],
      returnedCount: 0,
      hasMore: false,
    });
    expect(domainText(search)).toEqual(riksdagSearchMembers.output.parse(search.structuredContent));
  });
  it('keeps cache timestamps and revisions stable across page sizes, then rejects drift after expiry', async () => {
    vi.useFakeTimers();
    let changed = false;
    const network = vi.fn<typeof fetch>().mockImplementation(async () => {
      const person = memberDetail();
      if (changed) person.efternamn = 'Changed';
      return Response.json({ personlista: { '@hits': '1', person } });
    });
    initRiksdagService({ fetch: network });
    const first = await runToolContract(riksdagGetMember, { memberId: '0001', assignmentLimit: 1 });
    const enrichment = assertSuccess(first);
    const page = riksdagGetMember.output.parse(first.structuredContent);
    vi.advanceTimersByTime(1000);
    const cached = await runToolContract(riksdagGetMember, {
      memberId: '0001',
      assignmentLimit: 2,
    });
    expect(assertSuccess(cached).retrievedAt).toBe(enrichment.retrievedAt);
    expect(cached.structuredContent).toMatchObject({ revision: page.revision });
    expect(network).toHaveBeenCalledTimes(1);
    changed = true;
    vi.advanceTimersByTime(300000);
    const drift = await runToolContract(
      riksdagGetMember,
      continuationArgs(riksdagGetMember, page.nextCall),
    );
    expect(drift).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: JsonRpcErrorCode.Conflict, data: { reason: 'revision_changed' } },
      },
    });
    expect(drift.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('Restart') }),
      ]),
    );
  });
  it.each(['service', 'all'] as const)(
    'directs a saturated %s member search back to the same tool with a usable party filter',
    async (register) => {
      initRiksdagService({
        fetch: async () =>
          Response.json({
            personlista: {
              '@hits': '50000',
              person: Array.from({ length: 50000 }, (_, i) => ({ intressent_id: String(i + 1) })),
            },
          }),
      });
      const result = await runToolContract(riksdagSearchMembers, { register });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            data: {
              reason: 'candidate_limit_reached',
              recovery: { hint: expect.stringContaining('riksdag_search_members') },
            },
          },
        },
      });
      expect(text(result)).toContain('riksdag_search_members');
      expect(text(result)).toContain('party');
    },
  );
  it('discloses requested and applied search limits and returns every heavy row whole', async () => {
    initRiksdagService({
      fetch: async () =>
        Response.json({
          personlista: {
            '@hits': '4',
            person: Array.from({ length: 4 }, (_, i) => ({
              intressent_id: String(i + 1),
              tilltalsnamn: 'x'.repeat(10000),
              efternamn: 'Synthetic',
            })),
          },
        }),
    });
    const result = await runToolContract(riksdagSearchMembers, { limit: 101 });
    const enrichment = assertSuccess(result);
    expect(result.structuredContent).toMatchObject({
      requestedLimit: 101,
      limit: 100,
      returnedCount: 4,
      hasMore: false,
    });
    expect(result.structuredContent).not.toHaveProperty('truncated');
    expect(result.structuredContent).not.toHaveProperty('nextCall');
    expect(enrichment.notices).toContain('Requested limit was clamped to 100.');
    expect(enrichment.notices.join(' ')).not.toMatch(/indivisible|response target|shortened/);
    const first = result.content[0];
    if (first?.type !== 'text') throw new Error('Expected domain text.');
    expect(first.text).toContain('"requestedLimit": 101');
    expect(first.text).toContain('"limit": 100');
    expect(first.text).not.toContain('"truncated"');
    expect(domainText(result)).toEqual(riksdagSearchMembers.output.parse(result.structuredContent));
  });
  it.each([
    [100, 100],
    [101, 100],
  ])(
    'returns min(limit %i, remaining) heavy search rows and continues with the applied %i',
    async (limit, applied) => {
      const rows = Array.from({ length: 105 }, (_, i) => ({
        intressent_id: String(i + 1).padStart(4, '0'),
        tilltalsnamn: 'å'.repeat(400),
        efternamn: `Synthetic ${i + 1}`,
      }));
      initRiksdagService({
        fetch: async () => Response.json({ personlista: { '@hits': '105', person: rows } }),
      });
      const result = await runToolContract(riksdagSearchMembers, { limit });
      const enrichment = assertSuccess(result);
      const page = riksdagSearchMembers.output.parse(result.structuredContent);
      expect(domainText(result)).toEqual(page);
      expect(page).toMatchObject({
        totalCount: 105,
        returnedCount: applied,
        limit: applied,
        requestedLimit: limit,
        hasMore: true,
      });
      expect(page.items).toHaveLength(applied);
      expect(result.structuredContent).not.toHaveProperty('truncated');
      expect(page.nextCall).toEqual({
        toolName: 'riksdag_search_members',
        args: {
          register: 'service',
          sitting: 'all',
          offset: applied,
          limit: applied,
          revision: page.revision,
        },
      });
      expect(enrichment.notices.join(' ')).not.toMatch(/indivisible|response target|shortened/);
      const rest = await runToolContract(
        riksdagSearchMembers,
        continuationArgs(riksdagSearchMembers, page.nextCall),
      );
      assertSuccess(rest);
      expect(rest.structuredContent).toMatchObject({
        returnedCount: 5,
        offset: applied,
        limit: applied,
        hasMore: false,
      });
      expect(rest.structuredContent).not.toHaveProperty('nextCall');
    },
  );
  it('discloses requested assignment limit independently from the applied limit', async () => {
    initRiksdagService({
      fetch: async () =>
        Response.json({
          personlista: {
            '@hits': '1',
            person: { intressent_id: '0001', personuppdrag: { uppdrag: [{ organ_kod: 'KU' }] } },
          },
        }),
    });
    const result = await runToolContract(riksdagGetMember, {
      memberId: '0001',
      assignmentLimit: 101,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      requestedAssignmentLimit: 101,
      assignmentLimit: 100,
      truncated: false,
    });
    const first = result.content[0];
    if (first?.type !== 'text') throw new Error('Expected domain text.');
    expect(first.text).toContain('"requestedAssignmentLimit": 101');
  });
});
