/** @fileoverview Complete document sections and lossless text continuation. @module mcp-server/tools/definitions/get-document.tool */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  documentActivitySchema,
  documentAttachmentSchema,
  documentDecisionSchema,
  documentMetadataSchema,
  documentPropertySchema,
  documentReferenceSchema,
  documentReservationSchema,
  loadDocumentStatus,
} from '../../../services/riksdag/documents.js';
import { normalizeDocumentId, optionalString } from '../../../services/riksdag/normalize.js';
import {
  effectiveQuery,
  formatExact,
  measureResponse,
  type SuccessEnrichment,
  successEnrichment,
  successEnrichmentTrailer,
} from '../../../services/riksdag/output.js';
import { fitRows, fitText } from '../../../services/riksdag/pagination.js';
import { getRiksdagService } from '../../../services/riksdag/riksdag-service.js';
import { assertRevision, codePointLength } from '../../../services/riksdag/text.js';
import { createToolBudget } from '../../../services/riksdag/transport.js';

const sectionKeys = [
  'metadata',
  'decisions',
  'reservations',
  'activities',
  'properties',
  'attachments',
  'references',
  'text',
  'source_html',
] as const;
const sectionSchema = z.enum(sectionKeys);
const arrayKeys = [
  'decisions',
  'reservations',
  'activities',
  'properties',
  'attachments',
  'references',
] as const;
const inputSchema = z.object({
  documentId: z
    .string()
    .min(1)
    .describe('Canonical document ID or unambiguous SFS YYYY:N identifier.'),
  sections: z
    .array(z.string())
    .optional()
    .describe(
      'Select metadata, decisions, reservations, activities, properties, attachments, references, text or source_html. Omit for metadata, complete outline and first text page.',
    ),
  textOffset: z.number().int().min(0).default(0).describe('Text offset in Unicode code points.'),
  textLength: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Explicit text length in code points; default 1000 and honored when supplied.'),
  htmlOffset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Source HTML offset in Unicode code points.'),
  htmlLength: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Explicit source HTML length in code points; default 1000.'),
  sectionOffset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Offset applied independently to each selected array section.'),
  sectionLimit: z
    .number()
    .int()
    .min(1)
    .max(10000)
    .default(20)
    .describe('Requested entries per selected array section; applied maximum 100.'),
  revision: z
    .string()
    .optional()
    .describe('Revision returned by a previous call; rejects changed records.'),
});
const nextCallSchema = z
  .object({
    toolName: z.literal('riksdag_get_document').describe('Tool to call next.'),
    args: inputSchema.describe('Complete normalized continuation arguments.'),
  })
  .describe('Complete document continuation call.');
const outputSchema = z.object({
  found: z.boolean().describe('Whether the source record exists.'),
  documentId: z.string().describe('Normalized document identifier.'),
  truncated: z
    .boolean()
    .optional()
    .describe(
      'At least one selected array section has more entries or a response-fitted page; follow its sectionPages continuation.',
    ),
  guidance: z.string().optional().describe('How to resolve a missing identifier.'),
  revision: z.string().optional().describe('Hash of the complete normalized record.'),
  outline: z
    .array(
      z
        .object({
          section: sectionSchema.describe('Selectable section key.'),
          available: z.boolean().describe('Whether the source publishes this section.'),
          itemCount: z.number().optional().describe('Complete section entry count.'),
          textLength: z
            .number()
            .optional()
            .describe('Complete text length in Unicode code points.'),
        })
        .describe('One section and its complete available size.'),
    )
    .optional()
    .describe('Every selectable section and its complete size.'),
  metadata: documentMetadataSchema.optional().describe('Source publication metadata and links.'),
  decisions: z
    .array(documentDecisionSchema)
    .optional()
    .describe('Selected page of authoritative report points.'),
  reservations: z
    .array(documentReservationSchema)
    .optional()
    .describe('Selected reservation page.'),
  activities: z.array(documentActivitySchema).optional().describe('Selected process-event page.'),
  properties: z.array(documentPropertySchema).optional().describe('Selected property page.'),
  attachments: z
    .array(documentAttachmentSchema)
    .optional()
    .describe('Selected linked-attachment page.'),
  references: z.array(documentReferenceSchema).optional().describe('Selected relationship page.'),
  sectionPages: z
    .array(
      z
        .object({
          section: z.enum(arrayKeys).describe('Selected array section.'),
          totalCount: z.number().describe('Complete entry count in this section.'),
          offset: z.number().describe('Applied entry offset.'),
          limit: z.number().describe('Applied page limit after response fitting.'),
          requestedLimit: z.number().describe('Original requested section limit.'),
          truncated: z.boolean().describe('Whether response fitting shortened this section page.'),
          returnedCount: z.number().describe('Actual returned section entries.'),
          hasMore: z.boolean().describe('Whether entries remain after this section page.'),
          nextCall: nextCallSchema
            .optional()
            .describe('Complete continuation for this section only.'),
        })
        .describe('Independent pagination for one selected section.'),
    )
    .optional()
    .describe('Independent counts and complete continuation for every selected array.'),
  textAvailable: z.boolean().optional().describe('Whether a published canonical body exists.'),
  textRepresentation: z
    .enum(['source_text', 'markdown'])
    .optional()
    .describe('Source SFS text or canonical converted Markdown.'),
  text: z.string().optional().describe('Selected canonical text page, unchanged on both surfaces.'),
  textOffset: z.number().optional().describe('Returned text offset in Unicode code points.'),
  textTotalLength: z.number().optional().describe('Complete canonical text length in code points.'),
  textReturnedLength: z.number().optional().describe('Actual returned text code points.'),
  textHasMore: z.boolean().optional().describe('Whether canonical text remains.'),
  nextTextCall: nextCallSchema.optional().describe('Complete continuation for canonical text.'),
  sourceHtml: z.string().optional().describe('Separately selected original source HTML page.'),
  htmlOffset: z.number().optional().describe('Returned HTML offset in code points.'),
  htmlTotalLength: z.number().optional().describe('Complete HTML code-point length.'),
  htmlReturnedLength: z.number().optional().describe('Returned HTML code points.'),
  htmlHasMore: z.boolean().optional().describe('Whether source HTML remains.'),
  nextHtmlCall: nextCallSchema.optional().describe('Complete continuation for source HTML.'),
});

