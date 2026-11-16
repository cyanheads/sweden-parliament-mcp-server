/** @fileoverview Offline official vocabulary and source conventions. @module mcp-server/tools/definitions/list-reference.tool */
import { tool, z } from '@cyanheads/mcp-ts-core';
import {
  effectiveQuery,
  formatExact,
  type SuccessEnrichment,
  successEnrichment,
  successEnrichmentTrailer,
  toolCallSchema,
} from '../../../services/riksdag/output.js';
import {
  REFERENCE_CATALOG_TIMESTAMPS,
  REFERENCE_SOURCES,
  REFERENCE_TABLES,
  REFERENCE_VERIFIED_AT,
  type ReferenceTopic,
} from '../../../services/riksdag/reference-data.js';

const catalogTimestamps: Partial<Record<ReferenceTopic, string>> = REFERENCE_CATALOG_TIMESTAMPS;
/** Orders by UTF-16 code units, not locale collation. */
const compareCodeUnits = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

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
    code: z.string().describe('Official filter code or convention identifier.'),
    labelSv: z.string().describe('Swedish source label; guidance rows carry Swedish topic labels.'),
    labelEn: z
      .string()
      .optional()
      .describe('English label as published by the source, never translated here.'),
    explanation: z.string().describe('Published description or server guidance.'),
    subtype: z
      .string()
      .optional()
      .describe('Document subtype, distinct from the parent type code; empty means parent row.'),
    sourceType: z.string().optional().describe('Original typ value in the document catalog.'),
    pluralLabelSv: z.string().optional().describe('Published Swedish plural label.'),
    family: z.string().optional().describe('Published document family.'),
    group: z.string().optional().describe('Published catalog group.'),
    seriesCode: z.string().optional().describe('Published series code, preserving leading zeros.'),
    sortOrder: z.string().optional().describe('Published catalog sort value.'),
    sessionId: z
      .string()
      .optional()
      .describe('Source session identifier, not the public session string.'),
    start: z.string().optional().describe('Published session start, original precision.'),
    end: z.string().optional().describe('Published session end, original precision.'),
    term: z.string().optional().describe('Published parliamentary term.'),
  })
  .describe('One vocabulary entry or source convention.');

/** Browse complete dated official vocabulary tables without any upstream exchange. */
export const listReference = tool('riksdag_list_reference', {
  description:
    'Look up official document types, committees, parties, constituencies, speech reply filters, sessions, identifier conventions and source coverage from a dated offline snapshot; follow nextCall to read every entry. Document subtypes stay distinct from parent type codes, and the session catalog can lag current sessions.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    topic: topicSchema.describe('Vocabulary or guidance topic to browse.'),
    offset: z.number().int().min(0).default(0).describe('Zero-based local entry offset.'),
    limit: z
      .number()
      .int()
      .min(1)
      .default(20)
      .describe('Requested entries; values above 100 are clamped with a notice.'),
  }),
  output: z.object({
    topic: topicSchema.describe('Selected reference topic.'),
    entries: z
      .array(entrySchema)
      .describe('Whole entries on this page, with Swedish labels and distinct subtypes.'),
    referenceSourceUrl: z.string().describe('Official source URL for this topic.'),
    referenceVerifiedAt: z.string().describe('Snapshot verification date.'),
    referenceCatalogTimestamp: z
      .string()
      .optional()
      .describe('Original catalog timestamp, no inferred timezone.'),
    offset: z.number().int().describe('Applied zero-based local offset.'),
    limit: z.number().int().describe('Applied page length after clamping.'),
    requestedLimit: z.number().int().describe('Requested page length before clamping.'),
    returnedCount: z.number().int().describe('Entries on this page.'),
    totalCount: z.number().int().describe('Exact bundled entry count for this topic.'),
    hasMore: z.boolean().describe('Whether further bundled entries remain.'),
    nextCall: toolCallSchema('riksdag_list_reference')
      .optional()
      .describe('Continuation for the remaining entries.'),
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
    const rows = REFERENCE_TABLES[input.topic].toSorted(
      (a, b) =>
        compareCodeUnits(a.code, b.code) || compareCodeUnits(a.subtype ?? '', b.subtype ?? ''),
    );
    const referenceCatalogTimestamp = catalogTimestamps[input.topic];
    const entries = rows.slice(input.offset, input.offset + limit);
    const nextOffset = input.offset + entries.length;
    const hasMore = nextOffset < rows.length;
    ctx.signal.throwIfAborted();
    ctx.enrich(enrichment);
    return {
      topic: input.topic,
      entries,
      referenceSourceUrl: REFERENCE_SOURCES[input.topic],
      referenceVerifiedAt: REFERENCE_VERIFIED_AT,
      ...(referenceCatalogTimestamp === undefined ? {} : { referenceCatalogTimestamp }),
      offset: input.offset,
      limit,
      requestedLimit: input.limit,
      returnedCount: entries.length,
      totalCount: rows.length,
      hasMore,
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
  format: formatExact,
});
