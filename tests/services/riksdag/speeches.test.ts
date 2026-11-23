/** @fileoverview Speech endpoint completeness, identities and cache admission. @module tests/services/riksdag/speeches */
import { describe, expect, it, vi } from 'vitest';
import { RiksdagService } from '@/services/riksdag/riksdag-service.js';
import {
  loadSpeechCandidates,
  loadSpeechDetail,
  type Speech,
  speechSchema,
} from '@/services/riksdag/speeches.js';
import { htmlToMarkdown } from '@/services/riksdag/text.js';
import { createToolBudget } from '@/services/riksdag/transport.js';
import {
  duplicatedRows,
  duplicateUuids,
  speechList,
  speechRow,
  speechXml,
  xmlDetailRecord,
} from './speech-fixtures.js';

const filters = { session: '2024/25', speechType: 'all' as const };

/** Read fields derived from the retrieval ID itself, so copies of one speech cannot differ in them. */
const RETRIEVAL_IDENTITY = ['speechId', 'protocolDocumentId', 'sourceUrl'] as const;
type SharedField = Exclude<keyof Speech, 'sourceSpeechId' | (typeof RETRIEVAL_IDENTITY)[number]>;
/** The wire field behind every other read field, with the value both copies carry and another. */
const sharedFieldWire = {
  session: ['dok_rm', '2024/25', '2023/24'],
  protocolTitle: ['dok_titel', 'Protokoll 2024/25:1', 'Protokoll 2024/25:2'],
  memberId: ['intressent_id', '0001', '0002'],
  speaker: ['talare', 'Synthetic Speaker', 'Other Speaker'],
  party: ['parti', 'S', 'M'],
  date: ['dok_datum', '2024-09-10', '2024-09-11'],
  heading: ['avsnittsrubrik', 'Åtgärder för miljön', 'Annan rubrik'],
  subheading: ['underrubrik', 'Östersjön och klimat', 'Annan underrubrik'],
  activity: ['kammaraktivitet', 'ärendedebatt', 'interpellationsdebatt'],
  reply: ['replik', 'N', 'Y'],
  relatedDocumentId: ['rel_dok_id', 'HC01KU1', 'HC01KU2'],
  sourceHtmlUrl: [
    'anforande_url_html',
    '//data.riksdagen.se/anforande/HC091-1/html',
    '//data.riksdagen.se/anforande/HC091-1/html?v=2',
  ],
  protocolUrl: [
    'protokoll_url_www',
    '//www.riksdagen.se/sv/dokument-och-lagar/protokoll/#1',
    '//www.riksdagen.se/sv/dokument-och-lagar/protokoll/#2',
  ],
} satisfies Record<SharedField, readonly [field: string, kept: string, other: string]>;
/** Every read field two copies must share, taken from the output schema so a new field needs a row above. */
const sharedFields = Object.keys(speechSchema.shape).filter(
  (key): key is SharedField =>
    key !== 'sourceSpeechId' && !RETRIEVAL_IDENTITY.some((identity) => identity === key),
);
/** How the second copy departs from the first in one shared field. */
const fieldChanges = ['differs', 'is absent from one copy'] as const;

/** Two copies of one speech, alike except `key`, whose value differs or is absent on the second. */
function conflictingCopies(
  copies: Record<string, string>[],
  key: SharedField,
  change: (typeof fieldChanges)[number],
) {
  const [field, kept, other] = sharedFieldWire[key];
  return copies.map(({ [field]: _, ...copy }, index) => {
    const value = index === 0 ? kept : change === 'differs' ? other : undefined;
    return value === undefined ? copy : { ...copy, [field]: value };
  });
}

/** Loads one candidate response on a fresh service, so no cached list answers the call. */
async function loadList(antal: string, anforande: unknown[]) {
  const service = new RiksdagService({
    fetch: async () => Response.json({ anforandelista: { '@antal': antal, anforande } }),
  });
  using budget = createToolBudget();
  try {
    return await loadSpeechCandidates(service, budget, filters);
  } finally {
    service.dispose();
  }
}

