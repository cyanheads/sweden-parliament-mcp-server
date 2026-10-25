/** @fileoverview Exact-IID member detail and assignment continuation. @module mcp-server/tools/definitions/get-member.tool */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { assignmentSchema, loadMembers, memberSchema } from '../../../services/riksdag/members.js';
import { normalizeMemberId, optionalString } from '../../../services/riksdag/normalize.js';
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
  memberId: z
    .string()
    .min(1)
    .describe('Numeric member IID copied from search, including leading zeros.'),
  assignmentOffset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Assignment offset in published source order.'),
  assignmentLimit: z
    .number()
    .int()
    .min(1)
    .max(10000)
    .default(20)
    .describe('Requested assignments; applied maximum 100.'),
  revision: z.string().optional().describe('Revision returned by the preceding assignment page.'),
});
/** Reads exact register identity and every published assignment through continuation. */
export const riksdagGetMember = tool('riksdag_get_member', {
  title: 'Read parliamentary member',
  description:
    'Read one member register entry and assignment history by exact member ID. Assignment dates preserve source precision and do not establish historical sitting status.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: argsSchema,
  output: z
    .object({
      found: z.boolean().describe('Whether the exact member IID exists.'),
      ...memberSchema.shape,
      guidance: z.string().optional().describe('Next step when the member IID is absent.'),
      assignments: z
        .array(assignmentSchema)
        .optional()
        .describe('Published assignments in source order.'),
      assignmentTotal: z.number().optional().describe('Exact total published assignments.'),
      truncated: z
        .boolean()
        .optional()
        .describe('Whether further assignments remain available through nextCall.'),
      returnedCount: z.number().optional().describe('Assignments returned on this page.'),
      assignmentOffset: z.number().optional().describe('Applied assignment offset.'),
      assignmentLimit: z.number().optional().describe('Applied assignment limit.'),
      requestedAssignmentLimit: z
        .number()
        .optional()
        .describe('Requested assignment limit before clamping and fitting.'),
      hasMore: z.boolean().optional().describe('Whether assignments remain.'),
      revision: z.string().optional().describe('Complete normalized member record revision.'),
      nextCall: z
        .object({
          toolName: z.literal('riksdag_get_member').describe('Tool to call next.'),
          args: argsSchema.describe('Complete normalized next-assignment arguments.'),
        })
        .optional()
        .describe('Complete next-assignment call.'),
    })
    .extend({
      serviceClassification: memberSchema.shape.serviceClassification.optional(),
      detailAvailable: memberSchema.shape.detailAvailable.optional(),
      sourceUrl: memberSchema.shape.sourceUrl.optional(),
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
        'Retry the same tool with an identifier copied from riksdag_search_documents, riksdag_search_speeches or riksdag_search_members; report repeated mismatches.',
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
        'Retry the same tool later; narrow riksdag_search_documents or riksdag_search_speeches with session filters.',
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
        'Use riksdag_search_members with a party filter to resolve a member ID, then retry riksdag_get_member with that exact numeric ID.',
      thrownBy: 'service',
    },
  ],
  async handler(input, ctx) {
    using budget = createToolBudget(ctx.signal);
    const filters = {
      memberId: normalizeMemberId(input.memberId),
      assignmentOffset: input.assignmentOffset,
      assignmentLimit: Math.min(input.assignmentLimit, 100),
    };
    const loaded = await loadMembers(getRiksdagService(), budget, { memberId: filters.memberId });
    const enrichment: SuccessEnrichment = {
      effectiveQuery: effectiveQuery(filters),
      source: 'Source: The Swedish Parliament',
      retrievedAt: loaded.retrievedAt,
      notices: [],
    };
    if (input.assignmentLimit > 100)
      enrichment.notices.push('Requested assignmentLimit was clamped to 100.');
    const record = loaded.records[0];
    if (!record) {
      budget.check();
      ctx.enrich(enrichment);
      return {
        found: false,
        memberId: filters.memberId,
        guidance:
          'Use riksdag_search_members to find the member ID; copy memberId including leading zeros.',
      };
    }
    const revision = await revisionOf(record);
    assertRevision(optionalString(input.revision), revision);
    const { assignments, ...member } = record;
    enrichment.notices.push(
      'Assignment dates are source data and do not establish historical sitting status.',
    );
    const result = fitRows({
      rows: assignments,
      offset: filters.assignmentOffset,
      limit: filters.assignmentLimit,
      enrichment,
      budget,
      build: (selected, assignmentLimit) => {
        const hasMore = filters.assignmentOffset + selected.length < assignments.length;
        return {
          found: true,
          ...member,
          assignments: selected,
          assignmentTotal: assignments.length,
          returnedCount: selected.length,
          assignmentOffset: filters.assignmentOffset,
          assignmentLimit,
          requestedAssignmentLimit: input.assignmentLimit,
          revision,
          hasMore,
          truncated: hasMore,
          ...(hasMore
            ? {
                nextCall: {
                  toolName: 'riksdag_get_member' as const,
                  args: {
                    ...filters,
                    assignmentLimit,
                    assignmentOffset: filters.assignmentOffset + selected.length,
                    revision,
                  },
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
