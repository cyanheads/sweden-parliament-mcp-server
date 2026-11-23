/** @fileoverview Complete speech candidates and exact retrieval-ID detail. @module services/riksdag/speeches */
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { DOMParser, MIME_TYPE, Node, onWarningStopParsing } from '@xmldom/xmldom';
import { canonicalDocumentId, normalizeSpeechId } from './normalize.js';
import type { RiksdagService } from './riksdag-service.js';
import { htmlToMarkdown } from './text.js';
import type { ToolBudget } from './transport.js';
import {
  assertCompleteCount,
  collectionOf,
  optionalWireString,
  schemaInvalid,
  sourceUrl,
  wireCount,
} from './wire.js';

const wireSpeech = z.object({
  dok_id: z.string().min(1),
  anforande_nummer: z.string().regex(/^[1-9]\d*$/),
  dok_rm: optionalWireString,
  dok_titel: optionalWireString,
  dok_datum: optionalWireString,
  avsnittsrubrik: optionalWireString,
  underrubrik: optionalWireString,
  kammaraktivitet: optionalWireString,
  anforande_id: optionalWireString,
  talare: optionalWireString,
  parti: optionalWireString,
  intressent_id: optionalWireString,
  rel_dok_id: optionalWireString,
  replik: z.enum(['Y', 'N', '']).nullish(),
  anforandetext: optionalWireString,
  anforande_url_xml: optionalWireString,
  anforande_url_html: optionalWireString,
  protokoll_url_www: optionalWireString,
});
type WireSpeech = z.output<typeof wireSpeech>;
const listSchema = z.object({
  anforandelista: z.object({
    '@antal': wireCount,
    anforande: collectionOf(wireSpeech),
  }),
});
/** One JSON record, or every record of a doubled XML body; never none. */
const detailSchema = z.object({
  anforande: z.union([
    z.tuple([wireSpeech], wireSpeech),
    wireSpeech.transform((row): [WireSpeech] => [row]),
  ]),
});

/**
 * Strict XML 1.0: any parser warning or error stops the parse, so a body cut mid-record fails rather
 * than yielding the record read so far. Line ends follow XML 1.0; the parser's default also folds
 * U+0085, U+2028 and U+2029 into line feeds, which would alter published text.
 */
const xmlParser = new DOMParser({
  onError: onWarningStopParsing,
  normalizeLineEndings: (source) => source.replaceAll('\r\n', '\n').replaceAll('\r', '\n'),
});

/** Element children of a node, or `undefined` when it also holds anything but blank layout text. */
function childElements(node: Node | null): Node[] | undefined {
  const elements: Node[] = [];
  for (const child of node?.childNodes ?? []) {
    if (child.nodeType === Node.ELEMENT_NODE) elements.push(child);
    else if (child.nodeType !== Node.TEXT_NODE || child.textContent?.trim()) return undefined;
  }
  return elements;
}

/** One record's fields as published strings, or `undefined` unless every field is a distinct leaf. */
function xmlRecord(element: Node): Record<string, string> | undefined {
  const fields = new Map<string, string>();
  for (const field of childElements(element) ?? []) {
    const nested = Array.from(field.childNodes).some(
      (child) => child.nodeType === Node.ELEMENT_NODE,
    );
    if (nested || fields.has(field.nodeName)) return undefined;
    fields.set(field.nodeName, field.textContent ?? '');
  }
  return fields.size ? Object.fromEntries(fields) : undefined;
}

/**
 * Decodes the body the source serves for a speech it publishes twice: concatenated `<anforande>`
 * XML records under a JSON content type, read inside one wrapping root. Any other body returns
 * `undefined` and keeps the invalid-JSON failure; a malformed record body fails as malformed XML.
 */
function decodeSpeechXml(text: string): { anforande: Record<string, string>[] } | undefined {
  if (!text.trimStart().startsWith('<anforande>')) return undefined;
  let parsed: ReturnType<DOMParser['parseFromString']>;
  try {
    parsed = xmlParser.parseFromString(`<records>${text}</records>`, MIME_TYPE.XML_TEXT);
  } catch (cause) {
    throw new McpError(
      JsonRpcErrorCode.SerializationError,
      'Riksdagen returned malformed speech XML.',
      { reason: 'upstream_schema_invalid', retryable: false },
      { cause },
    );
  }
  const records = childElements(parsed.documentElement)?.map((element) =>
    element.nodeName === 'anforande' ? xmlRecord(element) : undefined,
  );
  return records?.length && records.every((record) => record !== undefined)
    ? { anforande: records }
    : undefined;
}

