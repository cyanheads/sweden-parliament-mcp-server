/** @fileoverview Complete-session speech discovery and canonical text retrieval. @module mcp-server/tools/definitions/search-speeches.tool */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import {
  matchesAllTokens,
  normalizeCode,
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
} from '../../../services/riksdag/output.js';
import { fitRows, fitText, fitTextPages } from '../../../services/riksdag/pagination.js';
import { getRiksdagService } from '../../../services/riksdag/riksdag-service.js';
import {
  loadSpeechCandidates,
  loadSpeechDetail,
  speechSchema,
} from '../../../services/riksdag/speeches.js';
import {
  assertRevision,
  codePointLength,
  revisionOf,
  sliceCodePoints,
} from '../../../services/riksdag/text.js';
import { createToolBudget, type ToolBudget } from '../../../services/riksdag/transport.js';

const argsSchema = z.object({
  mode: z
    .enum(['search', 'get'])
    .optional()
    .describe('Search by default; get reads one retrieval speechId.'),
  session: z
    .string()
    .optional()
    .describe('Required in search mode; parliamentary session such as 2024/25.'),
  headingContains: z
    .string()
    .optional()
    .describe(
      'Search only: all-token local heading and subheading filter, ignoring case and diacritics; never body search.',
    ),
  memberId: z
    .string()
    .optional()
    .describe(
      'Search only: numeric memberId from riksdag_search_members, retaining leading zeros.',
    ),
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
    .describe('Search only: requested rows, default 5 and applied maximum 20.'),
  textCount: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Search only: maximum speeches to request text for, default 1 and applied maximum 5; 0 returns metadata.',
    ),
  speechId: z
    .string()
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
    .describe(
      'Get only: requested Unicode code points; defaults start at 8000 and fit the complete response; explicit lengths are honored.',
    ),
  revision: z
    .string()
    .optional()
    .describe('Search candidate revision or get textRevision copied from the preceding page.'),
});
const getArgsSchema = z.object({
  mode: z.literal('get').describe('Read a single speech.'),
  speechId: z.string().describe('Exact speech retrieval ID.'),
  textOffset: z.number().optional().describe('Next Unicode code-point offset.'),
  textLength: z.number().optional().describe('Explicit text-page size when supplied.'),
  revision: z.string().optional().describe('Complete detail record revision.'),
});
const textCallSchema = z.object({
  toolName: z.literal('riksdag_search_speeches').describe('Tool to call for speech text.'),
  args: getArgsSchema.describe('Complete get-mode continuation arguments.'),
});
const textFields = {
  textState: z
    .enum(['included', 'not_requested', 'unavailable', 'failed'])
    .describe('Whether text is included, deferred, unpublished or failed to load.'),
  text: z
    .string()
    .optional()
    .describe('Canonical Markdown body page, preserving Unicode code points.'),
  textOffset: z.number().optional().describe('Applied Unicode code-point offset.'),
  textTotalLength: z
    .number()
    .optional()
    .describe('Complete canonical body length in Unicode code points.'),
  textReturnedLength: z.number().optional().describe('Code points returned in this page.'),
  textHasMore: z.boolean().optional().describe('Whether canonical body text remains.'),
  textRevision: z
    .string()
    .optional()
    .describe('Complete normalized detail record and canonical body revision.'),
  nextTextCall: textCallSchema
    .optional()
    .describe('Complete get call to retrieve deferred or remaining body text.'),
  textFailure: z
    .object({
      code: z.number().describe('Classified transient upstream error code.'),
      reason: z.string().describe('Stable transient failure reason.'),
      recovery: z.string().describe('How to retry this speech detail.'),
    })
    .optional()
    .describe('Explicit transient detail failure; never an empty-body assertion.'),
};
const itemSchema = speechSchema
  .extend(textFields)
  .describe('Speech metadata and explicit text retrieval state.');
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

