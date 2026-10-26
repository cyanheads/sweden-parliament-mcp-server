/**
 * @fileoverview Authoritative report-point and complete member main-vote workflows.
 * @module mcp-server/tools/definitions/get-votes
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  normalizeCode,
  normalizeDocumentId,
  normalizeMemberId,
  normalizeReport,
  normalizeSession,
  optionalString,
} from '../../../services/riksdag/normalize.js';
import {
  effectiveQuery,
  formatExact,
  measureResponse,
  type SuccessEnrichment,
  successEnrichment,
  successEnrichmentTrailer,
} from '../../../services/riksdag/output.js';
import { fitRows, RESPONSE_TARGET_BYTES } from '../../../services/riksdag/pagination.js';
import { getRiksdagService } from '../../../services/riksdag/riksdag-service.js';
import { assertRevision, revisionOf } from '../../../services/riksdag/text.js';
import { createToolBudget } from '../../../services/riksdag/transport.js';
import {
  hydrateVotePoint,
  loadMemberVotes,
  loadPointBallots,
  loadVoteReport,
  memberVoteSchema,
  reportPointSchema,
} from '../../../services/riksdag/votes.js';

const optionalText = z.preprocess(
  (value) => (typeof value === 'string' ? optionalString(value) : value),
  z.string().optional(),
);
const inputSchema = z.object({
  mode: z
    .enum(['report', 'member'])
    .describe('Report decision points or one member’s session main votes.'),
  session: z.string().min(1).describe('Required parliamentary session, for example 2024/25.'),
  report: optionalText.describe('Report designation or session:designation; report mode only.'),
  documentId: optionalText.describe(
    'Report mode: documentId from riksdag_search_documents with documentType bet; alternative to report.',
  ),
  point: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('One authoritative report point; omit to traverse all points.'),
  memberId: optionalText.describe(
    'Required in member mode: numeric memberId from riksdag_search_members, including leading zeros.',
  ),
  party: optionalText.describe(
    'Member-mode local party filter; report party groups are always complete.',
  ),
  ballots: z
    .boolean()
    .optional()
    .describe('Report mode only: include individual ballots for an explicit point; default false.'),
  ballotRevision: optionalText.describe(
    'Returned ballot-page revision for consistent report-ballot continuation.',
  ),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Member or explicit report-ballot local row offset; default 0.'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Member or report-ballot requested rows; default 20, applied maximum 500.'),
  pointOffset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('All-points report local offset; default 0.'),
  pointLimit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('All-points report page size; default 5, applied maximum 10.'),
  revision: optionalText.describe(
    'Returned complete-candidate or report-catalog revision for consistent continuation.',
  ),
});
const nextCallSchema = z
  .object({
    toolName: z.literal('riksdag_get_votes').describe('Tool to call next.'),
    args: inputSchema.describe('Complete normalized continuation arguments.'),
  })
  .describe('Complete main-vote continuation call.');
const outputSchema = z.object({
  mode: z.enum(['report', 'member']).describe('Applied workflow.'),
  session: z.string().describe('Normalized parliamentary session.'),
  found: z
    .boolean()
    .describe(
      'Whether the selected report or member-vote selection is available; empty member rows remain a successful selection.',
    ),
  report: z.string().optional().describe('Normalized report designation.'),
  documentId: z.string().optional().describe('Authoritative report document ID.'),
  memberId: z.string().optional().describe('Normalized member ID, preserving leading zeros.'),
  party: z.string().optional().describe('Applied member-mode party filter.'),
  guidance: z.string().optional().describe('How to resolve a missing report.'),
  revision: z
    .string()
    .optional()
    .describe('Hash of complete normalized candidates or authoritative point catalog.'),
  points: z
    .array(reportPointSchema)
    .optional()
    .describe('Whole report points with every party aggregate and complete decision evidence.'),
  votes: z
    .array(memberVoteSchema)
    .optional()
    .describe('Whole member or explicit report-point main ballots after local pagination.'),
  candidateCount: z
    .number()
    .int()
    .optional()
    .describe(
      'Complete validated member/session candidate count, optionally narrowed upstream by party, before local filtering.',
    ),
  totalCount: z
    .number()
    .int()
    .optional()
    .describe('Exact filtered member-vote total or selected report-point total.'),
  pointTotalCount: z
    .number()
    .int()
    .optional()
    .describe('Exact complete authoritative report-point catalog count.'),
  returnedCount: z.number().int().optional().describe('Actual returned whole rows or points.'),
  offset: z.number().int().optional().describe('Applied member row offset.'),
  limit: z.number().int().optional().describe('Applied member row limit after fitting.'),
  requestedLimit: z.number().int().optional().describe('Original requested member row limit.'),
  pointOffset: z.number().int().optional().describe('Applied report-point offset.'),
  pointLimit: z
    .number()
    .int()
    .optional()
    .describe('Applied report-point limit after measured fitting.'),
  requestedPointLimit: z
    .number()
    .int()
    .optional()
    .describe('Original requested report-point limit.'),
  truncated: z
    .boolean()
    .optional()
    .describe('Response fitting shortened the requested local page.'),
  hasMore: z.boolean().optional().describe('More whole rows or report points remain.'),
  nextCall: nextCallSchema
    .optional()
    .describe('Complete continuation advancing by actual returned entries.'),
  ballotPage: z
    .object({
      revision: z.string().describe('Revision of the complete point-ballot selection.'),
      totalCount: z.number().int().nonnegative().describe('Exact complete point-ballot count.'),
      returnedCount: z.number().int().nonnegative().describe('Returned whole ballot rows.'),
      offset: z.number().int().nonnegative().describe('Applied ballot row offset.'),
      limit: z.number().int().positive().describe('Applied ballot limit after fitting.'),
      requestedLimit: z.number().int().positive().describe('Requested ballot row limit.'),
      truncated: z.boolean().describe('Response fitting shortened this ballot page.'),
      hasMore: z.boolean().describe('More whole ballots remain.'),
      nextCall: nextCallSchema.optional().describe('Complete report-ballot continuation call.'),
    })
    .optional()
    .describe(
      'Independent ballot pagination; report-point counts and revision retain their meanings.',
    ),
});

/** Read main votes without mistaking missing publication for acclamation. */
export const riksdagGetVotes = tool('riksdag_get_votes', {
  title: 'Read parliamentary main votes',
  description:
    'Read authoritative report decisions and party main-vote groups separated by avser, or a member’s session main votes. Report mode requires report or documentId; ballots true with an explicit point adds individual member ballots and independent ballotPage continuation. Member mode requires memberId. Follow complete local continuation calls. Main votes do not include every ballot round; empty rows never prove acclamation.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: inputSchema,
  output: outputSchema,
  enrichment: successEnrichment,
  enrichmentTrailer: successEnrichmentTrailer,
  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Mode fields conflict, a required mode identifier is missing, or a filter is invalid.',
      recovery:
        'Use riksdag_list_reference to check codes and identifier formats, then retry the same tool with corrected filters.',
    },
    {
      reason: 'revision_changed',
      code: JsonRpcErrorCode.Conflict,
      when: 'The complete record changed during continuation.',
      recovery:
        'Restart the same tool without revision or ballotRevision and begin at the first page to read one consistent record.',
      thrownBy: 'service',
    },
    {
      reason: 'unknown_point',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The existing report lacks the requested point.',
      recovery:
        'Call riksdag_get_document with sections decisions, then retry riksdag_get_votes with a listed point.',
    },
    {
      reason: 'ambiguous_report',
      code: JsonRpcErrorCode.ValidationError,
      when: 'More than one exact report matched.',
      recovery:
        'Use riksdag_search_documents to resolve the report and pass its documentId to riksdag_get_votes.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_identity_mismatch',
      code: JsonRpcErrorCode.SerializationError,
      when: 'Source identities contradict the required selection.',
      recovery:
        'Resolve report documentId with riksdag_search_documents or memberId with riksdag_search_members, then retry the matching mode; report repeated mismatches with the request identifier.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_schema_invalid',
      code: JsonRpcErrorCode.SerializationError,
      when: 'Present payload violates the wire contract.',
      recovery: 'Retry the same tool later; report repeated failures with the request identifier.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Network or source failure remains after retries.',
      recovery:
        'Retry riksdag_get_votes with the same report or member selection after the source becomes available.',
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
      when: 'The complete main-ballot candidate boundary is reached.',
      recovery:
        'In member mode, retry riksdag_get_votes with a party filter. A saturated report-point ballot selection has no narrower complete traversal on this source.',
      thrownBy: 'service',
    },
  ],
  async handler(input, ctx) {
    using budget = createToolBudget(ctx.signal);
    const session = normalizeSession(input.session);
    if (input.mode === 'report') {
      if (
        input.memberId !== undefined ||
        input.party !== undefined ||
        (!input.ballots &&
          (input.offset !== undefined ||
            input.limit !== undefined ||
            input.ballotRevision !== undefined)) ||
        (input.ballots && input.point === undefined) ||
        (!input.report && !input.documentId) ||
        (input.point !== undefined &&
          (input.pointOffset !== undefined || input.pointLimit !== undefined))
      )
        throw ctx.fail(
          'invalid_filter',
          'Report mode requires report or documentId and rejects member fields. Ballots require an explicit point; row pagination and ballotRevision require ballots. A single point cannot use point pagination.',
        );
    } else if (
      !input.memberId ||
      input.report !== undefined ||
      input.documentId !== undefined ||
      input.point !== undefined ||
      input.pointOffset !== undefined ||
      input.pointLimit !== undefined ||
      input.ballots !== undefined ||
      input.ballotRevision !== undefined
    ) {
      throw ctx.fail(
        'invalid_filter',
        'Member mode requires memberId and rejects report identifiers and point fields.',
      );
    }
    const service = getRiksdagService();
    const enrichment: SuccessEnrichment = {
      effectiveQuery: '',
      source: 'Source: The Swedish Parliament',
      retrievedAt: '',
      notices: [
        'Vote data covers published main votes (huvudvoteringar), not every ballot round; historical coverage can be incomplete.',
      ],
    };
    if (input.mode === 'member') {
      const memberId = normalizeMemberId(input.memberId ?? '');
      const party = input.party ? normalizeCode(input.party, 'parties') : undefined;
      const offset = input.offset ?? 0;
      const requestedLimit = input.limit ?? 20;
      const limit = Math.min(requestedLimit, 500);
      const args = {
        mode: 'member' as const,
        session,
        memberId,
        ...(party ? { party } : {}),
        offset,
        limit,
      };
      const loaded = await loadMemberVotes(service, session, memberId, party, budget);
      assertRevision(input.revision, loaded.revision);
      Object.assign(enrichment, {
        effectiveQuery: effectiveQuery(args),
        retrievedAt: loaded.retrievedAt,
        ...(loaded.upstreamQuery ? { upstreamQuery: loaded.upstreamQuery } : {}),
        ...(loaded.upstreamWarnings ? { upstreamWarnings: loaded.upstreamWarnings } : {}),
      });
      if (requestedLimit > 500) enrichment.notices.push('Requested limit was clamped to 500.');
      if (loaded.rows.length === 0)
        enrichment.notices.push(
          'No published main votes matched these filters. Check memberId with riksdag_search_members and session with riksdag_list_reference; no votes does not establish absence or an acclamation decision.',
        );
      if (offset > loaded.rows.length)
        enrichment.notices.push(
          'The row offset is beyond the filtered result; this is an empty terminal page.',
        );
      const result = fitRows({
        rows: loaded.rows,
        offset,
        limit,
        enrichment,
        budget,
        build: (votes, appliedLimit, truncated): z.infer<typeof outputSchema> => {
          const hasMore = offset + votes.length < loaded.rows.length;
          return {
            mode: 'member',
            session,
            memberId,
            ...(party ? { party } : {}),
            found: true,
            votes,
            revision: loaded.revision,
            candidateCount: loaded.candidateCount,
            totalCount: loaded.rows.length,
            returnedCount: votes.length,
            offset,
            limit: appliedLimit,
            requestedLimit,
            truncated,
            hasMore,
            ...(hasMore
              ? {
                  nextCall: {
                    toolName: 'riksdag_get_votes',
                    args: { ...args, offset: offset + votes.length, revision: loaded.revision },
                  },
                }
              : {}),
          };
        },
      });
      budget.check();
      ctx.enrich(enrichment);
      return result;
    }
    const report = input.report ? normalizeReport(input.report, session) : undefined;
    const documentId = input.documentId ? normalizeDocumentId(input.documentId) : undefined;
    const pointOffset = input.point === undefined ? (input.pointOffset ?? 0) : 0;
    const requestedPointLimit = input.point === undefined ? (input.pointLimit ?? 5) : 1;
    const pointLimit = Math.min(requestedPointLimit, 10);
    const args = {
      mode: 'report' as const,
      session,
      ...(report ? { report } : {}),
      ...(documentId ? { documentId } : {}),
      ...(input.point === undefined ? { pointOffset, pointLimit } : { point: input.point }),
    };
    enrichment.effectiveQuery = effectiveQuery(args);
    if (requestedPointLimit > 10)
      enrichment.notices.push('Requested pointLimit was clamped to 10.');
    const loaded = await loadVoteReport(service, session, report, documentId, budget);
    enrichment.retrievedAt = loaded.retrievedAt;
    if (!loaded.found) {
      budget.check();
      ctx.enrich(enrichment);
      return {
        mode: 'report' as const,
        session,
        found: false,
        ...(report ? { report } : {}),
        ...(documentId ? { documentId } : {}),
        guidance:
          'Use riksdag_search_documents with documentType bet and the session to find the report document ID.',
      };
    }
    assertRevision(input.revision, loaded.revision);
    const requestedDecision =
      input.point === undefined
        ? undefined
        : loaded.decisions.find((decision) => decision.point === input.point);
    if (input.point !== undefined && requestedDecision === undefined)
      throw ctx.fail(
        'unknown_point',
        'The authoritative report does not contain the requested point.',
      );
    const selected = requestedDecision ? [requestedDecision] : loaded.decisions;
    if (pointOffset > selected.length)
      enrichment.notices.push(
        'The point offset is beyond the report catalog; this is an empty terminal page.',
      );
    const points: z.infer<typeof reportPointSchema>[] = [];
    const build = (truncated: boolean): z.infer<typeof outputSchema> => {
      const hasMore = pointOffset + points.length < selected.length;
      return {
        mode: 'report',
        session,
        found: true,
        report: loaded.report,
        documentId: loaded.documentId,
        revision: loaded.revision,
        points: [...points],
        pointTotalCount: loaded.decisions.length,
        totalCount: selected.length,
        returnedCount: points.length,
        pointOffset,
        pointLimit: truncated ? points.length : pointLimit,
        requestedPointLimit,
        truncated,
        hasMore,
        ...(hasMore
          ? {
              nextCall: {
                toolName: 'riksdag_get_votes',
                args: {
                  ...args,
                  report: loaded.report,
                  documentId: loaded.documentId,
                  pointOffset: pointOffset + points.length,
                  pointLimit,
                  revision: loaded.revision,
                },
              },
            }
          : {}),
      };
    };
    if (input.ballots && requestedDecision) {
      const decision = requestedDecision;
      const ballots = await loadPointBallots(
        service,
        session,
        loaded.report,
        loaded.documentId,
        decision.point,
        budget,
      );
      const ballotRevision = await revisionOf(ballots.rows);
      assertRevision(input.ballotRevision, ballotRevision);
      const point = await hydrateVotePoint(
        service,
        session,
        loaded.report,
        loaded.documentId,
        decision,
        budget,
        ballots,
      );
      points.push(point);
      const unassignedPartyBallotCount = ballots.rows.filter(
        (row) => row.party === undefined,
      ).length;
      if (unassignedPartyBallotCount)
        enrichment.notices.push(
          `Point ${decision.point}: ${unassignedPartyBallotCount} published ballots omit party identity and cannot be assigned to named party aggregates; individual ballots retain these rows.`,
        );
      if (point.parties.some((party) => party.observedVoteLabels !== undefined))
        enrichment.notices.push(
          `Point ${decision.point}: some ballots omit vote labels; exact counts remain unknown for those party/avser groups. Observed labels retain their source wording.`,
        );
      const offset = input.offset ?? 0;
      const requestedLimit = input.limit ?? 20;
      const limit = Math.min(requestedLimit, 500);
      Object.assign(enrichment, {
        effectiveQuery: effectiveQuery({ ...args, ballots: true, offset, limit }),
        ...(ballots.upstreamQuery ? { upstreamQuery: ballots.upstreamQuery } : {}),
        ...(ballots.upstreamWarnings ? { upstreamWarnings: ballots.upstreamWarnings } : {}),
      });
      if (requestedLimit > 500) enrichment.notices.push('Requested limit was clamped to 500.');
      if (ballots.rows.length === 0)
        enrichment.notices.push(
          'No main ballots are published for this point; only explicit decision evidence establishes acclamation.',
        );
      if (offset > ballots.rows.length)
        enrichment.notices.push(
          'The ballot offset is beyond the complete result; this is an empty terminal page.',
        );
      const result = fitRows({
        rows: ballots.rows,
        offset,
        limit,
        enrichment,
        budget,
        build: (votes, appliedLimit, truncated): z.infer<typeof outputSchema> => {
          const hasMore = offset + votes.length < ballots.rows.length;
          return {
            ...build(false),
            votes,
            ballotPage: {
              revision: ballotRevision,
              totalCount: ballots.rows.length,
              returnedCount: votes.length,
              offset,
              limit: appliedLimit,
              requestedLimit,
              truncated,
              hasMore,
              ...(hasMore
                ? {
                    nextCall: {
                      toolName: 'riksdag_get_votes',
                      args: {
                        ...args,
                        report: loaded.report,
                        documentId: loaded.documentId,
                        ballots: true,
                        offset: offset + votes.length,
                        limit,
                        revision: loaded.revision,
                        ballotRevision,
                      },
                    },
                  }
                : {}),
            },
          };
        },
      });
      budget.check();
      ctx.enrich(enrichment);
      return result;
    }
    let truncated = false;
    for (const decision of selected.slice(pointOffset, pointOffset + pointLimit)) {
      budget.check();
      const ballots = await loadPointBallots(
        service,
        session,
        loaded.report,
        loaded.documentId,
        decision.point,
        budget,
      );
      const point = await hydrateVotePoint(
        service,
        session,
        loaded.report,
        loaded.documentId,
        decision,
        budget,
        ballots,
      );
      points.push(point);
      const unassignedPartyBallotCount = ballots.rows.filter(
        (row) => row.party === undefined,
      ).length;
      if (unassignedPartyBallotCount)
        enrichment.notices.push(
          `Point ${decision.point}: ${unassignedPartyBallotCount} published ballots omit party identity and cannot be assigned to named party aggregates; request ballots true with this point to inspect every row.`,
        );
      if (
        point.parties.some(
          (party) =>
            party.yes === undefined ||
            party.no === undefined ||
            party.abstain === undefined ||
            party.absent === undefined,
        )
      )
        enrichment.notices.push(
          `Point ${decision.point}: some ballots omit vote labels; exact counts remain unknown, not zero for those party/avser groups. Observed labels and explicit summary-table counts retain their separate source evidence.`,
        );
      if (measureResponse(build(false), enrichment) > RESPONSE_TARGET_BYTES) {
        truncated =
          points.length < Math.min(pointLimit, Math.max(0, selected.length - pointOffset));
        enrichment.notices.push(
          'The measured whole-point page reaches the response target. Every hydrated point and all party groups are returned intact; continuation advances after the returned points.',
        );
        break;
      }
    }
    const result = build(truncated);
    budget.check();
    ctx.enrich(enrichment);
    return result;
  },
  format: formatExact,
});