/** Retrieve complete source sections and individually traversable text representations. */
export const riksdagGetDocument = tool('riksdag_get_document', {
  title: 'Read parliamentary document',
  description:
    'Read a document status, decisions, linked records and text. Select sections and follow complete continuation calls to read long reports or consolidated SFS statutes. SFS text is consolidated published text, not a point-in-time legal version.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: inputSchema,
  output: outputSchema,
  enrichment: successEnrichment,
  enrichmentTrailer: successEnrichmentTrailer,
  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A malformed document identifier is supplied.',
      recovery:
        'Use riksdag_list_reference to check codes and identifier formats, then retry the same tool with corrected filters.',
      thrownBy: 'service',
    },
    {
      reason: 'revision_changed',
      code: JsonRpcErrorCode.Conflict,
      when: 'The source record changed between continuation calls.',
      recovery:
        'Restart the same tool without revision and begin at the first page to read one consistent record.',
      thrownBy: 'service',
    },
    {
      reason: 'unknown_section',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A selected document section is unrecognized.',
      recovery:
        'Call riksdag_get_document without sections to read the outline, then select a listed section.',
    },
    {
      reason: 'upstream_identity_mismatch',
      code: JsonRpcErrorCode.SerializationError,
      when: 'The status response contradicts the requested document ID.',
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
    const documentId = normalizeDocumentId(input.documentId);
    const selected = input.sections ?? ['metadata', 'text'];
    for (const key of selected)
      if (!sectionSchema.safeParse(key).success)
        throw ctx.fail('unknown_section', `Unknown document section: ${key}`);
    const args = {
      ...input,
      documentId,
      sectionLimit: Math.min(input.sectionLimit, 100),
      ...(optionalString(input.revision) ? { revision: optionalString(input.revision) } : {}),
    };
    const loaded = await loadDocumentStatus(getRiksdagService(), documentId, budget);
    const enrichment: SuccessEnrichment = {
      effectiveQuery: effectiveQuery({ ...args, sections: selected }),
      source: 'Source: The Swedish Parliament',
      retrievedAt: loaded.retrievedAt,
      notices: [],
    };
    if (input.sectionLimit > 100)
      enrichment.notices.push('Requested sectionLimit was clamped to 100.');
    if (!loaded.found) {
      ctx.enrich(enrichment);
      return {
        found: false,
        documentId,
        guidance:
          'Use riksdag_search_documents to find the document ID, or riksdag_list_reference with topic identifiers to check its format.',
      };
    }
    const record = loaded.record;
    assertRevision(optionalString(input.revision), record.revision);
    const continuationArgs = { ...args, revision: record.revision };
    const output: z.infer<typeof outputSchema> = {
      found: true,
      documentId,
      truncated: false,
      revision: record.revision,
      outline: sectionKeys.map((section) =>
        section === 'metadata'
          ? { section, available: true, itemCount: 1 }
          : section === 'text'
            ? {
                section,
                available: record.text !== undefined,
                ...(record.text === undefined ? {} : { textLength: codePointLength(record.text) }),
              }
            : section === 'source_html'
              ? {
                  section,
                  available: record.sourceHtml !== undefined,
                  ...(record.sourceHtml === undefined
                    ? {}
                    : { textLength: codePointLength(record.sourceHtml) }),
                }
              : {
                  section,
                  available: record[section].length > 0,
                  itemCount: record[section].length,
                },
      ),
      textAvailable: record.text !== undefined,
    };
    if (selected.includes('metadata')) output.metadata = record.metadata;
    if (record.metadata.versionKind === 'consolidated')
      enrichment.notices.push(
        'Consolidated published text; not an as-enacted or point-in-time legal version.',
      );
    output.sectionPages = [];
    for (const section of arrayKeys) {
      if (!selected.includes(section)) continue;
      const rows = record[section];
      const page = fitRows<(typeof rows)[number], z.infer<typeof outputSchema>>({
        rows,
        offset: args.sectionOffset,
        limit: args.sectionLimit,
        enrichment,
        budget,
        build: (entries, appliedLimit, truncated) => {
          const hasMore = args.sectionOffset + entries.length < rows.length;
          const pagination = {
            section,
            totalCount: rows.length,
            offset: args.sectionOffset,
            limit: appliedLimit,
            requestedLimit: input.sectionLimit,
            truncated,
            returnedCount: entries.length,
            hasMore,
            ...(hasMore
              ? {
                  nextCall: {
                    toolName: 'riksdag_get_document' as const,
                    args: {
                      ...continuationArgs,
                      sections: [section],
                      sectionOffset: args.sectionOffset + entries.length,
                    },
                  },
                }
              : {}),
          };
          return {
            ...output,
            [section]: entries,
            sectionPages: [...(output.sectionPages ?? []), pagination],
          };
        },
      });
      Object.assign(output, page);
      if (args.sectionOffset > rows.length)
        enrichment.notices.push(`Section ${section} offset is beyond its available entries.`);
    }
    output.truncated = output.sectionPages.some((page) => page.hasMore || page.truncated);
    if (selected.includes('text')) {
      output.textRepresentation = record.textRepresentation;
      if (record.text !== undefined) {
        const text = record.text;
        Object.assign(
          output,
          fitText({
            text,
            offset: input.textOffset,
            ...(input.textLength === undefined ? {} : { length: input.textLength }),
            enrichment,
            budget,
            build: (page, returnedLength) => {
              const textHasMore = input.textOffset + returnedLength < codePointLength(text);
              return {
                ...output,
                text: page,
                textOffset: input.textOffset,
                textTotalLength: codePointLength(text),
                textReturnedLength: returnedLength,
                textHasMore,
                ...(textHasMore
                  ? {
                      nextTextCall: {
                        toolName: 'riksdag_get_document' as const,
                        args: {
                          ...continuationArgs,
                          sections: ['text'],
                          textOffset: input.textOffset + returnedLength,
                        },
                      },
                    }
                  : {}),
              };
            },
          }),
        );
        if (input.textOffset > codePointLength(text))
          enrichment.notices.push(
            'Text offset is beyond the published body; this is an empty terminal page.',
          );
      }
    }
    if (selected.includes('source_html') && record.sourceHtml !== undefined) {
      const html = record.sourceHtml;
      Object.assign(
        output,
        fitText({
          text: html,
          offset: input.htmlOffset,
          ...(input.htmlLength === undefined ? {} : { length: input.htmlLength }),
          enrichment,
          budget,
          build: (page, returnedLength) => {
            const htmlHasMore = input.htmlOffset + returnedLength < codePointLength(html);
            return {
              ...output,
              sourceHtml: page,
              htmlOffset: input.htmlOffset,
              htmlTotalLength: codePointLength(html),
              htmlReturnedLength: returnedLength,
              htmlHasMore,
              ...(htmlHasMore
                ? {
                    nextHtmlCall: {
                      toolName: 'riksdag_get_document' as const,
                      args: {
                        ...continuationArgs,
                        sections: ['source_html'],
                        htmlOffset: input.htmlOffset + returnedLength,
                      },
                    },
                  }
                : {}),
            };
          },
        }),
      );
      if (input.htmlOffset > codePointLength(html))
        enrichment.notices.push(
          'HTML offset is beyond the published source; this is an empty terminal page.',
        );
    }
    if (measureResponse(output, enrichment) > 24576)
      enrichment.notices.push(
        'Selected document data exceeds the response target and is returned intact. Select fewer sections or follow individual section continuation calls.',
      );
    budget.check();
    ctx.enrich(enrichment);
    return output;
  },
  format: formatExact,
});
