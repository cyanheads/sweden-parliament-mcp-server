/** @fileoverview Remote parliamentary document search with complete page traversal. @module mcp-server/tools/definitions/search-documents.tool */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  type DocumentSearchFilters,
  documentMetadataSchema,
  searchDocuments,
} from '../../../services/riksdag/documents.js';
import {
  formatString,
  normalizeCode,
  normalizeDateRange,
  normalizeMemberId,
  normalizeSession,
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
  query: z
    .string()
    .optional()
    .describe('Source full-text query; narrow slow searches with session or type.'),
  documentType: z
    .string()
    .optional()
    .describe('Document type code or exact reference label, including sfs.'),
  session: formatString('session', { blank: true })
    .optional()
    .describe('Parliamentary session; omit to search all sessions.'),
  committee: z
    .string()
    .optional()
    .describe(
      'Committee code or exact reference label; a code typed without its Swedish letter resolves (fou is FöU).',
    ),
  party: z.string().optional().describe('Party code or exact reference label.'),
  memberId: formatString('memberId', { blank: true })
    .optional()
    .describe('Numeric member IID from riksdag_search_members, keeping leading zeros.'),
  sort: z
    .enum(['relevance', 'date'])
    .optional()
    .describe('Source order: relevance for a nonblank query, else descending date.'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('In-page row offset; follow nextCall, keeping the remote page size.'),
  revision: z
    .string()
    .optional()
    .describe('Remote-page revision from nextCall; a changed page is rejected.'),
  dateFrom: formatString('date', { blank: true, field: 'dateFrom' })
    .optional()
    .describe('Inclusive start date, YYYY-MM-DD.'),
  dateTo: formatString('date', { blank: true, field: 'dateTo' })
    .optional()
    .describe('Inclusive end date, YYYY-MM-DD.'),
  page: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe('Remote page number, starting at 1; the source serves the first 10,000 rows.'),
  pageSize: z
    .number()
    .int()
    .min(1)
    .default(10)
    .describe('Remote page size; clamped to a maximum of 200.'),
});
/** Search source-ranked remote pages with revision-checked continuation. */
export const riksdagSearchDocuments = tool('riksdag_search_documents', {
  title: 'Search parliamentary documents',
  description:
    'Search Swedish parliamentary documents and consolidated SFS statutes by words, type, session, committee, party, member IID or dates, ordered by relevance or descending date. Follow nextCall for further pages; read status and text with riksdag_get_document.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: argsSchema,
  output: z.object({
    items: z
      .array(documentMetadataSchema)
      .describe(
        "Whole records of this page's source hits, each once; member-profile, web-page and empty-ID calendar rows are skipped.",
      ),
    page: z.number().describe('Applied page number, counted in pages of pageSize source hits.'),
    pageSize: z.number().describe('Applied page size in source hits.'),
    returnedCount: z.number().describe('Rows returned.'),
    offset: z.number().describe('Applied in-page row offset.'),
    remoteReturnedCount: z
      .number()
      .describe('Records on this page before the in-page offset, after skipped and merged rows.'),
    revision: z.string().describe('Hash of the complete remote page.'),
    totalCount: z.number().optional().describe('Authoritative source hit count, when published.'),
    hasMore: z.boolean().describe('Whether local rows or another remote page remain.'),
    nextCall: toolCallSchema('riksdag_search_documents')
      .optional()
      .describe('Next-page call with unchanged filters and page size.'),
  }),
  enrichment: successEnrichment,
  enrichmentTrailer: successEnrichmentTrailer,
  errors: [
    {
      reason: 'revision_changed',
      code: JsonRpcErrorCode.Conflict,
      when: 'The remote page changed between calls.',
      recovery:
        'Restart this page at offset zero without revision to read one consistent remote page.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Unknown code, nonconsecutive session, impossible date or reversed date range.',
      recovery:
        'Use riksdag_list_reference to check codes and identifier formats, then retry the same tool with corrected filters.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_identity_mismatch',
      code: JsonRpcErrorCode.SerializationError,
      when: 'Source rows contradict the filter identities.',
      recovery:
        'Check document type, session and committee with riksdag_list_reference and retry riksdag_search_documents; report repeated mismatches with the request identifier.',
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
        'Retry riksdag_search_documents after the source becomes available; add session or documentType to narrow a slow query.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_queue_full',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Upstream queue is full.',
      recovery: 'Wait before retrying the same tool, and request fewer simultaneous searches.',
      thrownBy: 'service',
    },
  ],
  async handler(input, ctx) {
    using budget = createToolBudget(ctx.signal);
    const query = optionalString(input.query),
      dt = optionalString(input.documentType),
      session = optionalString(input.session),
      committee = optionalString(input.committee),
      party = optionalString(input.party);
    const memberId = optionalString(input.memberId);
    const filters: DocumentSearchFilters = {
      ...(query ? { query } : {}),
      ...(dt ? { documentType: normalizeCode(dt, 'document_types', 'documentType') } : {}),
      ...(session ? { session: normalizeSession(session) } : {}),
      ...(committee ? { committee: normalizeCode(committee, 'committees', 'committee') } : {}),
      ...(party ? { party: normalizeCode(party, 'parties', 'party') } : {}),
      ...(memberId ? { memberId: normalizeMemberId(memberId) } : {}),
      sort: input.sort ?? (query ? 'relevance' : 'date'),
      ...normalizeDateRange(input.dateFrom, input.dateTo),
      page: input.page,
      pageSize: Math.min(input.pageSize, 200),
    };
    const result = await searchDocuments(getRiksdagService(), filters, budget);
    const {
      retrievedAt,
      upstreamQuery,
      upstreamWarnings,
      skippedMemberRows,
      skippedWebPageRows,
      skippedCalendarRows,
      occurrenceRows,
      mergedRows,
      rowWindow,
      ...domain
    } = result;
    const revision = await revisionOf(domain);
    assertRevision(optionalString(input.revision), revision);
    const enrichment: SuccessEnrichment = {
      effectiveQuery: effectiveQuery({ ...filters, offset: input.offset, revision }),
      source: 'Source: The Swedish Parliament',
      retrievedAt,
      notices: [],
      ...(upstreamQuery ? { upstreamQuery } : {}),
      ...(upstreamWarnings ? { upstreamWarnings } : {}),
    };
    if (input.pageSize > 200) enrichment.notices.push('Requested pageSize was clamped to 200.');
    if (skippedMemberRows > 0)
      enrichment.notices.push(
        `Skipped ${skippedMemberRows} member-profile ${skippedMemberRows === 1 ? 'row' : 'rows'} the source returned among these documents; offset indexes documents only, and totalCount still counts the skipped rows. Find members with riksdag_search_members.`,
      );
    if (skippedWebPageRows > 0)
      enrichment.notices.push(
        `Skipped ${skippedWebPageRows} web-page ${skippedWebPageRows === 1 ? 'row' : 'rows'} the source returned among these documents; offset indexes documents only, and totalCount still counts the skipped rows.`,
      );
    if (skippedCalendarRows > 0)
      enrichment.notices.push(
        `Skipped ${skippedCalendarRows} calendar ${skippedCalendarRows === 1 ? 'row' : 'rows'} with no record ID (such as cancelled entries) the source returned among these documents; offset indexes documents only, and totalCount still counts the skipped rows.`,
      );
    if (occurrenceRows > 0)
      enrichment.notices.push(
        `Listed ${occurrenceRows} calendar ${occurrenceRows === 1 ? 'row' : 'rows'} for single event occurrences (IDs ending in -u and a number) under their event's record ID, which riksdag_get_document reads; each record keeps the date of its first listed row.`,
      );
    if (mergedRows > 0)
      enrichment.notices.push(
        `Merged ${mergedRows} repeated ${mergedRows === 1 ? 'row' : 'rows'} into the records they repeat: the source lists a recurring event once per occurrence date and some records again as calendar entries. Each record appears once, at its first position, and offset indexes the records returned.`,
      );
    if (rowWindow === 'past')
      enrichment.notices.push(
        'This page starts after row 10,000, the last row the source serves for one search, so no request was made. Page 1 shows how many rows match; when more than 10,000 do, narrow with session, documentType or dateFrom and dateTo.',
      );
    if (rowWindow === 'end')
      enrichment.notices.push(
        'This page ends at row 10,000, the last row the source serves for one search, and more rows match. Narrow with session, documentType or dateFrom and dateTo to reach them, then start again at page 1.',
      );
    if (
      domain.returnedCount === 0 &&
      skippedMemberRows + skippedWebPageRows + skippedCalendarRows === 0 &&
      rowWindow !== 'past'
    )
      enrichment.notices.push(
        input.page > 1
          ? 'No documents were returned on this page. Retry page: 1 with unchanged filters.'
          : 'No documents matched the applied filters. Use riksdag_list_reference with topic document_types or sessions, then retry riksdag_search_documents with fewer filters.',
      );
    if (input.offset > domain.items.length)
      enrichment.notices.push(
        'The in-page offset is beyond the available rows; this is an empty terminal page.',
      );
    const items = domain.items.slice(input.offset);
    const hasMore = input.offset <= domain.items.length && domain.hasMore;
    budget.check();
    ctx.enrich(enrichment);
    return {
      ...domain,
      items,
      returnedCount: items.length,
      remoteReturnedCount: domain.items.length,
      offset: input.offset,
      revision,
      hasMore,
      ...(hasMore
        ? {
            nextCall: {
              toolName: 'riksdag_search_documents' as const,
              args: { ...filters, page: filters.page + 1, offset: 0 },
            },
          }
        : {}),
    };
  },
  format: formatExact,
});