/** Source metadata preserves missing values and separates retrieval IDs from source UUIDs. */
export const speechSchema = z.object({
  speechId: z
    .string()
    .describe('Retrieval ID for get mode; protocol document ID and speech number.'),
  sourceSpeechId: z
    .string()
    .optional()
    .describe('Source speech UUID, distinct from the retrieval ID.'),
  protocolDocumentId: z.string().describe('Document ID of the chamber protocol.'),
  session: z.string().optional().describe('Published parliamentary session.'),
  protocolTitle: z.string().optional().describe('Published protocol title.'),
  memberId: z.string().optional().describe('Published member IID, including leading zeros.'),
  speaker: z.string().optional().describe('Published speaker name and title.'),
  party: z.string().optional().describe('Published party code.'),
  date: z.string().optional().describe('Published date or date-time with source precision.'),
  heading: z.string().optional().describe('Published debate heading.'),
  subheading: z.string().optional().describe('Published debate subheading.'),
  activity: z.string().optional().describe('Published chamber activity.'),
  reply: z.boolean().optional().describe('Whether the source explicitly marks this as a reply.'),
  relatedDocumentId: z
    .string()
    .optional()
    .describe(
      'Source-linked related document ID in canonical form, or a ", "-separated list for joint debates.',
    ),
  sourceUrl: z.string().describe('Fixed-origin speech detail source link.'),
  sourceHtmlUrl: z.string().optional().describe('Published speech HTML link.'),
  protocolUrl: z.string().optional().describe('Published protocol link and speech anchor.'),
});
/** Normalized speech metadata without text hydration. */
export type Speech = z.infer<typeof speechSchema>;

function identityMismatch(): never {
  throw new McpError(
    JsonRpcErrorCode.SerializationError,
    'The source speech identity contradicts the requested identity.',
    { reason: 'upstream_identity_mismatch', retryable: false },
  );
}

/** Joint interpellation debates link several documents in one source `rel_dok_id` list. */
const RELATED_SEPARATOR = ', ';

/** Canonical document ID, or the source text of an element that is not one: a link never fails a search. */
function relatedElement(element: string): string {
  return canonicalDocumentId(element) ?? element;
}

/** Whether any element of a speech's related-document list equals this canonical document ID. */
export function linksDocument(speech: Speech, documentId: string): boolean {
  return speech.relatedDocumentId?.split(RELATED_SEPARATOR).includes(documentId) ?? false;
}

function normalize(row: WireSpeech): Speech {
  const protocolDocumentId = row.dok_id.toUpperCase();
  const rawId = `${protocolDocumentId}-${row.anforande_nummer}`;
  let speechId: string;
  try {
    speechId = normalizeSpeechId(rawId);
  } catch {
    throw schemaInvalid('The source supplied an invalid speech retrieval identity.');
  }
  if (row.anforande_url_xml) {
    const url = new URL(sourceUrl(row.anforande_url_xml));
    if (
      url.origin !== 'https://data.riksdagen.se' ||
      url.pathname.toUpperCase() !== `/ANFORANDE/${speechId}`
    )
      identityMismatch();
  }
  if (row.intressent_id && !/^\d+$/.test(row.intressent_id))
    throw schemaInvalid('The source supplied an invalid member IID.');
  return {
    speechId,
    protocolDocumentId,
    sourceUrl: `https://data.riksdagen.se/anforande/${speechId}`,
    sourceSpeechId: row.anforande_id,
    session: row.dok_rm,
    protocolTitle: row.dok_titel,
    memberId: row.intressent_id,
    speaker: row.talare,
    party: row.parti,
    date: row.dok_datum,
    heading: row.avsnittsrubrik,
    subheading: row.underrubrik,
    activity: row.kammaraktivitet,
    reply: row.replik === 'Y' ? true : row.replik === 'N' ? false : undefined,
    relatedDocumentId: row.rel_dok_id
      ?.split(RELATED_SEPARATOR)
      .map(relatedElement)
      .join(RELATED_SEPARATOR),
    sourceHtmlUrl: row.anforande_url_html && sourceUrl(row.anforande_url_html),
    protocolUrl: row.protokoll_url_www && sourceUrl(row.protokoll_url_www),
  };
}

/** One published copy of a speech; a detail copy also carries the body get mode reads. */
interface SpeechCopy {
  body?: string | undefined;
  record: Speech;
}

/** Fields two copies of one speech must share: every normalized field except the source UUID. */
const SHARED_FIELDS = Object.keys(speechSchema.shape).filter(
  (key): key is Exclude<keyof Speech, 'sourceSpeechId'> => key !== 'sourceSpeechId',
);

