/** @fileoverview Speech endpoint completeness, identities and cache admission. @module tests/services/riksdag/speeches */
import { describe, expect, it, vi } from 'vitest';
import { RiksdagService } from '@/services/riksdag/riksdag-service.js';
import { loadSpeechCandidates, loadSpeechDetail } from '@/services/riksdag/speeches.js';
import { createToolBudget } from '@/services/riksdag/transport.js';
import { speechList, speechRow } from './speech-fixtures.js';

const filters = { session: '2024/25', speechType: 'all' as const };

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
    'duplicate',
    'saturated',
    'party',
    'session',
    'member',
    'reply',
    'xml-id',
  ])('rejects %s before caching or local filtering', async (kind) => {
    const fixture = speechList(1);
    if (kind === 'count') fixture.anforandelista['@antal'] = '2';
    if (kind === 'duplicate') {
      fixture.anforandelista.anforande.push(speechRow());
      fixture.anforandelista['@antal'] = '2';
    }
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
});
