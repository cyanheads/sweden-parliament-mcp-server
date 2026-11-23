/** @fileoverview Complete-session speech discovery and canonical text retrieval. @module mcp-server/tools/definitions/search-speeches.tool */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import {
  formatString,
  matchesAllTokens,
  normalizeCode,
  normalizeDocumentId,
  normalizeMemberId,
  normalizeSession,
  normalizeSpeechId,
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
import { pageText } from '../../../services/riksdag/pagination.js';
import {
  getRiksdagService,
  type RiksdagService,
} from '../../../services/riksdag/riksdag-service.js';
import {
  linksDocument,
  loadSpeechCandidates,
  loadSpeechDetail,
  type Speech,
  speechSchema,
} from '../../../services/riksdag/speeches.js';
import { assertRevision, codePointLength, revisionOf } from '../../../services/riksdag/text.js';
import { createToolBudget, type ToolBudget } from '../../../services/riksdag/transport.js';

const argsSchema = z.object({
  mode: z
    .enum(['search', 'get'])
    .optional()
    .describe('Search by default; get reads one retrieval speechId.'),
  session: formatString('session', { blank: true })
    .optional()
    .describe('Required in search mode; parliamentary session such as 2024/25.'),
  headingContains: z
    .string()
    .optional()
    .describe(
      'Search only: all-token local heading and subheading filter, ignoring case and diacritics; never body search.',
    ),
  relatedDocumentId: formatString('documentId', { blank: true, field: 'relatedDocumentId' })
    .optional()
    .describe(
      'Search only: report (bet) or interpellation (ip) document ID; returns the speeches the source links to it, case-insensitively, including joint debates linking several documents. A resumed debate’s later segments can lack the link; check headingContains with the report title.',
    ),
  memberId: formatString('memberId', { blank: true })
    .optional()
    .describe('Search only: numeric memberId from riksdag_search_members, keeping leading zeros.'),
  party: z
    .string()
    .optional()
    .describe('Search only: official party code or exact reference label.'),
  speechType: z
    .enum(['all', 'speech'])
    .optional()
    .describe('Search only: all by default; speech excludes replies.'),
  offset: z.number().int().min(0).optional().describe('Search only: local row offset, default 0.'),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Search only: requested rows, default 5 and applied maximum 100.'),
  textCount: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Search only: speeches to hydrate with text, default 1, maximum 5; 0 for metadata only.',
    ),
  speechId: formatString('speechId', { blank: true })
    .optional()
    .describe(
      'Required in get mode: retrieval ID copied from a search item, never the source UUID.',
    ),
  textOffset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Get only: Unicode code-point offset, default 0.'),
  textLength: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Get only: Unicode code points per text page, default 8000.'),
  revision: z
    .string()
    .optional()
    .describe('Search candidate revision or get textRevision copied from the preceding page.'),
});
const textFields = {
  textState: z
    .enum(['included', 'not_requested', 'unavailable', 'failed'])
    .describe('Whether text is included, deferred, unpublished or failed to load.'),
  text: z.string().optional().describe('Canonical Markdown body page, code-point exact.'),
  textOffset: z.number().optional().describe('Applied code-point offset.'),
  textTotalLength: z.number().optional().describe('Total canonical body length, code points.'),
  textReturnedLength: z.number().optional().describe('Code points returned in this page.'),
  textHasMore: z.boolean().optional().describe('Whether canonical body text remains.'),
  textRevision: z
    .string()
    .optional()
    .describe('Revision of the normalized detail record and canonical body.'),
  nextTextCall: toolCallSchema('riksdag_search_speeches')
    .optional()
    .describe('Get call for deferred or remaining body text.'),
  textFailure: z
    .object({
      code: z.number().describe('Transient upstream error code.'),
      reason: z.string().describe('Stable transient failure reason.'),
      recovery: z.string().describe('How to retry this speech detail.'),
    })
    .optional()
    .describe('Explicit transient detail failure; never an empty-body assertion.'),
};
/** Output-only and shared by `item` and `items[]`; the id emits it once under `$defs`. */
const itemSchema = speechSchema.extend(textFields).meta({
  id: 'RiksdagSpeechItem',
  description: 'Speech metadata and explicit text retrieval state.',
});
type Item = z.infer<typeof itemSchema>;