/**
 * Merges a further copy the source publishes under the same retrieval ID, keeping the lowest source
 * UUID in plain string order (an absent UUID last) so the kept copy, and every revision over it,
 * is independent of row order. Copies that differ in any read field or in their body are rejected.
 */
function mergeCopy(kept: SpeechCopy, copy: SpeechCopy): SpeechCopy {
  if (copy.body !== kept.body || SHARED_FIELDS.some((key) => copy.record[key] !== kept.record[key]))
    throw schemaInvalid('The source returned conflicting records under one speech retrieval ID.');
  const candidate = copy.record.sourceSpeechId;
  const current = kept.record.sourceSpeechId;
  return candidate !== undefined && (current === undefined || candidate < current) ? copy : kept;
}

/** Verified narrowing applied before complete candidate acquisition. */
export interface SpeechFilters {
  memberId?: string;
  party?: string;
  session: string;
  speechType: 'all' | 'speech';
}

/**
 * Validates the raw rows (count and saturation included), then collapses speeches the source lists
 * twice, so every reader of the candidate set sees each retrieval ID once.
 */
function validateList(data: z.output<typeof listSchema>, filters: SpeechFilters) {
  const rows = data.anforandelista.anforande;
  assertCompleteCount(rows, data.anforandelista['@antal']);
  const kept = new Map<string, SpeechCopy>();
  for (const row of rows.map(normalize)) {
    if (
      (row.session !== undefined && row.session !== filters.session) ||
      (filters.memberId !== undefined &&
        row.memberId !== undefined &&
        row.memberId !== filters.memberId) ||
      (filters.party !== undefined && row.party !== undefined && row.party !== filters.party) ||
      (filters.speechType === 'speech' && row.reply === true)
    )
      identityMismatch();
    const prior = kept.get(row.speechId);
    kept.set(row.speechId, prior ? mergeCopy(prior, { record: row }) : { record: row });
  }
  const records = Array.from(kept.values(), ({ record }) => record).sort((a, b) =>
    a.speechId.localeCompare(b.speechId, 'en', { numeric: true }),
  );
  return { records, collapsedCount: rows.length - records.length };
}

/** Fetches one complete bounded candidate set; ignored remote paging is never attempted. */
export async function loadSpeechCandidates(
  service: RiksdagService,
  budget: ToolBudget,
  filters: SpeechFilters,
) {
  const loaded = await service.loadJson(
    {
      path: '/anforandelista/',
      query: {
        utformat: 'json',
        rm: filters.session,
        iid: filters.memberId,
        parti: filters.party,
        anftyp: filters.speechType === 'speech' ? 'Nej' : undefined,
        sz: 50000,
      },
      schema: listSchema,
      ttlMs: 120000,
      cacheable: (data) => {
        validateList(data, filters);
        return true;
      },
    },
    budget,
  );
  if (!loaded.found)
    throw schemaInvalid('The speech candidate endpoint did not return its list wrapper.');
  const { records, collapsedCount } = validateList(loaded.data, filters);
  budget.check();
  return { records, collapsedCount, retrievedAt: loaded.retrievedAt };
}

/** Every record must be the requested speech; copies collapse under the list's rule, body included. */
function validateDetail(data: z.output<typeof detailSchema>, speechId: string): SpeechCopy {
  const copyOf = (row: WireSpeech): SpeechCopy => {
    const record = normalize(row);
    if (record.speechId !== speechId) identityMismatch();
    return { record, body: row.anforandetext };
  };
  const [first, ...rest] = data.anforande;
  return rest.map(copyOf).reduce(mergeCopy, copyOf(first));
}

/**
 * Resolves only fixed-route retrieval IDs and converts the full published body once. A speech the
 * source publishes twice arrives as doubled XML on this route and collapses like its list rows.
 */
export async function loadSpeechDetail(
  service: RiksdagService,
  budget: ToolBudget,
  speechId: string,
) {
  const loaded = await service.loadJson(
    {
      path: `/anforande/${speechId}.json`,
      schema: detailSchema,
      decodeNonJson: decodeSpeechXml,
      expected404: true,
      expectedEmpty200: true,
      ttlMs: 300000,
      cacheable: (data) => {
        validateDetail(data, speechId);
        return true;
      },
    },
    budget,
  );
  if (!loaded.found) return loaded;
  const { record, body } = validateDetail(loaded.data, speechId);
  budget.check();
  const text = body === undefined ? undefined : htmlToMarkdown(body);
  budget.check();
  return {
    found: true as const,
    record,
    ...(text === undefined ? {} : { text }),
    retrievedAt: loaded.retrievedAt,
  };
}
