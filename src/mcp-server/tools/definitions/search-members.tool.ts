/** @fileoverview Member-register discovery: party, committee and family-name prefix upstream, name, constituency and service locally. @module mcp-server/tools/definitions/search-members.tool */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { assignmentSchema, loadMembers, memberSchema } from '../../../services/riksdag/members.js';
import {
  matchesAllTokens,
  normalizeCode,
  normalizeTokens,
  optionalString,
} from '../../../services/riksdag/normalize.js';
import {
  effectiveQuery,
  formatExact,
  type SuccessEnrichment,
  successEnrichment,
  successEnrichmentTrailer,
  toolCallSchema,
} from '../../../services/riksdag/output.js';
import { getRiksdagService } from '../../../services/riksdag/riksdag-service.js';
import { assertRevision, revisionOf } from '../../../services/riksdag/text.js';
import { createToolBudget } from '../../../services/riksdag/transport.js';

const argsSchema = z.object({
  register: z
    .enum(['service', 'all'])
    .default('service')
    .describe(
      'Register scope; all includes historical records, and a cold request without committee or familyNamePrefix can reach the normal timeout.',
    ),
  nameContains: z
    .string()
    .optional()
    .describe('Strict all-token local name filter, ignoring case and diacritics.'),
  familyNamePrefix: z
    .string()
    .optional()
    .describe(
      'Family-name prefix matched by the source in either register: the start of its sort name (Family,Given, so von Sydow sorts as Sydow), ignoring case but not accents, with V and W treated alike. Cannot contain %, _ or a comma.',
    ),
  party: z.string().optional().describe('Party code or exact reference label.'),
  committee: z
    .string()
    .optional()
    .describe(
      'Committee code or exact reference label; returns its current holders in either register, each with committeeAssignments current at the source time.',
    ),
  constituency: z
    .string()
    .optional()
    .describe('Exact constituency reference label or code, applied locally.'),
  sitting: z
    .enum(['all', 'serving', 'not_serving'])
    .default('all')
    .describe('Source service classification; all retains unknown status.'),
  offset: z.number().int().min(0).default(0).describe('Local row offset.'),
  limit: z.number().int().min(1).default(20).describe('Requested rows; applied maximum 100.'),
  revision: z.string().optional().describe('Revision returned by a preceding page.'),
});
/** Finds member IDs without treating the service register as sitting membership. */
export const riksdagSearchMembers = tool('riksdag_search_members', {
  title: 'Search parliamentary members',
  description:
    'Find members and ministers by name, family-name prefix, party, committee, constituency and service status. Defaults to the service register; register all includes earlier source records through a larger cold request that may time out unless committee or familyNamePrefix narrows it. A committee returns its current holders with their current roles. Use numeric memberId with riksdag_get_member for assignment history.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: argsSchema,
  output: z.object({
    items: z
      .array(
        memberSchema
          .extend({
            committeeAssignments: z
              .array(assignmentSchema)
              .optional()
              .describe(
                'Assignments in the requested committee whose interval contains the source time, in source order; a date-only end counts through that day. Present only with committee.',
              ),
          })
          .describe('Public member register metadata.'),
      )
      .describe('Filtered member-register rows.'),
    candidateCount: z
      .number()
      .describe('Returned candidate records in the selected register scope.'),
    sourceReportedCount: z
      .number()
      .describe('Source-reported hits; can differ from returned candidates in all scope.'),
    totalCount: z.number().describe('Exact count after local filtering.'),
    returnedCount: z.number().describe('Rows in this page.'),
    offset: z.number().describe('Applied local offset.'),
    limit: z.number().describe('Applied row limit after clamping.'),
    requestedLimit: z.number().describe('Requested row limit before clamping.'),
    hasMore: z.boolean().describe('Whether filtered rows remain.'),
    revision: z.string().describe('Complete candidate-set revision.'),
    nextCall: toolCallSchema('riksdag_search_members').optional().describe('Next-page call.'),
  }),
  enrichment: successEnrichment,
  enrichmentTrailer: successEnrichmentTrailer,
  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Unknown party, committee or constituency code, punctuation-only nameContains, or a familyNamePrefix containing %, _ or a comma.',
      recovery:
        'Use riksdag_list_reference to check codes and identifier formats, then retry the same tool with corrected filters.',
      thrownBy: 'service',
    },
    {
      reason: 'revision_changed',
      code: JsonRpcErrorCode.Conflict,
      when: 'Revision no longer matches.',
      recovery:
        'Restart the same tool without revision and begin at the first page to read one consistent record.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_identity_mismatch',
      code: JsonRpcErrorCode.SerializationError,
      when: 'Source rows contradict the required identity.',
      recovery:
        'Check party, committee and constituency with riksdag_list_reference and retry riksdag_search_members; report repeated mismatches with the request identifier.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_schema_invalid',
      code: JsonRpcErrorCode.SerializationError,
      when: 'Payload violates the wire contract.',
      recovery: 'Retry the same tool later; report repeated failures with the request identifier.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Source unavailable after retries.',
      recovery:
        'Retry riksdag_search_members with the same filters after the source becomes available.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_queue_full',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Upstream queue is full.',
      recovery: 'Wait before retrying the same tool, and request fewer simultaneous searches.',
      thrownBy: 'service',
    },
    {
      reason: 'candidate_limit_reached',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Complete-list safety limit reached.',
      recovery:
        'Retry riksdag_search_members with a party filter from riksdag_list_reference; the complete register is too large for this selection.',
      thrownBy: 'service',
    },
  ],
  async handler(input, ctx) {
    using budget = createToolBudget(ctx.signal);
    const name = optionalString(input.nameContains),
      partyInput = optionalString(input.party),
      committeeInput = optionalString(input.committee),
      constituencyInput = optionalString(input.constituency),
      familyNamePrefix = optionalString(input.familyNamePrefix)?.normalize('NFC');
    // The source reads % and _ as wildcards and a comma as the start of the given name.
    if (familyNamePrefix !== undefined && /[%_,]/.test(familyNamePrefix))
      throw ctx.fail('invalid_filter', 'familyNamePrefix cannot contain %, _ or a comma.', {
        field: 'familyNamePrefix',
        recovery: {
          hint: 'Retry riksdag_search_members with familyNamePrefix set to the leading letters of the family name only, or use nameContains to match any part of a name.',
        },
      });
    const filters = {
      register: input.register,
      committee: committeeInput
        ? normalizeCode(committeeInput, 'committees', 'committee')
        : undefined,
      familyNamePrefix,
      nameContains: name,
      party: partyInput ? normalizeCode(partyInput, 'parties', 'party') : undefined,
      constituency: constituencyInput
        ? normalizeCode(constituencyInput, 'constituencies', 'constituency')
        : undefined,
      sitting: input.sitting,
      offset: input.offset,
      limit: Math.min(input.limit, 100),
    };
    const tokens = name ? normalizeTokens(name) : [];
    const loaded = await loadMembers(getRiksdagService(), budget, {
      register: filters.register,
      party: filters.party,
      committee: filters.committee,
      familyNamePrefix: filters.familyNamePrefix,
    });
    const candidates = loaded.records
      .map(({ assignments: _assignments, ...member }) => member)
      .sort((a, b) =>
        (a.memberId ?? a.sourceRecordId ?? '').localeCompare(b.memberId ?? b.sourceRecordId ?? ''),
      );
    const revision = await revisionOf({
      register: filters.register,
      committee: filters.committee,
      familyNamePrefix: filters.familyNamePrefix,
      candidates,
    });
    assertRevision(optionalString(input.revision), revision);
    const rows = candidates.filter(
      (member) =>
        (!name || matchesAllTokens(member.name ?? '', tokens)) &&
        (!filters.constituency || member.constituency === filters.constituency) &&
        (filters.sitting === 'all' || member.serviceClassification === filters.sitting),
    );
    const enrichment: SuccessEnrichment = {
      effectiveQuery: effectiveQuery(filters),
      source: 'Source: The Swedish Parliament',
      retrievedAt: loaded.retrievedAt,
      notices: [
        'Service-register status is not proof of elected membership; minister and unknown labels remain unknown.',
      ],
    };
    if (input.limit > 100) enrichment.notices.push('Requested limit was clamped to 100.');
    if (filters.register === 'all')
      enrichment.notices.push(
        filters.committee !== undefined || filters.familyNamePrefix !== undefined
          ? 'All-register scope covers returned source records, not an independently verified historical census.'
          : 'All-register scope covers returned source records, not an independently verified historical census. Cold requests can reach the normal timeout.',
      );
    // A plain service-register response fails loading unless its hits equal its rows.
    if (loaded.sourceReportedCount !== candidates.length)
      enrichment.notices.push(
        filters.committee === undefined
          ? `Source-reported hits (${loaded.sourceReportedCount}) differ from returned candidate records (${candidates.length}); totals count returned records.`
          : `Source-reported hits (${loaded.sourceReportedCount}) count ${filters.committee} assignments and differ from returned member records (${candidates.length}); totals count returned records.`,
      );
    if (filters.committee !== undefined) {
      if (rows.some((member) => member.committeeAssignments?.length === 0))
        enrichment.notices.push(
          `Some returned members hold no ${filters.committee} assignment current at the source time (${loaded.sourceTime}); their committeeAssignments is empty.`,
        );
      if (!candidates.length)
        enrichment.notices.push(
          `The source returned no current holders of ${filters.committee} for these filters; committee rosters cover current holders only.`,
        );
    }
    if (filters.familyNamePrefix !== undefined && !candidates.length)
      enrichment.notices.push(
        'The source returned no records for this familyNamePrefix. Matching keeps accents (Åkesson, not akesson) and uses the sort name (Family,Given), which can drop particles such as von; nameContains with register all matches any part of a name.',
      );
    if (rows.some((member) => !member.detailAvailable))
      enrichment.notices.push(
        'Some entries have no published member IID: detailAvailable is false and sourceRecordId is a distinct register UUID. Read their sourceUrl; do not pass the UUID to riksdag_get_member.',
      );
    // An empty committee or family-name response is explained above; no local filter ran.
    const sourceEmptyExplained =
      !candidates.length &&
      (filters.committee !== undefined || filters.familyNamePrefix !== undefined);
    if (!rows.length && !sourceEmptyExplained)
      enrichment.notices.push(
        'No register entries matched these local filters. Retry riksdag_search_members with sitting all or fewer name tokens; use riksdag_list_reference for party and constituency codes.',
      );
    budget.check();
    const items = rows.slice(filters.offset, filters.offset + filters.limit);
    const hasMore = filters.offset + items.length < rows.length;
    ctx.enrich(enrichment);
    return {
      items,
      candidateCount: candidates.length,
      sourceReportedCount: loaded.sourceReportedCount,
      totalCount: rows.length,
      returnedCount: items.length,
      offset: filters.offset,
      limit: filters.limit,
      requestedLimit: input.limit,
      revision,
      hasMore,
      ...(hasMore
        ? {
            nextCall: {
              toolName: 'riksdag_search_members' as const,
              args: { ...filters, offset: filters.offset + items.length, revision },
            },
          }
        : {}),
    };
  },
  format: formatExact,
});