function getCall(speechId: string, textOffset?: number, revision?: string, textLength?: number) {
  return {
    toolName: 'riksdag_search_speeches' as const,
    args: {
      mode: 'get' as const,
      speechId,
      ...(textOffset === undefined ? {} : { textOffset }),
      ...(revision === undefined ? {} : { revision }),
      ...(textLength === undefined ? {} : { textLength }),
    },
  };
}

/**
 * One canonical body page of a found detail record on a metadata base: the detail record in get
 * mode, the search row in hydration. The revision always covers the detail record and body, the
 * value get mode recomputes, so a hydrated `nextTextCall` continues unchanged.
 */
async function detailPage(
  metadata: Speech,
  loaded: Extract<Awaited<ReturnType<typeof loadSpeechDetail>>, { found: true }>,
  offset: number,
  length: number | undefined,
  expectedRevision: string | undefined,
  enrichment: SuccessEnrichment,
  budget: ToolBudget,
): Promise<Item> {
  const revision = await revisionOf({ ...loaded.record, text: loaded.text });
  assertRevision(expectedRevision, revision);
  budget.check();
  if (loaded.text === undefined || loaded.text.trim() === '')
    return { ...metadata, textState: 'unavailable', textRevision: revision };
  const total = codePointLength(loaded.text);
  return pageText({
    text: loaded.text,
    offset,
    ...(length === undefined ? {} : { length }),
    enrichment,
    budget,
    build: (text, returnedLength): Item => {
      const hasMore = offset + returnedLength < total;
      return {
        ...metadata,
        textState: 'included',
        text,
        textOffset: offset,
        textTotalLength: total,
        textReturnedLength: returnedLength,
        textHasMore: hasMore,
        textRevision: revision,
        ...(hasMore
          ? {
              nextTextCall: getCall(
                loaded.record.speechId,
                offset + returnedLength,
                revision,
                length,
              ),
            }
          : {}),
      };
    },
  });
}

function invalidMode(mode: string, missing: string[], conflicting: string[]): never {
  throw validationError(
    `Invalid speech ${mode} mode. Missing required fields: ${missing.join(', ') || 'none'}. Conflicting supplied fields: ${conflicting.join(', ') || 'none'}.`,
    {
      reason: 'invalid_filter',
    },
  );
}

function transient(error: unknown): error is McpError {
  return (
    error instanceof McpError &&
    [
      JsonRpcErrorCode.ServiceUnavailable,
      JsonRpcErrorCode.RateLimited,
      JsonRpcErrorCode.Timeout,
    ].includes(error.code) &&
    error.data?.retryable !== false
  );
}

/** A search row before hydration, with the get call that reads its text. */
function deferredItem(row: Speech): Item {
  return { ...row, textState: 'not_requested', nextTextCall: getCall(row.speechId) };
}

/**
 * Hydrates one search row with its first text page. The row keeps its own metadata; the detail
 * supplies only text fields. A transient detail failure becomes an explicit item state.
 */
async function hydrated(
  service: RiksdagService,
  row: Speech,
  enrichment: SuccessEnrichment,
  budget: ToolBudget,
): Promise<Item> {
  budget.check();
  try {
    const detail = await loadSpeechDetail(service, budget, row.speechId);
    return detail.found
      ? await detailPage(row, detail, 0, undefined, undefined, enrichment, budget)
      : { ...deferredItem(row), textState: 'unavailable' };
  } catch (error) {
    budget.check();
    if (!transient(error)) throw error;
    return {
      ...deferredItem(row),
      textState: 'failed',
      textFailure: {
        code: error.code,
        reason: typeof error.data?.reason === 'string' ? error.data.reason : 'upstream_unavailable',
        recovery: 'Retry the included get-mode nextTextCall to retrieve this speech body.',
      },
    };
  }
}