async function detailPage(
  loaded: Extract<Awaited<ReturnType<typeof loadSpeechDetail>>, { found: true }>,
  offset: number,
  length: number | undefined,
  expectedRevision: string | undefined,
  enrichment: SuccessEnrichment,
  budget: ToolBudget,
  deferredText?: Map<string, { text: string; revision: string }>,
): Promise<Item> {
  const revision = await revisionOf({ ...loaded.record, text: loaded.text });
  assertRevision(expectedRevision, revision);
  budget.check();
  if (loaded.text === undefined || loaded.text.trim() === '')
    return { ...loaded.record, textState: 'unavailable', textRevision: revision };
  const total = codePointLength(loaded.text);
  const build = (text: string, returnedLength: number) => {
    const hasMore = offset + returnedLength < total;
    const item: Item = {
      ...loaded.record,
      textState: 'included' as const,
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
    return {
      mode: 'get' as const,
      found: true,
      speechId: loaded.record.speechId,
      item,
      revision,
    };
  };
  if (deferredText) {
    deferredText.set(loaded.record.speechId, { text: loaded.text, revision });
    return build(sliceCodePoints(loaded.text, offset, 1), 1).item;
  }
  const fitted = fitText({
    text: loaded.text,
    offset,
    ...(length === undefined ? {} : { length }),
    enrichment,
    budget,
    build,
  });
  return fitted.item;
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

/** Searches complete scoped speech candidates or retrieves one speech's canonical body. */
export const riksdagSearchSpeeches = tool('riksdag_search_speeches', {
  title: 'Search and read parliamentary speeches',
  description:
    'Search speeches within a required parliamentary session, optionally by member, party, reply exclusion and heading tokens. Heading matching searches debate headings only, never body text. Search hydrates one text page by default; use get mode with an item speechId to read all remaining text and retain the returned revision for continuation.',
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
      .describe('Search mode: local speech page after heading filtering.'),
    candidateCount: z.number().optional().describe('Complete validated upstream candidate count.'),
    totalCount: z.number().optional().describe('Exact local heading-filtered match count.'),
    returnedCount: z.number().optional().describe('Speech rows returned on this page.'),
    offset: z.number().optional().describe('Applied local row offset.'),
    requestedLimit: z.number().optional().describe('Original requested search page size.'),
    limit: z
      .number()
      .optional()
      .describe('Applied search page size after clamp and response fitting.'),
    textCount: z
      .number()
      .optional()
      .describe('Applied maximum speeches selected for text retrieval.'),
    hasMore: z.boolean().optional().describe('Whether filtered speech rows remain.'),
    truncated: z
      .boolean()
      .optional()
      .describe('Whether response fitting shortened the local row page.'),
    revision: z
      .string()
      .optional()
      .describe('Search candidate-set revision or complete get detail revision.'),
    nextCall: z
      .object({
        toolName: z
          .literal('riksdag_search_speeches')
          .describe('Tool to call for the next local row page.'),
        args: argsSchema.describe('Complete normalized next-page arguments.'),
      })
      .optional()
      .describe('Complete next local search-page call.'),
  }),
  enrichment: successEnrichment,
  enrichmentTrailer: successEnrichmentTrailer,
  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Unknown code, conflicting mode fields or malformed identifier.',
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
      when: 'Detail identity/filter rows contradict required identity.',
      recovery:
        'Check memberId with riksdag_search_members or copy speechId from riksdag_search_speeches search mode, then retry; report repeated mismatches with the request identifier.',
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
      when: 'Network/5xx or HTML error page after retries.',
      recovery:
        'Retry riksdag_search_speeches after the source becomes available; narrow search mode with memberId, party or speechType.',
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
      member = optionalString(input.memberId),
      party = optionalString(input.party);
    const filters = {
      mode: 'search' as const,
      session: normalizeSession(input.session ?? ''),
      ...(heading ? { headingContains: heading } : {}),
      ...(member ? { memberId: normalizeMemberId(member) } : {}),
      ...(party ? { party: normalizeCode(party, 'parties') } : {}),
      speechType: input.speechType ?? 'all',
      offset: input.offset ?? 0,
      limit: Math.min(input.limit ?? 5, 20),
      textCount: Math.min(input.textCount ?? 1, 5),
    };
    const tokens = heading ? normalizeTokens(heading) : [];
    const loaded = await loadSpeechCandidates(service, budget, filters);
    const revision = await revisionOf(loaded.records);
    assertRevision(optionalString(input.revision), revision);
    const rows = loaded.records.filter(
      (row) => !heading || matchesAllTokens(`${row.heading ?? ''} ${row.subheading ?? ''}`, tokens),
    );
    const enrichment: SuccessEnrichment = {
      effectiveQuery: effectiveQuery(filters),
      source: 'Source: The Swedish Parliament',
      retrievedAt: loaded.retrievedAt,
      notices: [
        'headingContains matches heading and subheading tokens locally; speech body text is not searched. The total describes the complete validated source candidate response.',
      ],
    };
    if ((input.limit ?? 5) > 20) enrichment.notices.push('Requested limit was clamped to 20.');
    if ((input.textCount ?? 1) > 5)
      enrichment.notices.push('Requested textCount was clamped to 5.');
    if (!rows.length)
      enrichment.notices.push(
        'No speeches matched these session and heading filters. Remove headingContains to browse the session, check memberId with riksdag_search_members, or check speech types with riksdag_list_reference.',
      );
    const build = (items: Item[], limit: number, truncated: boolean) => {
      const hasMore = filters.offset + items.length < rows.length;
      return {
        mode: 'search' as const,
        items,
        candidateCount: loaded.records.length,
        totalCount: rows.length,
        returnedCount: items.length,
        offset: filters.offset,
        requestedLimit: input.limit ?? 5,
        limit,
        textCount: Math.min(filters.textCount, items.length),
        revision,
        hasMore,
        truncated,
        ...(hasMore
          ? {
              nextCall: {
                toolName: 'riksdag_search_speeches' as const,
                args: { ...filters, offset: filters.offset + items.length, limit, revision },
              },
            }
          : {}),
      };
    };
    const initial = fitRows({
      rows: rows.map(
        (row): Item => ({
          ...row,
          textState: 'not_requested',
          nextTextCall: getCall(row.speechId),
        }),
      ),
      offset: filters.offset,
      limit: filters.limit,
      build,
      enrichment,
      budget,
    });
    const items = initial.items;
    const deferredText = new Map<string, { text: string; revision: string }>();
    for (const [index, item] of items.entries()) {
      if (index >= filters.textCount) break;
      budget.check();
      try {
        const detail = await loadSpeechDetail(service, budget, item.speechId);
        items[index] = detail.found
          ? await detailPage(detail, 0, undefined, undefined, enrichment, budget, deferredText)
          : { ...item, textState: 'unavailable' };
      } catch (error) {
        budget.check();
        if (!transient(error)) throw error;
        items[index] = {
          ...item,
          textState: 'failed',
          textFailure: {
            code: error.code,
            reason:
              typeof error.data?.reason === 'string' ? error.data.reason : 'upstream_unavailable',
            recovery: 'Retry the included get-mode nextTextCall to retrieve this speech body.',
          },
          nextTextCall: getCall(item.speechId),
        };
      }
    }
    const minimum = fitRows({
      rows: items,
      offset: 0,
      limit: initial.limit,
      build: (selected, limit, truncated) => build(selected, limit, initial.truncated || truncated),
      enrichment,
      budget,
    });
    const hydrated = minimum.items.flatMap((item) => {
      const source = deferredText.get(item.speechId);
      return source === undefined ? [] : [{ ...source, item, offset: 0 }];
    });
    const result = fitTextPages({
      sources: hydrated,
      enrichment,
      budget,
      build: (pages) => {
        const textItems = new Map(
          pages.map((page) => {
            const { item, revision } = page.source;
            const hasMore = page.returnedLength < page.totalLength;
            const { nextTextCall: _nextTextCall, ...metadata } = item;
            return [
              item.speechId,
              {
                ...metadata,
                text: page.text,
                textReturnedLength: page.returnedLength,
                textHasMore: hasMore,
                ...(hasMore
                  ? { nextTextCall: getCall(item.speechId, page.returnedLength, revision) }
                  : {}),
              },
            ];
          }),
        );
        return {
          ...minimum,
          items: minimum.items.map((item) => textItems.get(item.speechId) ?? item),
        };
      },
    });
    budget.check();
    ctx.enrich(enrichment);
    return result;
  },
  format: formatExact,
});
