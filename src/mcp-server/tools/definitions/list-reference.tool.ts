/** @file src/mcp-server/tools/definitions/list-reference.tool.ts — Offline official vocabulary and source conventions. */
import { tool, z } from '@cyanheads/mcp-ts-core';
import {
  effectiveQuery,
  formatExact,
  type SuccessEnrichment,
  successEnrichment,
  successEnrichmentTrailer,
} from '../../../services/riksdag/output.js';
import { fitRows } from '../../../services/riksdag/pagination.js';
import {
  REFERENCE_CATALOG_TIMESTAMPS,
  REFERENCE_SOURCES,
  REFERENCE_TABLES,
  REFERENCE_VERIFIED_AT,
} from '../../../services/riksdag/reference-data.js';

const topicSchema = z.enum([
  'document_types',
  'committees',
  'parties',
  'constituencies',
  'speech_types',
  'sessions',
  'identifiers',
  'coverage',
]);
const entrySchema = z
  .object({
    code: z.string().describe('Official filter code, or the documented convention identifier.'),
    labelSv: z
      .string()
      .describe('Swedish source label; explanatory guidance has Swedish topic labels.'),
    labelEn: z
      .string()
      .optional()
      .describe('Available English label published by the source, without invented translation.'),
    explanation: z
      .string()
      .describe('Published description or explicit server guidance for this convention.'),
    subtype: z
      .string()
      .optional()
      .describe(
        'Document subtype, distinct from the parent document-type code; empty means parent row.',
      ),
    sourceType: z.string().optional().describe('Original typ value in the document catalog.'),
    pluralLabelSv: z.string().optional().describe('Published Swedish plural label.'),
    family: z.string().optional().describe('Published document family.'),
    group: z.string().optional().describe('Published catalog group.'),
    seriesCode: z.string().optional().describe('Published series code, preserving leading zeros.'),
    sortOrder: z.string().optional().describe('Published catalog sort value.'),
    sessionId: z
      .string()
      .optional()
      .describe('Source session identifier, distinct from the public session string.'),
    start: z
      .string()
      .optional()
      .describe('Published session start with original date/time precision.'),
    end: z.string().optional().describe('Published session end with original date/time precision.'),
    term: z.string().optional().describe('Published parliamentary term.'),
  })
  .describe('One official vocabulary entry or documented source convention.');

/** Browse complete dated official vocabulary tables without any upstream exchange. */
export const listReference = tool('riksdag_list_reference', {
  description:
    'Look up official document types, committees, parties, constituencies, speech reply filters, sessions, identifier conventions and source coverage. The offline snapshot is dated; follow nextCall to read every entry. Document subtypes remain distinct from parent document-type codes, and the session catalog can lag current sessions.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    topic: topicSchema.describe('Vocabulary or guidance topic to browse.'),
    offset: z.number().int().min(0).default(0).describe('Zero-based local entry offset.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .default(20)
      .describe('Requested entries; values above 100 are clamped with a notice.'),
  }),
  output: z.object({
    topic: topicSchema.describe('Selected reference topic.'),
    entries: z
      .array(entrySchema)
      .describe(
        'Complete entries on this page, retaining Swedish source labels and distinct subtypes.',
      ),
    referenceSourceUrl: z.string().describe('Official source URL for this topic.'),
    referenceVerifiedAt: z.string().describe('Snapshot verification date.'),
    referenceCatalogTimestamp: z
      .string()
      .optional()
      .describe('Original catalog generation timestamp without an inferred timezone.'),
    offset: z.number().int().describe('Applied zero-based local offset.'),
    limit: z
      .number()
      .int()
      .describe('Applied maximum page length after clamping and whole-entry fitting.'),
    requestedLimit: z.number().int().describe('Caller-requested page length before clamping.'),
    returnedCount: z.number().int().describe('Actual entries on this page.'),
    totalCount: z.number().int().describe('Exact number of bundled entries for this topic.'),
    hasMore: z.boolean().describe('Whether further bundled entries remain.'),
    truncated: z.boolean().describe('Whether response fitting shortened this page.'),
    nextCall: z
      .object({
        toolName: z.literal('riksdag_list_reference').describe('Tool to retrieve the next page.'),
        args: z
          .object({
            topic: topicSchema.describe('Same reference topic.'),
            offset: z.number().int().describe('Next unread entry offset.'),
            limit: z.number().int().describe('Applied maximum page length.'),
          })
          .describe('Complete arguments for the next reference page.'),
      })
      .optional()
      .describe('Continuation covering every remaining entry.'),
  }),
  enrichment: successEnrichment,
  enrichmentTrailer: successEnrichmentTrailer,
  handler(input, ctx) {
    ctx.signal.throwIfAborted();
    const limit = Math.min(input.limit, 100);
    const notices: string[] = [];
    if (limit !== input.limit) notices.push(`Requested limit ${input.limit} was clamped to 100.`);
    if (input.topic === 'sessions')
      notices.push(
        'The published session snapshot may lag current sessions; syntactically valid future sessions are accepted.',
      );
    const enrichment: SuccessEnrichment = {
      effectiveQuery: effectiveQuery({
        topic: input.topic,
        offset: input.offset,
        requestedLimit: input.limit,
        limit,
        filtering: 'offline dated vocabulary',
      }),
      source: 'Source: The Swedish Parliament',
      retrievedAt: REFERENCE_VERIFIED_AT,
      notices,
    };
    const rows = [...REFERENCE_TABLES[input.topic]].sort((a, b) =>
      a.code < b.code
        ? -1
        : a.code > b.code
          ? 1
          : (a.subtype ?? '') < (b.subtype ?? '')
            ? -1
            : (a.subtype ?? '') > (b.subtype ?? '')
              ? 1
              : 0,
    );
    const result = fitRows({
      rows,
      offset: input.offset,
      limit,
      enrichment,
      build: (entries, appliedLimit, truncated) => {
        const nextOffset = input.offset + entries.length;
        const hasMore = nextOffset < rows.length;
        const referenceCatalogTimestamp = Object.hasOwn(REFERENCE_CATALOG_TIMESTAMPS, input.topic)
          ? REFERENCE_CATALOG_TIMESTAMPS[input.topic as keyof typeof REFERENCE_CATALOG_TIMESTAMPS]
          : undefined;
        return {
          topic: input.topic,
          entries,
          referenceSourceUrl: REFERENCE_SOURCES[input.topic],
          referenceVerifiedAt: REFERENCE_VERIFIED_AT,
          ...(referenceCatalogTimestamp === undefined ? {} : { referenceCatalogTimestamp }),
          offset: input.offset,
          limit: appliedLimit,
          requestedLimit: input.limit,
          returnedCount: entries.length,
          totalCount: rows.length,
          hasMore,
          truncated,
          ...(hasMore
            ? {
                nextCall: {
                  toolName: 'riksdag_list_reference' as const,
                  args: { topic: input.topic, offset: nextOffset, limit },
                },
              }
            : {}),
        };
      },
    });
    ctx.signal.throwIfAborted();
    ctx.enrich(enrichment);
    return result;
  },
  format: formatExact,
});
