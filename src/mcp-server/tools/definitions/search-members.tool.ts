/** @fileoverview Complete-register member discovery with local filters. @module mcp-server/tools/definitions/search-members.tool */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { loadMembers, memberSchema } from '../../../services/riksdag/members.js';
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
} from '../../../services/riksdag/output.js';
import { fitRows } from '../../../services/riksdag/pagination.js';
import { getRiksdagService } from '../../../services/riksdag/riksdag-service.js';
import { assertRevision, revisionOf } from '../../../services/riksdag/text.js';
import { createToolBudget } from '../../../services/riksdag/transport.js';

const argsSchema = z.object({
  nameContains: z
    .string()
    .optional()
    .describe('Strict all-token local name filter, ignoring case and diacritics.'),
  party: z.string().optional().describe('Party code or exact reference label.'),
  constituency: z
    .string()
    .optional()
    .describe('Exact constituency reference label or code, applied locally.'),
  sitting: z
    .enum(['all', 'serving', 'not_serving'])
    .default('all')
    .describe('Source service classification; all retains unknown status.'),
  offset: z.number().int().min(0).default(0).describe('Local row offset.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(10000)
    .default(20)
    .describe('Requested rows; applied maximum 100.'),
  revision: z.string().optional().describe('Revision returned by a preceding page.'),
});
/** Finds member IDs without treating the service register as sitting membership. */
export const riksdagSearchMembers = tool('riksdag_search_members', {
  title: 'Search parliamentary members',
  description:
    'Find members and ministers by name, party, constituency and service status. Service-register entries include historical records; use riksdag_get_member for assignment history.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: argsSchema,
  output: z.object({
    items: z.array(memberSchema).describe('Filtered member-register rows.'),
    candidateCount: z.number().describe('Complete upstream candidate count.'),
    totalCount: z.number().describe('Exact count after local filtering.'),
    returnedCount: z.number().describe('Rows in this page.'),
    offset: z.number().describe('Applied local offset.'),
    limit: z.number().describe('Applied row limit.'),
    requestedLimit: z.number().describe('Requested row limit before clamping and fitting.'),
    truncated: z.boolean().describe('Whether response fitting shortened the selected page.'),
    hasMore: z.boolean().describe('Whether filtered rows remain.'),
    revision: z.string().describe('Complete candidate-set revision.'),
    nextCall: z
      .object({
        toolName: z.literal('riksdag_search_members').describe('Tool to call next.'),
        args: argsSchema.describe('Complete normalized next-page arguments.'),
      })
      .optional()
      .describe('Complete next-page call.'),
  }),
  enrichment: successEnrichment,
  enrichmentTrailer: successEnrichmentTrailer,
  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Unknown code or malformed identifier.',
      recovery:
        'Use riksdag_list_reference to check codes and identifier formats, then retry the same tool with corrected filters.',
      thrownBy: 'service',
    },
    {
      reason: 'revision_changed',
      code: JsonRpcErrorCode.Conflict,
      when: 'Continuation revision no longer matches.',
      recovery:
        'Restart the same tool without revision and begin at the first page to read one consistent record.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_identity_mismatch',
      code: JsonRpcErrorCode.SerializationError,
      when: 'Detail identity or filter rows contradict required identity.',
      recovery:
        'Check party and constituency with riksdag_list_reference and retry riksdag_search_members; report repeated mismatches with the request identifier.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_schema_invalid',
      code: JsonRpcErrorCode.SerializationError,
      when: 'Present payload violates wire contract.',
      recovery: 'Retry the same tool later; report repeated failures with the request identifier.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Network or service error after retries.',
      recovery:
        'Retry riksdag_search_members with the same filters after the source becomes available.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_queue_full',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Process upstream queue is full.',
      recovery: 'Wait before retrying the same tool, and request fewer simultaneous searches.',
      thrownBy: 'service',
    },
    {
      reason: 'candidate_limit_reached',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Complete-list safety boundary reached.',
      recovery:
        'Retry riksdag_search_members with a party filter from riksdag_list_reference; the complete register is too large for this selection.',
      thrownBy: 'service',
    },
  ],
  async handler(input, ctx) {
    using budget = createToolBudget(ctx.signal);
    const name = optionalString(input.nameContains),
      partyInput = optionalString(input.party),
      constituencyInput = optionalString(input.constituency);
    const filters = {
      nameContains: name,
      party: partyInput ? normalizeCode(partyInput, 'parties') : undefined,
      constituency: constituencyInput
        ? normalizeCode(constituencyInput, 'constituencies')
        : undefined,
      sitting: input.sitting,
      offset: input.offset,
      limit: Math.min(input.limit, 100),
    };
    const tokens = name ? normalizeTokens(name) : [];
    const loaded = await loadMembers(
      getRiksdagService(),
      budget,
      filters.party ? { party: filters.party } : {},
    );
    const candidates = loaded.records
      .map(({ assignments: _assignments, ...member }) => member)
      .sort((a, b) =>
        (a.memberId ?? a.sourceRecordId ?? '').localeCompare(b.memberId ?? b.sourceRecordId ?? ''),
      );
    const revision = await revisionOf(candidates);
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
    if (rows.some((member) => !member.detailAvailable))
      enrichment.notices.push(
        'Some entries have no published member IID: detailAvailable is false and sourceRecordId is a distinct register UUID. Read their sourceUrl; do not pass the UUID to riksdag_get_member.',
      );
    if (!rows.length)
      enrichment.notices.push(
        'No register entries matched these local filters. Retry riksdag_search_members with sitting all or fewer name tokens; use riksdag_list_reference for party and constituency codes.',
      );
    const result = fitRows({
      rows,
      offset: filters.offset,
      limit: filters.limit,
      enrichment,
      budget,
      build: (items, limit, truncated) => {
        const hasMore = filters.offset + items.length < rows.length;
        return {
          items,
          candidateCount: candidates.length,
          totalCount: rows.length,
          returnedCount: items.length,
          offset: filters.offset,
          limit,
          requestedLimit: input.limit,
          truncated,
          revision,
          hasMore,
          ...(hasMore
            ? {
                nextCall: {
                  toolName: 'riksdag_search_members' as const,
                  args: { ...filters, limit, offset: filters.offset + items.length, revision },
                },
              }
            : {}),
        };
      },
    });
    budget.check();
    ctx.enrich(enrichment);
    return result;
  },
  format: formatExact,
});