describe('speech endpoint contracts', () => {
  it('treats only zero-byte successful detail as an uncached miss', async () => {
    const network = vi.fn<typeof fetch>().mockImplementation(async () => new Response(''));
    const service = new RiksdagService({ fetch: network });
    using budget = createToolBudget();
    try {
      for (let i = 0; i < 2; i++)
        await expect(loadSpeechDetail(service, budget, 'HC091-9999')).resolves.toMatchObject({
          found: false,
        });
      expect(network).toHaveBeenCalledTimes(2);
      await expect(loadSpeechCandidates(service, budget, filters)).rejects.toMatchObject({
        data: { reason: 'upstream_schema_invalid' },
      });
    } finally {
      service.dispose();
    }
  });
  it.each([' ', '{'])('retains malformed nonempty detail failure for %j', async (body) => {
    const service = new RiksdagService({ fetch: async () => new Response(body) });
    using budget = createToolBudget();
    try {
      await expect(loadSpeechDetail(service, budget, 'HC091-9999')).rejects.toMatchObject({
        data: { reason: 'upstream_schema_invalid', retryable: false },
      });
    } finally {
      service.dispose();
    }
  });
  it('maps verified filters only and preserves retrieval identity separately from source UUID', async () => {
    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ anforandelista: { '@antal': '1', anforande: speechRow() } }),
      );
    const service = new RiksdagService({ fetch: network });
    using budget = createToolBudget();
    try {
      const result = await loadSpeechCandidates(service, budget, {
        ...filters,
        memberId: '0001',
        party: 'S',
        speechType: 'speech',
      });
      expect(result.records).toMatchObject([
        {
          speechId: 'HC091-1',
          sourceSpeechId: 'synthetic-uuid-1',
          memberId: '0001',
          reply: false,
          sourceUrl: 'https://data.riksdagen.se/anforande/HC091-1',
          sourceHtmlUrl: 'https://data.riksdagen.se/anforande/HC091-1/html',
        },
      ]);
      expect(String(network.mock.calls[0]?.[0])).toBe(
        'https://data.riksdagen.se/anforandelista/?anftyp=Nej&iid=0001&parti=S&rm=2024%2F25&sz=50000&utformat=json',
      );
    } finally {
      service.dispose();
    }
  });
  it('normalizes each related document ID element and preserves elements that are not IDs', async () => {
    const related = [
      'HC01FöU1',
      'HC01FöU1',
      'hc10134, HC10150, hc01föu1, HC10488, sfs 2000:100',
      'HC10447, okänd länk, X, HC10450',
      'X',
      '',
      undefined,
    ];
    const fixture = speechList(related.length);
    for (const [index, value] of related.entries())
      Object.assign(fixture.anforandelista.anforande[index]!, { rel_dok_id: value });
    const network = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => Response.json(fixture))
      .mockImplementationOnce(async () =>
        Response.json({ anforande: { ...speechRow(3), rel_dok_id: related[2] } }),
      );
    const service = new RiksdagService({ fetch: network });
    using budget = createToolBudget();
    try {
      const { records } = await loadSpeechCandidates(service, budget, filters);
      expect(records.map((record) => record.relatedDocumentId)).toEqual([
        'HC01FÖU1',
        'HC01FÖU1',
        'HC10134, HC10150, HC01FÖU1, HC10488, sfs-2000-100',
        'HC10447, okänd länk, X, HC10450',
        'X',
        undefined,
        undefined,
      ]);
      await expect(loadSpeechDetail(service, budget, 'HC091-3')).resolves.toMatchObject({
        record: { relatedDocumentId: 'HC10134, HC10150, HC01FÖU1, HC10488, sfs-2000-100' },
      });
    } finally {
      service.dispose();
    }
  });
  it.each([undefined, null, []])('normalizes empty children %j', async (anforande) => {
    const service = new RiksdagService({
      fetch: async () => Response.json({ anforandelista: { '@antal': '0', anforande } }),
    });
    using budget = createToolBudget();
    try {
      await expect(loadSpeechCandidates(service, budget, filters)).resolves.toMatchObject({
        records: [],
      });
    } finally {
      service.dispose();
    }
  });
  it.each([
    'missing-wrapper',
    'count',
    'saturated',
    'party',
    'session',
    'member',
    'reply',
    'xml-id',
  ])('rejects %s before caching or local filtering', async (kind) => {
    const fixture = speechList(1);
    if (kind === 'count') fixture.anforandelista['@antal'] = '2';
    if (kind === 'saturated') fixture.anforandelista['@antal'] = '50000';
    const row = fixture.anforandelista.anforande[0]!;
    if (kind === 'party') row.parti = 'M';
    if (kind === 'session') row.dok_rm = '2023/24';
    if (kind === 'member') row.intressent_id = '0002';
    if (kind === 'reply') row.replik = 'Y';
    if (kind === 'xml-id') row.anforande_url_xml = '//data.riksdagen.se/anforande/HC091-2';
    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(kind === 'missing-wrapper' ? {} : fixture));
    const service = new RiksdagService({ fetch: network });
    using budget = createToolBudget();
    const reason =
      kind === 'saturated'
        ? 'candidate_limit_reached'
        : ['party', 'session', 'member', 'reply', 'xml-id'].includes(kind)
          ? 'upstream_identity_mismatch'
          : 'upstream_schema_invalid';
    try {
      for (let attempt = 0; attempt < 2; attempt++)
        await expect(
          loadSpeechCandidates(service, budget, {
            ...filters,
            party: 'S',
            memberId: '0001',
            speechType: 'speech',
          }),
        ).rejects.toMatchObject({ data: { reason } });
      expect(network).toHaveBeenCalledTimes(2);
    } finally {
      service.dispose();
    }
  });
  it('rejects exactly 50000 actual rows even when count claims fewer', async () => {
    const fixture = speechList(50000);
    fixture.anforandelista['@antal'] = '49999';
    const service = new RiksdagService({ fetch: async () => Response.json(fixture) });
    using budget = createToolBudget();
    try {
      await expect(loadSpeechCandidates(service, budget, filters)).rejects.toMatchObject({
        data: { reason: 'candidate_limit_reached' },
      });
    } finally {
      service.dispose();
    }
  });
  it('collapses rows identical except unread fields to the lowest source UUID in either row order', async () => {
    const [inOrder, reversed] = await Promise.all(
      [false, true].map((highestFirst) =>
        loadList('6', [
          speechRow(1),
          ...duplicatedRows(2, highestFirst),
          speechRow(3),
          ...duplicatedRows(4, !highestFirst),
        ]),
      ),
    );
    expect(inOrder?.records.map((record) => [record.speechId, record.sourceSpeechId])).toEqual([
      ['HC091-1', 'synthetic-uuid-1'],
      ['HC091-2', duplicateUuids(2).lowest],
      ['HC091-3', 'synthetic-uuid-3'],
      ['HC091-4', duplicateUuids(4).lowest],
    ]);
    expect(inOrder?.collapsedCount).toBe(2);
    expect(reversed).toEqual({ ...inOrder, retrievedAt: reversed?.retrievedAt });
  });
  it('checks @antal and the 50000-row boundary against raw rows before collapsing', async () => {
    const rows = [speechRow(1), ...duplicatedRows(2)];
    await expect(loadList('3', rows)).resolves.toMatchObject({
      collapsedCount: 1,
      records: [{ speechId: 'HC091-1' }, { speechId: 'HC091-2' }],
    });
    await expect(loadList('2', rows)).rejects.toMatchObject({
      data: { reason: 'upstream_schema_invalid' },
    });
    const saturated = Array.from({ length: 25000 }, (_, index) => duplicatedRows(index + 1)).flat();
    await expect(loadList('49999', saturated)).rejects.toMatchObject({
      data: { reason: 'candidate_limit_reached' },
    });
  });
  it('keeps the copy that has a source UUID over one without, in either row order', async () => {
    const copies = duplicatedRows(1).map(({ anforande_id, ...copy }, index) =>
      index === 0 ? { ...copy, anforande_id } : copy,
    );
    for (const rows of [copies, [...copies].reverse()])
      await expect(loadList('2', rows)).resolves.toMatchObject({
        collapsedCount: 1,
        records: [{ speechId: 'HC091-1', sourceSpeechId: duplicateUuids(1).lowest }],
      });
  });
  it.each(
    sharedFields.flatMap((key) =>
      fieldChanges
        // Another session fails the session filter as an identity mismatch before copies compare.
        .filter((change) => key !== 'session' || change !== 'differs')
        .map((change) => ({ key, change })),
    ),
  )('rejects a repeated speechId whose $key $change, before caching', async ({ key, change }) => {
    const network = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        anforandelista: {
          '@antal': '2',
          anforande: conflictingCopies(duplicatedRows(1), key, change),
        },
      }),
    );
    const service = new RiksdagService({ fetch: network });
    using budget = createToolBudget();
    try {
      for (let attempt = 0; attempt < 2; attempt++)
        await expect(loadSpeechCandidates(service, budget, filters)).rejects.toMatchObject({
          data: { reason: 'upstream_schema_invalid' },
        });
      expect(network).toHaveBeenCalledTimes(2);
    } finally {
      service.dispose();
    }
  });
  it('keeps the invalid-JSON failure for XML on the candidate list route', async () => {
    const xml = speechXml(duplicatedRows(1).map((row) => xmlDetailRecord(row, '')));
    const service = new RiksdagService({ fetch: async () => new Response(xml) });
    using budget = createToolBudget();
    try {
      await expect(loadSpeechCandidates(service, budget, filters)).rejects.toMatchObject({
        message: 'Riksdagen returned invalid JSON.',
        data: { reason: 'upstream_schema_invalid' },
      });
    } finally {
      service.dispose();
    }
  });
  it('distinguishes absent detail from present blank body and rejects different detail identity', async () => {
    const network = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => new Response('', { status: 404 }))
      .mockImplementationOnce(async () => Response.json({ anforande: speechRow() }))
      .mockImplementationOnce(async () => Response.json({ anforande: speechRow(3) }));
    const service = new RiksdagService({ fetch: network });
    using budget = createToolBudget();
    try {
      await expect(loadSpeechDetail(service, budget, 'HC091-1')).resolves.toMatchObject({
        found: false,
      });
      await expect(loadSpeechDetail(service, budget, 'HC091-1')).resolves.toMatchObject({
        found: true,
        record: { speechId: 'HC091-1' },
      });
      await expect(loadSpeechDetail(service, budget, 'HC091-2')).rejects.toMatchObject({
        data: { reason: 'upstream_identity_mismatch' },
      });
      expect(network).toHaveBeenCalledTimes(3);
    } finally {
      service.dispose();
    }
  });
  it('rejects a detail answer that holds no record', async () => {
    const service = new RiksdagService({ fetch: async () => Response.json({ anforande: [] }) });
    using budget = createToolBudget();
    try {
      await expect(loadSpeechDetail(service, budget, 'HC091-1')).rejects.toMatchObject({
        data: { reason: 'upstream_schema_invalid' },
      });
    } finally {
      service.dispose();
    }
  });
});

