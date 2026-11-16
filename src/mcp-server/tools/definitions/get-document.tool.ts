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
  documentStakeholderSchema,
  loadDocumentStatus,
} from '../../../services/riksdag/documents.js';
import {
  formatString,
  normalizeDocumentId,
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
import { pageTexts, type TextPageSource } from '../../../services/riksdag/pagination.js';
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
  'stakeholders',
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
  'stakeholders',
] as const;
const inputSchema = z.object({
  documentId: formatString('documentId', { blank: false })
    .min(1)
    .describe(
      'Document ID from riksdag_search_documents or a member vote row, or an SFS YYYY:N identifier.',
    ),
  sections: z
    .array(sectionSchema)
    .optional()
    .describe(
      'Sections to return. Omit for metadata, outline and first text page; [] returns only the outline.',
    ),
  textOffset: z.number().int().min(0).default(0).describe('Text offset in Unicode code points.'),
  textLength: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Text page length in Unicode code points; default 8000.'),
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
    .describe('Source HTML page length in Unicode code points; default 8000.'),
  sectionOffset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Entry offset for each selected array section.'),
  sectionLimit: z
    .number()
    .int()
    .min(1)
    .default(20)
    .describe('Entries per selected array section; clamped to a maximum of 100.'),
  revision: z
    .string()
    .optional()
    .describe('Revision from a previous call; a changed record is rejected.'),
});
const nextCallSchema = toolCallSchema('riksdag_get_document');
const outputSchema = z.object({
  found: z.boolean().describe('Whether the source record exists.'),
  documentId: z.string().describe('Normalized document identifier.'),
  truncated: z
    .boolean()
    .optional()
    .describe('A selected array section has more entries; follow its sectionPages nextCall.'),
  guidance: z.string().optional().describe('How to resolve a missing identifier.'),
  revision: z.string().optional().describe('Hash of the complete normalized record.'),
  outline: z
    .array(
      z
        .object({
          section: sectionSchema.describe('Selectable section key.'),
          available: z.boolean().describe('Whether the source publishes this section.'),
          itemCount: z.number().optional().describe('Complete section entry count.'),
          textLength: z.number().optional().describe('Total text length in code points.'),
        })
        .describe('One section and its size.'),
    )
    .optional()
    .describe('Every selectable section with its size.'),
  relatedSpeechesCall: toolCallSchema('riksdag_search_speeches')
    .optional()
    .describe(
      'Speech search for the speeches the source links to this report (bet) or interpellation (ip); present when the record has a session. A resumed debate’s later segments can lack the link, and it can return none.',
    ),
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
  stakeholders: z
    .array(documentStakeholderSchema)
    .optional()
    .describe('Selected source participants, including those without an IID.'),
  sectionPages: z
    .array(
      z
        .object({
          section: z.enum(arrayKeys).describe('Selected array section.'),
          totalCount: z.number().describe('Total entries in this section.'),
          offset: z.number().describe('Applied entry offset.'),
          limit: z.number().describe('Applied section limit, maximum 100.'),
          requestedLimit: z.number().describe('Requested section limit.'),
          returnedCount: z.number().describe('Entries returned.'),
          hasMore: z.boolean().describe('Whether entries remain.'),
          nextCall: nextCallSchema.optional().describe('Continuation for this section only.'),
        })
        .describe('Pagination for one selected section.'),
    )
    .optional()
    .describe('Counts and continuation for each selected array section.'),
  textAvailable: z.boolean().optional().describe('Whether a published canonical body exists.'),
  textRepresentation: z
    .enum(['source_text', 'markdown'])
    .optional()
    .describe('Source SFS text or canonical converted Markdown.'),
  text: z.string().optional().describe('Canonical text page, identical on both surfaces.'),
  textOffset: z.number().optional().describe('Returned text offset, code points.'),
  textTotalLength: z.number().optional().describe('Total canonical text length, code points.'),
  textReturnedLength: z.number().optional().describe('Returned text code points.'),
  textHasMore: z.boolean().optional().describe('Whether canonical text remains.'),
  nextTextCall: nextCallSchema.optional().describe('Continuation for canonical text.'),
  sourceHtml: z.string().optional().describe('Original source HTML page, selected separately.'),
  htmlOffset: z.number().optional().describe('Returned HTML offset, code points.'),
  htmlTotalLength: z.number().optional().describe('Total HTML length, code points.'),
  htmlReturnedLength: z.number().optional().describe('Returned HTML code points.'),
  htmlHasMore: z.boolean().optional().describe('Whether source HTML remains.'),
  nextHtmlCall: nextCallSchema.optional().describe('Continuation for source HTML.'),
});

