/** @fileoverview Complete speech candidates and exact retrieval-ID detail. @module services/riksdag/speeches */
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { normalizeSpeechId } from './normalize.js';
import type { RiksdagService } from './riksdag-service.js';
import { htmlToMarkdown } from './text.js';
import type { ToolBudget } from './transport.js';
import {
  assertCompleteCandidates,
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
const listSchema = z.object({
  anforandelista: z.object({
    '@antal': wireCount,
    anforande: collectionOf(wireSpeech),
  }),
});
const detailSchema = z.object({ anforande: wireSpeech });

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
  relatedDocumentId: z.string().optional().describe('Source-linked related document ID.'),
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

function normalize(row: z.output<typeof wireSpeech>): Speech {
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
    ...(row.anforande_id ? { sourceSpeechId: row.anforande_id } : {}),
    ...(row.dok_rm ? { session: row.dok_rm } : {}),
    ...(row.dok_titel ? { protocolTitle: row.dok_titel } : {}),
    ...(row.intressent_id ? { memberId: row.intressent_id } : {}),
    ...(row.talare ? { speaker: row.talare } : {}),
    ...(row.parti ? { party: row.parti } : {}),
    ...(row.dok_datum ? { date: row.dok_datum } : {}),
    ...(row.avsnittsrubrik ? { heading: row.avsnittsrubrik } : {}),
    ...(row.underrubrik ? { subheading: row.underrubrik } : {}),
    ...(row.kammaraktivitet ? { activity: row.kammaraktivitet } : {}),
    ...(row.replik === 'Y' || row.replik === 'N' ? { reply: row.replik === 'Y' } : {}),
    ...(row.rel_dok_id ? { relatedDocumentId: row.rel_dok_id } : {}),
    ...(row.anforande_url_html ? { sourceHtmlUrl: sourceUrl(row.anforande_url_html) } : {}),
    ...(row.protokoll_url_www ? { protocolUrl: sourceUrl(row.protokoll_url_www) } : {}),
  };
}

/** Verified narrowing applied before complete candidate acquisition. */
export interface SpeechFilters {
  memberId?: string;
  party?: string;
  session: string;
  speechType: 'all' | 'speech';
}

function validateList(data: z.output<typeof listSchema>, filters: SpeechFilters): Speech[] {
  const rows = data.anforandelista.anforande;
  assertCompleteCandidates(
    rows,
    data.anforandelista['@antal'],
    (row) => `${row.dok_id.toUpperCase()}-${row.anforande_nummer}`,
  );
  const records = rows.map(normalize);
  for (const row of records) {
    if (
      (row.session !== undefined && row.session !== filters.session) ||
      (filters.memberId !== undefined &&
        row.memberId !== undefined &&
        row.memberId !== filters.memberId) ||
      (filters.party !== undefined && row.party !== undefined && row.party !== filters.party) ||
      (filters.speechType === 'speech' && row.reply === true)
    )
      identityMismatch();
  }
  return records.sort((a, b) => a.speechId.localeCompare(b.speechId, 'en', { numeric: true }));
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
  const records = validateList(loaded.data, filters);
  budget.check();
  return { records, retrievedAt: loaded.retrievedAt };
}

function validateDetail(data: z.output<typeof detailSchema>, speechId: string): Speech {
  const record = normalize(data.anforande);
  if (record.speechId !== speechId) identityMismatch();
  return record;
}

/** Resolves only fixed-route retrieval IDs and converts the full published body once. */
export async function loadSpeechDetail(
  service: RiksdagService,
  budget: ToolBudget,
  speechId: string,
) {
  const loaded = await service.loadJson(
    {
      path: `/anforande/${speechId}.json`,
      schema: detailSchema,
      expected404: true,
      ttlMs: 300000,
      cacheable: (data) => {
        validateDetail(data, speechId);
        return true;
      },
    },
    budget,
  );
  if (!loaded.found) return loaded;
  const record = validateDetail(loaded.data, speechId);
  budget.check();
  const text =
    loaded.data.anforande.anforandetext === undefined
      ? undefined
      : htmlToMarkdown(loaded.data.anforande.anforandetext);
  budget.check();
  return {
    found: true as const,
    record,
    ...(text === undefined ? {} : { text }),
    retrievedAt: loaded.retrievedAt,
  };
}