describe('doubled speech detail', () => {
  const body = '<p>Fru talman! Räksmörgås &amp; 😀 &lt;3</p><p>Andra stycket.</p>';
  /** The two XML detail records of speech 1, with a subheading whose surrounding spaces must survive. */
  function doubled(highestFirst = false) {
    return duplicatedRows(1, highestFirst).map((row) =>
      xmlDetailRecord({ ...row, underrubrik: '  Östersjön och klimat ' }, body),
    );
  }
  /** Loads speech 1 twice from one service answering with this body. */
  async function loadTwice(response: string) {
    const network = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(response, {
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
    );
    const service = new RiksdagService({ fetch: network });
    using budget = createToolBudget();
    try {
      const outcomes = [];
      for (let attempt = 0; attempt < 2; attempt++)
        outcomes.push(await loadSpeechDetail(service, budget, 'HC091-1').catch((error) => error));
      return { outcomes, requests: network.mock.calls.length };
    } finally {
      service.dispose();
    }
  }

  it.each([false, true])(
    'decodes the doubled XML body like its JSON record and keeps the lowest source UUID (highest first: %s)',
    async (highestFirst) => {
      const json = new RiksdagService({
        fetch: async () => Response.json({ anforande: doubled()[0] }),
      });
      using budget = createToolBudget();
      try {
        const expected = await loadSpeechDetail(json, budget, 'HC091-1');
        const { outcomes, requests } = await loadTwice(speechXml(doubled(highestFirst)));
        const [decoded, cached] = outcomes;
        if (!expected.found || !decoded?.found) throw new Error('Expected both details.');
        expect(decoded.record).toEqual(expected.record);
        expect(decoded.text).toBe(expected.text);
        expect(decoded.text).toBe(htmlToMarkdown(body));
        expect(decoded.record).toMatchObject({
          sourceSpeechId: duplicateUuids(1).lowest,
          memberId: '0001',
          subheading: '  Östersjön och klimat ',
        });
        expect(cached).toEqual(decoded);
        expect(requests).toBe(1);
      } finally {
        json.dispose();
      }
    },
  );
  it('decodes numeric character references and compares copies by decoded value', async () => {
    const xml = speechXml(doubled())
      .replace('Synthetic Speaker', 'Synthetic&#32;Speaker')
      .replace('&lt;p&gt;', '&#60;p&#x3E;');
    const { outcomes } = await loadTwice(xml);
    expect(outcomes[0]).toMatchObject({
      found: true,
      record: { speaker: 'Synthetic Speaker' },
      text: htmlToMarkdown(body),
    });
  });
  it.each([
    ['anforandetext', '<p>Annan text</p>', 'upstream_schema_invalid'],
    ['anforande_nummer', '2', 'upstream_identity_mismatch'],
  ])('rejects doubled records that differ in %s without caching', async (field, value, reason) => {
    const [first, second] = doubled();
    const { outcomes, requests } = await loadTwice(
      speechXml([first!, { ...second!, [field]: value }]),
    );
    for (const outcome of outcomes) expect(outcome).toMatchObject({ data: { reason } });
    expect(requests).toBe(2);
  });
  it.each(sharedFields.flatMap((key) => fieldChanges.map((change) => ({ key, change }))))(
    'rejects doubled records whose $key $change, without caching',
    async ({ key, change }) => {
      const { outcomes, requests } = await loadTwice(
        speechXml(conflictingCopies(doubled(), key, change)),
      );
      for (const outcome of outcomes)
        expect(outcome).toMatchObject({ data: { reason: 'upstream_schema_invalid' } });
      expect(requests).toBe(2);
    },
  );
  it.each([
    ['inside the second record', (xml: string) => xml.slice(0, xml.lastIndexOf('</anforande>'))],
    ['between two fields', (xml: string) => xml.slice(0, xml.indexOf('<parti>'))],
    ['inside a tag name', (xml: string) => xml.slice(0, xml.indexOf('<parti>') + 3)],
    ['inside a field value', (xml: string) => xml.slice(0, xml.indexOf('Synthetic Speaker') + 4)],
    ['inside a closing tag', (xml: string) => xml.slice(0, xml.indexOf('</anforande>') + 5)],
  ])('rejects a doubled body cut %s', async (_cut, cut) => {
    const { outcomes } = await loadTwice(cut(speechXml(doubled())));
    for (const outcome of outcomes)
      expect(outcome).toMatchObject({
        message: 'Riksdagen returned malformed speech XML.',
        data: { reason: 'upstream_schema_invalid', retryable: false },
      });
  });
  it('normalizes XML line ends and keeps published line and paragraph separators', async () => {
    const xml = speechXml(
      duplicatedRows(1).map((row) =>
        xmlDetailRecord({ ...row, underrubrik: 'Första\r\nandra\rtredje fjärde ' }, body),
      ),
    );
    const { outcomes } = await loadTwice(xml);
    expect(outcomes[0]).toMatchObject({
      found: true,
      record: { subheading: 'Första\nandra\ntredje fjärde ' },
    });
  });
  it.each([
    ['the source error element', '<anforande not="felaktigt anrop. 5"> </anforande>'],
    [
      'another root element',
      '<dokumentstatus><dokument><dok_id>HC091</dok_id></dokument></dokumentstatus>',
    ],
    ['records beside another element', `${speechXml(doubled())}<sammanfattning>x</sammanfattning>`],
    [
      'text between records',
      speechXml(doubled()).replace(
        '</anforande>\r\n<anforande>',
        '</anforande>\r\nlös\r\n<anforande>',
      ),
    ],
    [
      'text inside a record',
      speechXml(doubled()).replace(
        '<anforande>\r\n<dok_hangar_id>',
        '<anforande>lös<dok_hangar_id>',
      ),
    ],
    [
      'a field published twice in a record',
      speechXml(doubled()).replace('<parti>S</parti>', '<parti>S</parti><parti>M</parti>'),
    ],
    [
      'an element inside a field',
      speechXml(doubled()).replace('<parti>S</parti>', '<parti><kod>S</kod></parti>'),
    ],
    ['a cut body of another element', '<dokumentstatus><dokument><dok_id>HC091'],
    [
      'records behind a DOCTYPE entity declaration',
      `<!DOCTYPE anforande [<!ENTITY talare "Synthetic Speaker">]>${speechXml(doubled()).replaceAll(
        '<talare>Synthetic Speaker</talare>',
        '<talare>&talare;</talare>',
      )}`,
    ],
    ['a whitespace body', '\r\n'],
  ])('keeps the invalid-JSON failure for %s', async (_case, response) => {
    const { outcomes } = await loadTwice(response);
    for (const outcome of outcomes)
      expect(outcome).toMatchObject({
        message: 'Riksdagen returned invalid JSON.',
        data: { reason: 'upstream_schema_invalid', retryable: false },
      });
  });
  it('refuses an undeclared entity in a doubled body', async () => {
    const { outcomes } = await loadTwice(
      speechXml(doubled()).replaceAll('Synthetic Speaker', 'Synthetic&nbsp;Speaker'),
    );
    for (const outcome of outcomes)
      expect(outcome).toMatchObject({
        message: 'Riksdagen returned malformed speech XML.',
        data: { reason: 'upstream_schema_invalid' },
      });
  });
});