/** Retrieve complete source sections and individually traversable text representations. */
export const riksdagGetDocument = tool('riksdag_get_document', {
  title: 'Read parliamentary document',
  description:
    'Read a document status, decisions, linked records and text. Select sections and follow continuation calls to read long reports or consolidated SFS statutes. For a committee report or interpellation, relatedSpeechesCall searches the speeches the source links to it (a resumed debate’s later segments can lack the link). SFS text is consolidated published text, not a point-in-time legal version.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: inputSchema,
  output: outputSchema,
  enrichment: successEnrichment,
  enrichmentTrailer: successEnrichmentTrailer,
  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An identifier that passes the input pattern is not a valid ID after NFC normalization.',
      recovery:
        'Use riksdag_list_reference to check codes and identifier formats, then retry the same tool with corrected filters.',
      thrownBy: 'service',
    },
    {
      reason: 'revision_changed',
      code: JsonRpcErrorCode.Conflict,
      when: 'The source record changed between calls.',
      recovery:
        'Restart the same tool without revision and begin at the first page to read one consistent record.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_identity_mismatch',
      code: JsonRpcErrorCode.SerializationError,
      when: 'The status response contradicts the requested document ID.',
      recovery:
        'Copy documentId from riksdag_search_documents and retry riksdag_get_document; report repeated mismatches with the request identifier.',
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
        'Retry riksdag_get_document with the same documentId after the source becomes available.',
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
    const documentId = normalizeDocumentId(input.documentId);
    const selected = input.sections ?? ['metadata', 'text'];
    const revision = optionalString(input.revision);
    const args = {
      ...input,
      documentId,
      sectionLimit: Math.min(input.sectionLimit, 100),
      revision,
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
    assertRevision(revision, record.revision);
    const continuationArgs = { ...args, revision: record.revision };
    const { documentType, session } = record.metadata;
    const debated = session !== undefined && ['bet', 'ip'].includes(documentType ?? '');
    const output: z.infer<typeof outputSchema> = {
      found: true,
      documentId,
      truncated: false,
      revision: record.revision,
      outline: sectionKeys.map((section) => {
        if (section === 'metadata') return { section, available: true, itemCount: 1 };
        if (section === 'text' || section === 'source_html') {
          const body = section === 'text' ? record.text : record.sourceHtml;
          return {
            section,
            available: body !== undefined,
            ...(body === undefined ? {} : { textLength: codePointLength(body) }),
          };
        }
        return {
          section,
          available: record[section].length > 0,
          itemCount: record[section].length,
        };
      }),
      ...(debated
        ? {
            relatedSpeechesCall: {
              toolName: 'riksdag_search_speeches' as const,
              args: { session, relatedDocumentId: documentId },
            },
          }
        : {}),
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
      budget.check();
      const rows = record[section];
      const entries = rows.slice(args.sectionOffset, args.sectionOffset + args.sectionLimit);
      const hasMore = args.sectionOffset + entries.length < rows.length;
      Object.assign(output, { [section]: entries });
      output.sectionPages.push({
        section,
        totalCount: rows.length,
        offset: args.sectionOffset,
        limit: args.sectionLimit,
        requestedLimit: input.sectionLimit,
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
      });
      if (args.sectionOffset > rows.length)
        enrichment.notices.push(`Section ${section} offset is beyond its available entries.`);
    }
    output.truncated = output.sectionPages.some((page) => page.hasMore);
    const textSources: (TextPageSource & { section: 'text' | 'source_html' })[] = [];
    if (selected.includes('text')) {
      output.textRepresentation = record.textRepresentation;
      if (record.text !== undefined) {
        textSources.push({
          section: 'text',
          text: record.text,
          offset: input.textOffset,
          ...(input.textLength === undefined ? {} : { length: input.textLength }),
          pastEndNotice:
            'Text offset is beyond the published body; this is an empty terminal page.',
        });
      }
    }
    if (selected.includes('source_html') && record.sourceHtml !== undefined) {
      textSources.push({
        section: 'source_html',
        text: record.sourceHtml,
        offset: input.htmlOffset,
        ...(input.htmlLength === undefined ? {} : { length: input.htmlLength }),
        pastEndNotice:
          'HTML offset is beyond the published source; this is an empty terminal page.',
      });
    }
    const buildTextPages = (
      pages: {
        source: (typeof textSources)[number];
        text: string;
        returnedLength: number;
        totalLength: number;
      }[],
    ) => {
      const result = { ...output };
      for (const page of pages) {
        const { source, totalLength: total } = page;
        const { section } = source;
        const hasMore = source.offset + page.returnedLength < total;
        const nextCall = hasMore
          ? {
              toolName: 'riksdag_get_document' as const,
              args: {
                ...continuationArgs,
                sections: [section],
                ...(section === 'text'
                  ? { textOffset: source.offset + page.returnedLength }
                  : { htmlOffset: source.offset + page.returnedLength }),
              },
            }
          : undefined;
        if (section === 'text')
          Object.assign(result, {
            text: page.text,
            textOffset: source.offset,
            textTotalLength: total,
            textReturnedLength: page.returnedLength,
            textHasMore: hasMore,
            ...(nextCall ? { nextTextCall: nextCall } : {}),
          });
        else
          Object.assign(result, {
            sourceHtml: page.text,
            htmlOffset: source.offset,
            htmlTotalLength: total,
            htmlReturnedLength: page.returnedLength,
            htmlHasMore: hasMore,
            ...(nextCall ? { nextHtmlCall: nextCall } : {}),
          });
      }
      return result;
    };
    const paged = pageTexts({ sources: textSources, enrichment, budget, build: buildTextPages });
    ctx.enrich(enrichment);
    return paged;
  },
  format: formatExact,
});