/** Searches complete scoped speech candidates or retrieves one speech's canonical body. */
export const riksdagSearchSpeeches = tool('riksdag_search_speeches', {
  title: 'Search and read parliamentary speeches',
  description:
    'Search speeches within a required parliamentary session, optionally by member, party, reply exclusion, heading tokens or related document. Heading matching covers debate headings only, never body text. relatedDocumentId returns the speeches the source links to a report or interpellation (riksdag_get_document supplies that search as relatedSpeechesCall); a resumed debate’s later segments can lack the link. Search hydrates one text page by default; use get mode with an item speechId to read all remaining text, keeping the returned revision for continuation.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: argsSchema,
  output: z.object({
    mode: z.enum(['search', 'get']).describe('Applied search or detail mode.'),
    found: z.boolean().optional().describe('Get mode: whether the retrieval ID exists.'),
    speechId: z.string().optional().describe('Get mode: requested retrieval ID.'),
    guidance: z.string().optional().describe('Recovery guidance for an expected detail miss.'),
    item: itemSchema.optional().describe('Get mode: exact speech metadata and text page.'),
    items: z
      .array(itemSchema)
      .optional()
      .describe('Search mode: speech page after local heading and related-document filters.'),
    candidateCount: z
      .number()
      .optional()
      .describe('Validated upstream candidate count, each speechId once.'),
    totalCount: z
      .number()
      .optional()
      .describe('Exact count after local heading and related-document filters.'),
    returnedCount: z.number().optional().describe('Speech rows on this page.'),
    offset: z.number().optional().describe('Applied local row offset.'),
    requestedLimit: z.number().optional().describe('Requested search page size.'),
    limit: z.number().optional().describe('Applied search page size after clamp.'),
    textCount: z.number().optional().describe('Applied maximum speeches hydrated with text.'),
    hasMore: z.boolean().optional().describe('Whether filtered speech rows remain.'),
    revision: z
      .string()
      .optional()
      .describe('Search candidate-set revision or get detail revision.'),
    nextCall: toolCallSchema('riksdag_search_speeches')
      .optional()
      .describe('Next local search-page call.'),
  }),
  enrichment: successEnrichment,
  enrichmentTrailer: successEnrichmentTrailer,
  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Unknown party code, nonconsecutive session, punctuation-only headingContains or conflicting mode fields.',
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
        'Check memberId with riksdag_search_members or copy speechId from riksdag_search_speeches search mode, then retry; report repeated mismatches with the request identifier.',
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
        'Retry riksdag_search_speeches after the source becomes available; narrow search mode with memberId, party or speechType.',
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
        'Retry riksdag_search_speeches with memberId, party or speechType; if no narrower scope is available, this source cannot provide complete traversal for that selection.',
      thrownBy: 'service',
    },
  ],
  async handler(input, ctx) {
    using budget = createToolBudget(ctx.signal);
    const mode = input.mode ?? 'search';
    const searchKeys = [
      'session',
      'headingContains',
      'relatedDocumentId',
      'memberId',
      'party',
      'speechType',
      'offset',
      'limit',
      'textCount',
    ] as const;
    const required = mode === 'get' ? 'speechId' : 'session';
    const missing = optionalString(input[required]) ? [] : [required];
    const forbidden =
      mode === 'get' ? searchKeys : (['speechId', 'textOffset', 'textLength'] as const);
    const conflicting = forbidden.filter((key) => input[key] !== undefined);
    if (missing.length || conflicting.length) invalidMode(mode, missing, conflicting);
    const service = getRiksdagService();
    if (mode === 'get') {
      const speechId = normalizeSpeechId(input.speechId ?? '');
      const filters = {
        mode: 'get',
        speechId,
        textOffset: input.textOffset ?? 0,
        ...(input.textLength === undefined ? {} : { textLength: input.textLength }),
      };
      const loaded = await loadSpeechDetail(service, budget, speechId);
      const enrichment: SuccessEnrichment = {
        effectiveQuery: effectiveQuery(filters),
        source: 'Source: The Swedish Parliament',
        retrievedAt: loaded.retrievedAt,
        notices: [],
      };
      if (!loaded.found) {
        budget.check();
        ctx.enrich(enrichment);
        return {
          mode: 'get' as const,
          found: false,
          speechId,
          guidance:
            'Retry riksdag_search_speeches in search mode and copy speechId from a returned item.',
        };
      }
      const item = await detailPage(
        loaded.record,
        loaded,
        filters.textOffset,
        input.textLength,
        optionalString(input.revision),
        enrichment,
        budget,
      );
      budget.check();
      ctx.enrich(enrichment);
      return { mode: 'get' as const, found: true, speechId, item, revision: item.textRevision };
    }
    const heading = optionalString(input.headingContains),
      related = optionalString(input.relatedDocumentId),
      member = optionalString(input.memberId),
      party = optionalString(input.party);
    const filters = {
      mode: 'search' as const,
      session: normalizeSession(input.session ?? ''),
      ...(heading ? { headingContains: heading } : {}),
      ...(related ? { relatedDocumentId: normalizeDocumentId(related, 'relatedDocumentId') } : {}),
      ...(member ? { memberId: normalizeMemberId(member) } : {}),
      ...(party ? { party: normalizeCode(party, 'parties', 'party') } : {}),
      speechType: input.speechType ?? 'all',
      offset: input.offset ?? 0,
      limit: Math.min(input.limit ?? 5, 100),
      textCount: Math.min(input.textCount ?? 1, 5),
    };
    const tokens = heading ? normalizeTokens(heading) : [];
    const loaded = await loadSpeechCandidates(service, budget, filters);
    const revision = await revisionOf(loaded.records);
    assertRevision(optionalString(input.revision), revision);
    const rows = loaded.records.filter(
      (row) =>
        (!heading || matchesAllTokens(`${row.heading ?? ''} ${row.subheading ?? ''}`, tokens)) &&
        (filters.relatedDocumentId === undefined || linksDocument(row, filters.relatedDocumentId)),
    );
    const enrichment: SuccessEnrichment = {
      effectiveQuery: effectiveQuery(filters),
      source: 'Source: The Swedish Parliament',
      retrievedAt: loaded.retrievedAt,
      notices: [
        'headingContains matches heading and subheading tokens locally; speech body text is not searched. The total describes the complete validated source candidate response.',
      ],
    };
    if ((input.limit ?? 5) > 100) enrichment.notices.push('Requested limit was clamped to 100.');
    if ((input.textCount ?? 1) > 5)
      enrichment.notices.push('Requested textCount was clamped to 5.');
    if (loaded.collapsedCount > 0)
      enrichment.notices.push(
        `Collapsed ${loaded.collapsedCount} duplicate source ${loaded.collapsedCount === 1 ? 'row' : 'rows'}: the source publishes some speeches twice under one speechId, identical apart from the source UUID; each is counted and listed once, keeping the lowest sourceSpeechId.`,
      );
    if (!rows.length)
      enrichment.notices.push(
        filters.relatedDocumentId === undefined
          ? 'No speeches matched these session and heading filters. Remove headingContains to browse the session, check memberId with riksdag_search_members, or check speech types with riksdag_list_reference.'
          : 'No speeches in this session link to relatedDocumentId under these filters. A report decided without debate has no speeches; check the document ID and its session with riksdag_get_document, or remove relatedDocumentId to browse the session.',
      );
    budget.check();
    const items: Item[] = [];
    for (const [index, row] of rows.slice(filters.offset, filters.offset + filters.limit).entries())
      items.push(
        index < filters.textCount
          ? await hydrated(service, row, enrichment, budget)
          : deferredItem(row),
      );
    const hasMore = filters.offset + items.length < rows.length;
    budget.check();
    ctx.enrich(enrichment);
    return {
      mode: 'search' as const,
      items,
      candidateCount: loaded.records.length,
      totalCount: rows.length,
      returnedCount: items.length,
      offset: filters.offset,
      requestedLimit: input.limit ?? 5,
      limit: filters.limit,
      textCount: Math.min(filters.textCount, items.length),
      revision,
      hasMore,
      ...(hasMore
        ? {
            nextCall: {
              toolName: 'riksdag_search_speeches' as const,
              args: { ...filters, offset: filters.offset + items.length, revision },
            },
          }
        : {}),
    };
  },
  format: formatExact,
});
