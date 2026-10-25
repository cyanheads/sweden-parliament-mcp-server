/** @fileoverview Remote parliamentary document search with complete page traversal. @module mcp-server/tools/definitions/search-documents.tool */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  type DocumentSearchFilters,
  documentMetadataSchema,
  searchDocuments,
} from '../../../services/riksdag/documents.js';
import {
  normalizeCode,
  normalizeDateRange,
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
import { getRiksdagService } from '../../../services/riksdag/riksdag-service.js';
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
  session: z
    .string()
    .optional()
    .describe('Parliamentary session; omission searches all available sessions.'),
  committee: z.string().optional().describe('Committee code or exact reference label.'),
  party: z.string().optional().describe('Party code or exact reference label.'),
  dateFrom: z.string().optional().describe('Inclusive earliest ISO calendar date, YYYY-MM-DD.'),
  dateTo: z.string().optional().describe('Inclusive latest ISO calendar date, YYYY-MM-DD.'),
  page: z.number().int().min(1).default(1).describe('Remote page number, starting at 1.'),
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(10000)
    .default(10)
    .describe('Requested remote page size; maximum applied size 50.'),
});
/** Search a source-ranked remote document page without local reranking or page shortening. */
export const riksdagSearchDocuments = tool('riksdag_search_documents', {
  title: 'Search parliamentary documents',
  description:
    'Search Swedish parliamentary documents and consolidated SFS statutes by words, document type, session, committee, party or dates. Read document status and text with riksdag_get_document.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: argsSchema,
  output: z.object({
    items: z.array(documentMetadataSchema).describe('All records in the fetched remote page.'),
    page: z.number().describe('Applied remote page.'),
    pageSize: z.number().describe('Applied remote page size.'),
    returnedCount: z.number().describe('Actual rows returned.'),
    totalCount: z.number().optional().describe('Authoritative source hit count, when published.'),
    hasMore: z.boolean().describe('Whether another remote page is indicated.'),
    nextCall: z
      .object({
        toolName: z.literal('riksdag_search_documents').describe('Tool to call next.'),
        args: argsSchema.describe('Complete normalized next-page arguments.'),
      })
      .optional()
      .describe('Complete next-page call with unchanged filters and page size.'),
  }),
  enrichment: successEnrichment,
  enrichmentTrailer: successEnrichmentTrailer,
  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Unknown code or malformed date or session.',
      recovery:
        'Use riksdag_list_reference to check codes and identifier formats, then retry the same tool with corrected filters.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_identity_mismatch',
      code: JsonRpcErrorCode.SerializationError,
      when: 'Source rows contradict required filter identities.',
      recovery:
        'Retry the same tool with an identifier copied from riksdag_search_documents, riksdag_search_speeches or riksdag_search_members; report repeated mismatches.',
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
      when: 'The source remains unavailable after retries.',
      recovery:
        'Retry the same tool later; narrow riksdag_search_documents or riksdag_search_speeches with session filters.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_queue_full',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The process upstream queue is full.',
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
    const filters: DocumentSearchFilters = {
      ...(query ? { query } : {}),
      ...(dt ? { documentType: normalizeCode(dt, 'document_types') } : {}),
      ...(session ? { session: normalizeSession(session) } : {}),
      ...(committee ? { committee: normalizeCode(committee, 'committees') } : {}),
      ...(party ? { party: normalizeCode(party, 'parties') } : {}),
      ...normalizeDateRange(input.dateFrom, input.dateTo),
      page: input.page,
      pageSize: Math.min(input.pageSize, 50),
    };
    const result = await searchDocuments(getRiksdagService(), filters, budget);
    const { retrievedAt, upstreamQuery, upstreamWarnings, ...domain } = result;
    const enrichment: SuccessEnrichment = {
      effectiveQuery: effectiveQuery(filters),
      source: 'Source: The Swedish Parliament',
      retrievedAt,
      notices: [],
      ...(upstreamQuery ? { upstreamQuery } : {}),
      ...(upstreamWarnings ? { upstreamWarnings } : {}),
    };
    if (input.pageSize > 50) enrichment.notices.push('Requested pageSize was clamped to 50.');
    if (domain.returnedCount === 0)
      enrichment.notices.push(
        input.page > 1
          ? 'No documents were returned on this page. Retry page: 1 with unchanged filters.'
          : 'No documents matched the applied filters. Use riksdag_list_reference with topic document_types or sessions, then retry riksdag_search_documents with fewer filters.',
      );
    const output = {
      ...domain,
      ...(domain.hasMore
        ? {
            nextCall: {
              toolName: 'riksdag_search_documents' as const,
              args: { ...filters, page: filters.page + 1 },
            },
          }
        : {}),
    };
    if (measureResponse(output, enrichment) > 24576)
      enrichment.notices.push(
        'This remote page exceeds the response target and is returned intact. Restart at page 1 with a smaller pageSize.',
      );
    budget.check();
    ctx.enrich(enrichment);
    return output;
  },
  format: formatExact,
});
