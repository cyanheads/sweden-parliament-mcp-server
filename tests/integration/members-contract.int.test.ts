/** @fileoverview Member register wire-to-tool response contracts. @module tests/integration/members-contract */
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { riksdagGetMember } from '@/mcp-server/tools/definitions/get-member.tool.js';
import { riksdagSearchMembers } from '@/mcp-server/tools/definitions/search-members.tool.js';
import { successEnrichment } from '@/services/riksdag/output.js';
import { getRiksdagService, initRiksdagService } from '@/services/riksdag/riksdag-service.js';
import { memberDetail, memberRows } from '../services/riksdag/member-fixtures.js';

afterEach(() => {
  vi.useRealTimers();
  getRiksdagService().dispose();
});
function assertSuccess(result: Awaited<ReturnType<typeof runToolContract>>) {
  expect(result.isError).not.toBe(true);
  const enrichment = z.object(successEnrichment).parse(result.structuredContent);
  expect(enrichment.source).toBe('Source: The Swedish Parliament');
  const text = result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  expect(text).toContain('Source: The Swedish Parliament');
  expect(text).toContain(enrichment.retrievedAt);
  for (const notice of enrichment.notices)
    expect(text).toContain(JSON.stringify(notice).slice(1, -1));
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
describe('member public contracts', () => {
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
    const drift = await runToolContract(riksdagSearchMembers, page.nextCall!.args);
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
    const next = await runToolContract(riksdagSearchMembers, page.nextCall!.args);
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
  it.each([100, 101])(
    'reports requested search limit %i and traverses variable fitted pages without repeats',
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
        expect(page.limit).toBeLessThanOrEqual(100);
        expect(page.requestedLimit).toBe(args.limit);
        expect(page.offset).toBe(ids.length);
        if (ids.length === 0)
          expect(enrichment.notices.some((notice) => notice.includes('clamped'))).toBe(
            limit === 101,
          );
        for (const member of page.items) ids.push(member.memberId!);
        if (!page.nextCall) break;
        expect(page.nextCall.args.offset).toBe(ids.length);
        args = riksdagSearchMembers.input.parse(page.nextCall.args);
      }
      expect(ids).toEqual(Array.from({ length: 105 }, (_, i) => String(i).padStart(4, '0')));
    },
  );
  it.each([100, 101])(
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
        expect(page.assignmentLimit).toBeLessThanOrEqual(100);
        expect(page.assignmentOffset).toBe(organs.length);
        if (!organs.length)
          expect(enrichment.notices.some((notice) => notice.includes('clamped'))).toBe(
            assignmentLimit === 101,
          );
        organs.push(...(page.assignments ?? []).map((entry) => entry.organ!));
        if (!page.nextCall) break;
        expect(page.nextCall.args.assignmentOffset).toBe(organs.length);
        args = riksdagGetMember.input.parse(page.nextCall.args);
      }
      expect(organs).toEqual(Array.from({ length: 105 }, (_, i) => `ORG${105 - i}`));
    },
  );
  it('returns intact oversized assignment rows with truthful continuation and no silent slicing', async () => {
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
      assignments: [{ descriptions: ['x'.repeat(20000)] }],
      returnedCount: 1,
      nextCall: { args: { assignmentOffset: 1 } },
    });
    expect(enrichment.notices.join(' ')).toContain('indivisible entry');
    expect(domainText(result)).toEqual(riksdagGetMember.output.parse(result.structuredContent));
  });
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
    const drift = await runToolContract(riksdagGetMember, page.nextCall!.args);
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
  it('directs a saturated member search back to the same tool with a usable party filter', async () => {
    initRiksdagService({
      fetch: async () =>
        Response.json({
          personlista: {
            '@hits': '50000',
            person: Array.from({ length: 50000 }, (_, i) => ({ intressent_id: String(i + 1) })),
          },
        }),
    });
    const result = await runToolContract(riksdagSearchMembers, {});
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
    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    expect(text).toContain('riksdag_search_members');
    expect(text).toContain('party');
  });
  it('discloses requested and applied search limits and measured whole-row shortening', async () => {
    initRiksdagService({
      fetch: async () =>
        Response.json({
          personlista: {
            '@hits': '4',
            person: Array.from({ length: 4 }, (_, i) => ({
              intressent_id: String(i + 1),
              tilltalsnamn: 'x'.repeat(2500),
              efternamn: 'Synthetic',
            })),
          },
        }),
    });
    const result = await runToolContract(riksdagSearchMembers, { limit: 101 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      requestedLimit: 101,
      truncated: true,
      hasMore: true,
    });
    const first = result.content[0];
    if (first?.type !== 'text') throw new Error('Expected domain text.');
    expect(first.text).toContain('"requestedLimit": 101');
    expect(first.text).toContain('"truncated": true');
  });
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
