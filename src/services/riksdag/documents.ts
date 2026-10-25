/** @file src/services/riksdag/documents.ts — Typed parliamentary document search and complete status records. */
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { normalizeDocumentId, normalizeReport, normalizeSession } from './normalize.js';
import type { RiksdagService } from './riksdag-service.js';
import { htmlToMarkdown, revisionOf } from './text.js';
import type { ToolBudget } from './transport.js';
import {
  collectionOf,
  optionalWireString,
  parseSourceIdentity,
  schemaInvalid,
  sourceUrl,
  wireCount,
} from './wire.js';

const s = optionalWireString;
const wireDocument = z.object({
  dok_id: z.string().min(1),
  doktyp: s,
  typ: s,
  subtyp: s,
  rm: s,
  beteckning: s,
  titel: s,
  subtitel: s,
  datum: s,
  publicerad: s,
  systemdatum: s,
  organ: s,
  status: s,
  dokument_url_html: s,
  dokument_url_text: s,
  dokumentstatus_url_xml: s,
  html: s,
  text: s,
});
const listSchema = z.object({
  dokumentlista: z.object({
    '@traffar': wireCount.optional(),
    '@sida': wireCount.optional(),
    '@nasta_sida': s,
    '@q': s,
    '@varning': s,
    dokument: collectionOf(wireDocument),
  }),
});
const summaryCell = z.union([z.string(), z.object({ '#text': z.string().nullish() })]);
const summaryRow = z.object({ th: s, td: collectionOf(summaryCell) });
const summaryTable = z.object({
  table: z.object({
    caption: z.object({ b: s, '#text': s }).optional(),
    thead: z.object({ tr: z.object({ th: collectionOf(z.string()) }) }).optional(),
    tbody: z.object({ tr: collectionOf(summaryRow) }).optional(),
    tfooter: z.object({ tr: summaryRow }).optional(),
  }),
});
const summaryWire = z.union([z.string(), summaryTable]).nullish();
const summaryOutputCell = z
  .string()
  .nullable()
  .describe('Published cell text, preserving blank and zero; null means absent structured text.');
const summaryOutputRow = z
  .object({
    label: z.string().optional().describe('Published row heading.'),
    cells: z
      .array(summaryOutputCell)
      .describe('Ordered source cells; blank and zero values remain distinct.'),
  })
  .describe('One published summary row.');
const summaryOutput = z
  .object({
    text: z
      .string()
      .optional()
      .describe('Published summary text when the source provides a string instead of a table.'),
    caption: z
      .object({
        heading: z.string().optional().describe('Published bold caption.'),
        text: z.string().optional().describe('Published caption text, separate from its heading.'),
      })
      .optional()
      .describe('Published caption components.'),
    columns: z
      .array(z.string())
      .optional()
      .describe('Ordered published column headings when a header is available.'),
    rows: z
      .array(summaryOutputRow)
      .optional()
      .describe('Ordered published body rows when a body is available.'),
    footer: summaryOutputRow.optional().describe('Published totals row, when available.'),
  })
  .describe('Published vote-summary table without HTML wrapper layers.');
function normalizeSummary(
  summary: z.infer<typeof summaryWire>,
): z.infer<typeof summaryOutput> | undefined {
  if (!summary) return undefined;
  if (typeof summary === 'string') return { text: summary };
  const row = (value: z.infer<typeof summaryRow>) => ({
    label: value.th,
    cells: value.td.map((cell) => (typeof cell === 'string' ? cell : (cell['#text'] ?? null))),
  });
  const table = summary.table;
  return {
    ...(table.caption
      ? { caption: { heading: table.caption.b, text: table.caption['#text'] } }
      : {}),
    ...(table.thead ? { columns: table.thead.tr.th } : {}),
    ...(table.tbody ? { rows: table.tbody.tr.map(row) } : {}),
    ...(table.tfooter ? { footer: row(table.tfooter.tr) } : {}),
  };
}
const decisionWire = z.object({
  punkt: wireCount,
  rubrik: s,
  forslag: s,
  beslutstyp: s,
  votering_id: s,
  vinnare: s,
  rm: s,
  bet: s,
  votering_url_xml: s,
  votering_sammanfattning_html: summaryWire,
  motforslag_nummer: s,
  motforslag_partier: s,
  voteringskrav: s,
  beslutsregelkvot: s,
  beslutsregelparagraf: s,
  punkttyp: s,
});
const reservationWire = z.object({
  nummer: s,
  rubrik: s,
  partier: s,
  typ: s,
  utskottsforslag_punkt: s,
});
const activityWire = z.object({ kod: s, namn: s, datum: s, status: s, process: s });
const propertyWire = z.object({ kod: s, namn: s, text: s });
const attachmentWire = z.object({
  titel: s,
  subtitel: s,
  filnamn: s,
  filtyp: s,
  filstorlek: s,
  fil_url: s,
});
const referenceWire = z.object({
  referenstyp: s,
  uppgift: s,
  ref_dok_id: s,
  ref_dok_typ: s,
  ref_dok_rm: s,
  ref_dok_bet: s,
  ref_dok_titel: s,
  ref_dok_subtitel: s,
});
const statusSchema = z.object({
  dokumentstatus: z.object({
    dokument: wireDocument,
    dokutskottsforslag: z.object({ utskottsforslag: collectionOf(decisionWire) }).nullish(),
    dokmotforslag: z.object({ motforslag: collectionOf(reservationWire) }).nullish(),
    dokaktivitet: z.object({ aktivitet: collectionOf(activityWire) }).nullish(),
    dokuppgift: z.object({ uppgift: collectionOf(propertyWire) }).nullish(),
    dokumentuppgift: z.object({ uppgift: collectionOf(propertyWire) }).nullish(),
    dokbilaga: z.object({ bilaga: collectionOf(attachmentWire) }).nullish(),
    dokreferens: z.object({ referens: collectionOf(referenceWire) }).nullish(),
  }),
});

/** Public document identity and sparse publication metadata. */
export const documentMetadataSchema = z
  .object({
    documentId: z.string().describe('Canonical document ID.'),
    documentType: z.string().optional().describe('Source document type code.'),
    subtype: z.string().optional().describe('Source document subtype code.'),
    session: z.string().optional().describe('Published parliamentary session.'),
    designation: z
      .string()
      .optional()
      .describe('Published document designation, distinct from its ID.'),
    title: z.string().optional().describe('Source-authored title.'),
    subtitle: z.string().optional().describe('Source-authored subtitle.'),
    date: z.string().optional().describe('Document date at source precision.'),
    publishedAt: z.string().optional().describe('Publication timestamp at source precision.'),
    systemDate: z.string().optional().describe('Source system timestamp at published precision.'),
    committee: z.string().optional().describe('Published responsible organ.'),
    publicationStatus: z
      .string()
      .optional()
      .describe('Publication status; separate from chamber decision status.'),
    chamberStatus: z
      .string()
      .optional()
      .describe('Authoritative chamber status property, when published.'),
    sourceUrl: z.string().describe('Source document link.'),
    statusUrl: z.string().describe('Fixed-origin source status JSON link.'),
    sourceTextUrl: z
      .string()
      .optional()
      .describe('Published source text-route link; not necessarily plain text.'),
    versionKind: z
      .literal('consolidated')
      .optional()
      .describe('SFS published consolidation, not a point-in-time legal version.'),
    consolidationLabel: z.string().optional().describe('Published SFS consolidation subtitle.'),
  })
  .describe('Document identity, publication metadata and source links.');
/** Authoritative published decision, with source summary retained as typed table data. */
export const documentDecisionSchema = z
  .object({
    point: z.number().int().positive().describe('Positive report point number.'),
    heading: z.string().optional().describe('Source-authored point heading.'),
    proposal: z
      .string()
      .optional()
      .describe('Source-authored proposal text, including source HTML.'),
    decisionType: z
      .string()
      .optional()
      .describe('Published decision method; acclamation is authoritative only here.'),
    voteId: z.string().optional().describe('Published roll-call identifier.'),
    winner: z.string().optional().describe('Published winning proposal label.'),
    session: z.string().optional().describe('Decision parliamentary session.'),
    report: z.string().optional().describe('Decision committee-report designation.'),
    sourceUrl: z.string().optional().describe('Published roll-call source link.'),
    summary: summaryOutput.optional().describe('Published summary text or normalized table.'),
    counterProposalNumber: z.string().optional().describe('Source counterproposal number.'),
    counterProposalParties: z
      .string()
      .optional()
      .describe('Source counterproposal party expression.'),
    votingRequirement: z.string().optional().describe('Published voting requirement.'),
    decisionRuleQuota: z.string().optional().describe('Published decision-rule quota.'),
    decisionRuleParagraph: z.string().optional().describe('Published decision-rule provision.'),
    pointType: z.string().optional().describe('Published point-type label.'),
  })
  .describe('One complete published report decision.');
/** Reservation entries preserve source strings rather than inventing party memberships. */
export const documentReservationSchema = z
  .object({
    number: z.string().optional().describe('Published reservation number.'),
    heading: z.string().optional().describe('Source reservation heading.'),
    parties: z.string().optional().describe('Source party expression.'),
    type: z.string().optional().describe('Published reservation type.'),
    point: z.string().optional().describe('Related report point.'),
  })
  .describe('One source reservation.');
/** Source process events in published order. */
export const documentActivitySchema = z
  .object({
    code: z.string().optional().describe('Source event code.'),
    name: z.string().optional().describe('Source event name.'),
    date: z.string().optional().describe('Event date at source precision.'),
    status: z.string().optional().describe('Published event status.'),
    process: z.string().optional().describe('Published process label.'),
  })
  .describe('One source process event.');
/** Source properties, including source-authored HTML where supplied. */
export const documentPropertySchema = z
  .object({
    code: z.string().optional().describe('Source property code.'),
    name: z.string().optional().describe('Source property name.'),
    text: z.string().optional().describe('Source property value, including published HTML.'),
  })
  .describe('One published document property.');
/** Linked attachments are never downloaded. */
export const documentAttachmentSchema = z
  .object({
    title: z.string().optional().describe('Source attachment title.'),
    subtitle: z.string().optional().describe('Source attachment subtitle.'),
    filename: z.string().optional().describe('Published attachment filename.'),
    type: z.string().optional().describe('Published file type.'),
    sizeBytes: z
      .string()
      .optional()
      .describe('Published file size in bytes, retained as a source string.'),
    sourceUrl: z
      .string()
      .optional()
      .describe('Attachment download link; never fetched by this tool.'),
  })
  .describe('One source attachment link.');
/** Source-provided relationships to other parliamentary records. */
export const documentReferenceSchema = z
  .object({
    relationship: z.string().optional().describe('Published relationship type.'),
    description: z.string().optional().describe('Source relationship description.'),
    documentId: z.string().optional().describe('Linked canonical document ID.'),
    documentType: z.string().optional().describe('Linked document type code.'),
    session: z.string().optional().describe('Linked document session.'),
    designation: z.string().optional().describe('Linked document designation.'),
    title: z.string().optional().describe('Linked source title.'),
    subtitle: z.string().optional().describe('Linked source subtitle.'),
  })
  .describe('One source-provided relationship.');
export type DocumentDecision = z.infer<typeof documentDecisionSchema>;
export type DocumentRecord = {
  metadata: z.infer<typeof documentMetadataSchema>;
  decisions: DocumentDecision[];
  reservations: z.infer<typeof documentReservationSchema>[];
  activities: z.infer<typeof documentActivitySchema>[];
  properties: z.infer<typeof documentPropertySchema>[];
  attachments: z.infer<typeof documentAttachmentSchema>[];
  references: z.infer<typeof documentReferenceSchema>[];
  text?: string;
  sourceHtml?: string;
  textRepresentation: 'source_text' | 'markdown';
  revision: string;
};
export type DocumentStatusResult =
  | { found: false; documentId: string; retrievedAt: string }
  | { found: true; documentId: string; retrievedAt: string; record: DocumentRecord };
export type DocumentSearchFilters = {
  query?: string;
  documentType?: string;
  session?: string;
  committee?: string;
  party?: string;
  dateFrom?: string;
  dateTo?: string;
  page: number;
  pageSize: number;
};

function identityFailure(): never {
  throw new McpError(
    JsonRpcErrorCode.SerializationError,
    'The document response contradicts the requested identity.',
    { reason: 'upstream_identity_mismatch' },
  );
}
function validateSearch(
  root: z.infer<typeof listSchema>['dokumentlista'],
  input: DocumentSearchFilters,
): void {
  if (root['@sida'] !== undefined && root['@sida'] !== input.page) identityFailure();
  const ids = new Set<string>();
  for (const row of root.dokument) {
    const id = parseSourceIdentity(row.dok_id, normalizeDocumentId);
    if (ids.has(id)) throw schemaInvalid('Document search returned duplicate document IDs.');
    ids.add(id);
    if (
      input.documentType &&
      (row.doktyp ?? row.typ) &&
      (row.doktyp ?? row.typ)?.toLowerCase() !== input.documentType.toLowerCase()
    )
      identityFailure();
    if (input.session && row.rm && parseSourceIdentity(row.rm, normalizeSession) !== input.session)
      identityFailure();
    if (input.committee && row.organ && row.organ.toLowerCase() !== input.committee.toLowerCase())
      identityFailure();
    metadata(row);
  }
  if (root['@nasta_sida']) {
    let next: URL;
    try {
      next = new URL(root['@nasta_sida'], 'https://data.riksdagen.se');
    } catch {
      throw schemaInvalid('Invalid document next-page URL.');
    }
    if (
      !['http:', 'https:'].includes(next.protocol) ||
      next.hostname !== 'data.riksdagen.se' ||
      next.pathname !== '/dokumentlista/' ||
      next.username ||
      next.password ||
      Number(next.searchParams.get('p')) !== input.page + 1
    )
      throw schemaInvalid('Invalid document next-page identity.');
  }
  if (root['@traffar'] !== undefined) {
    const expected = Math.min(
      input.pageSize,
      Math.max(0, root['@traffar'] - (input.page - 1) * input.pageSize),
    );
    if (root.dokument.length !== expected)
      throw schemaInvalid('Document search page length contradicts the published hit count.');
  }
}
function metadata(raw: z.infer<typeof wireDocument>): z.infer<typeof documentMetadataSchema> {
  const id = parseSourceIdentity(raw.dok_id, normalizeDocumentId);
  return {
    documentId: id,
    documentType: raw.doktyp ?? raw.typ,
    subtype: raw.subtyp,
    session: raw.rm,
    designation: raw.beteckning,
    title: raw.titel,
    subtitle: raw.subtitel,
    date: raw.datum,
    publishedAt: raw.publicerad,
    systemDate: raw.systemdatum,
    committee: raw.organ,
    publicationStatus: raw.status,
    sourceUrl: raw.dokument_url_html
      ? sourceUrl(raw.dokument_url_html)
      : `https://data.riksdagen.se/dokument/${id}`,
    statusUrl: `https://data.riksdagen.se/dokumentstatus/${id}.json`,
    ...(raw.dokument_url_text ? { sourceTextUrl: sourceUrl(raw.dokument_url_text) } : {}),
    ...((raw.doktyp ?? raw.typ)?.toLowerCase() === 'sfs'
      ? { versionKind: 'consolidated' as const, consolidationLabel: raw.subtitel }
      : {}),
  };
}

/** Search one remote page without dropping or reordering any fetched rows. */
export async function searchDocuments(
  service: RiksdagService,
  input: DocumentSearchFilters,
  budget: ToolBudget,
) {
  const loaded = await service.loadJson(
    {
      path: '/dokumentlista/',
      query: {
        sok: input.query,
        doktyp: input.documentType?.toLowerCase(),
        rm: input.session,
        org: input.committee,
        parti: input.party,
        from: input.dateFrom,
        tom: input.dateTo,
        p: input.page,
        sz: input.pageSize,
        utformat: 'json',
      },
      schema: listSchema,
      ttlMs: 120000,
      cacheable: (data) => {
        validateSearch(data.dokumentlista, input);
        return (
          data.dokumentlista.dokument.length > 0 && data.dokumentlista['@traffar'] !== undefined
        );
      },
    },
    budget,
  );
  if (!loaded.found)
    throw schemaInvalid('Document search unexpectedly returned a missing response.');
  const root = loaded.data.dokumentlista;
  validateSearch(root, input);
  const items = root.dokument.map(metadata);
  const totalCount = root['@traffar'];
  const hasMore =
    Boolean(root['@nasta_sida']) ||
    (totalCount !== undefined && input.page * input.pageSize < totalCount);
  budget.check();
  return {
    items,
    page: input.page,
    pageSize: input.pageSize,
    returnedCount: items.length,
    ...(totalCount === undefined ? {} : { totalCount }),
    hasMore,
    retrievedAt: loaded.retrievedAt,
    ...(root['@q'] ? { upstreamQuery: root['@q'] } : {}),
    ...(root['@varning'] ? { upstreamWarnings: [root['@varning']] } : {}),
  };
}

/** Load and normalize the complete status record; never paginate decisions used by vote workflows. */
export async function loadDocumentStatus(
  service: RiksdagService,
  documentId: string,
  budget: ToolBudget,
): Promise<DocumentStatusResult> {
  const id = normalizeDocumentId(documentId);
  const loaded = await service.loadJson(
    {
      path: `/dokumentstatus/${id}.json`,
      schema: statusSchema,
      ttlMs: 300000,
      expected404: true,
      cacheable: (data) => {
        const root = data.dokumentstatus;
        if (parseSourceIdentity(root.dokument.dok_id, normalizeDocumentId) !== id)
          identityFailure();
        const points = new Set<number>();
        for (const decision of root.dokutskottsforslag?.utskottsforslag ?? []) {
          if (decision.punkt < 1 || points.has(decision.punkt))
            throw schemaInvalid('Document status contains invalid or duplicate decision points.');
          points.add(decision.punkt);
          if (
            decision.rm &&
            root.dokument.rm &&
            parseSourceIdentity(decision.rm, normalizeSession) !==
              parseSourceIdentity(root.dokument.rm, normalizeSession)
          )
            identityFailure();
          if (
            decision.bet &&
            root.dokument.beteckning &&
            decision.bet.toUpperCase() !== root.dokument.beteckning.toUpperCase()
          )
            identityFailure();
          if (decision.votering_url_xml) sourceUrl(decision.votering_url_xml);
        }
        metadata(root.dokument);
        for (const row of root.dokbilaga?.bilaga ?? []) if (row.fil_url) sourceUrl(row.fil_url);
        for (const row of root.dokreferens?.referens ?? [])
          if (row.ref_dok_id) parseSourceIdentity(row.ref_dok_id, normalizeDocumentId);
        return true;
      },
    },
    budget,
  );
  if (!loaded.found) return { found: false, documentId: id, retrievedAt: loaded.retrievedAt };
  const root = loaded.data.dokumentstatus;
  const raw = root.dokument;
  if (parseSourceIdentity(raw.dok_id, normalizeDocumentId) !== id) identityFailure();
  const properties = (root.dokuppgift?.uppgift ?? root.dokumentuppgift?.uppgift ?? []).map((x) => ({
    code: x.kod,
    name: x.namn,
    text: x.text,
  }));
  const decisions = (root.dokutskottsforslag?.utskottsforslag ?? []).map((x) => {
    if (x.punkt < 1) throw schemaInvalid('Document decision point must be positive.');
    if (
      x.rm &&
      raw.rm &&
      parseSourceIdentity(x.rm, normalizeSession) !== parseSourceIdentity(raw.rm, normalizeSession)
    )
      identityFailure();
    if (x.bet && raw.beteckning && x.bet.toUpperCase() !== raw.beteckning.toUpperCase())
      identityFailure();
    return {
      point: x.punkt,
      heading: x.rubrik,
      proposal: x.forslag,
      decisionType: x.beslutstyp,
      voteId: x.votering_id,
      winner: x.vinnare,
      session: x.rm,
      report: x.bet,
      ...(x.votering_url_xml ? { sourceUrl: sourceUrl(x.votering_url_xml) } : {}),
      ...(x.votering_sammanfattning_html
        ? { summary: normalizeSummary(x.votering_sammanfattning_html) }
        : {}),
      counterProposalNumber: x.motforslag_nummer,
      counterProposalParties: x.motforslag_partier,
      votingRequirement: x.voteringskrav,
      decisionRuleQuota: x.beslutsregelkvot,
      decisionRuleParagraph: x.beslutsregelparagraf,
      pointType: x.punkttyp,
    };
  });
  if (new Set(decisions.map((x) => x.point)).size !== decisions.length)
    throw schemaInvalid('Document status repeats a decision point.');
  const isSfs = (raw.doktyp ?? raw.typ)?.toLowerCase() === 'sfs';
  budget.check();
  const text = isSfs ? raw.text : raw.html ? htmlToMarkdown(raw.html) : undefined;
  budget.check();
  const record = {
    metadata: {
      ...metadata(raw),
      chamberStatus: properties.find((x) => x.code === 'arendestatuskammaren')?.name,
    },
    decisions,
    reservations: (root.dokmotforslag?.motforslag ?? []).map((x) => ({
      number: x.nummer,
      heading: x.rubrik,
      parties: x.partier,
      type: x.typ,
      point: x.utskottsforslag_punkt,
    })),
    activities: (root.dokaktivitet?.aktivitet ?? []).map((x) => ({
      code: x.kod,
      name: x.namn,
      date: x.datum,
      status: x.status,
      process: x.process,
    })),
    properties,
    attachments: (root.dokbilaga?.bilaga ?? []).map((x) => ({
      title: x.titel,
      subtitle: x.subtitel,
      filename: x.filnamn,
      type: x.filtyp,
      sizeBytes: x.filstorlek,
      ...(x.fil_url ? { sourceUrl: sourceUrl(x.fil_url) } : {}),
    })),
    references: (root.dokreferens?.referens ?? []).map((x) => ({
      relationship: x.referenstyp,
      description: x.uppgift,
      ...(x.ref_dok_id
        ? { documentId: parseSourceIdentity(x.ref_dok_id, normalizeDocumentId) }
        : {}),
      documentType: x.ref_dok_typ,
      session: x.ref_dok_rm,
      designation: x.ref_dok_bet,
      title: x.ref_dok_titel,
      subtitle: x.ref_dok_subtitel,
    })),
    ...(text === undefined ? {} : { text }),
    ...(raw.html === undefined ? {} : { sourceHtml: raw.html }),
    textRepresentation: isSfs ? ('source_text' as const) : ('markdown' as const),
  };
  const revision = await revisionOf(record);
  budget.check();
  return {
    found: true,
    documentId: id,
    retrievedAt: loaded.retrievedAt,
    record: { ...record, revision },
  };
}

/** Resolve one exact committee-report designation, then load its complete decisions. */
export async function resolveReport(
  service: RiksdagService,
  session: string,
  report: string,
  budget: ToolBudget,
): Promise<DocumentStatusResult> {
  const rm = normalizeSession(session);
  const bet = normalizeReport(report, rm);
  let loaded = await service.loadJson(
    {
      path: '/dokumentlista/',
      query: { doktyp: 'bet', rm, bet, sz: 2, p: 1, utformat: 'json' },
      schema: listSchema,
      ttlMs: 120000,
      cacheable: () => false,
    },
    budget,
  );
  if (!loaded.found)
    throw schemaInvalid('Report resolution unexpectedly returned a missing response.');
  const candidates: z.infer<typeof wireDocument>[] = [];
  let page = 1;
  while (loaded.found) {
    const root: z.infer<typeof listSchema>['dokumentlista'] = loaded.data.dokumentlista;
    if (root['@sida'] !== undefined && root['@sida'] !== page) identityFailure();
    for (const row of root.dokument) {
      if (
        !row.rm ||
        parseSourceIdentity(row.rm, normalizeSession) !== rm ||
        row.beteckning?.toUpperCase() !== bet ||
        (row.doktyp ?? row.typ)?.toLowerCase() !== 'bet'
      )
        continue;
      if (
        candidates.some(
          (candidate) =>
            parseSourceIdentity(candidate.dok_id, normalizeDocumentId) ===
            parseSourceIdentity(row.dok_id, normalizeDocumentId),
        )
      )
        throw schemaInvalid('Report resolution repeats a document identity.');
      candidates.push(row);
    }
    if (candidates.length > 1)
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        'More than one exact committee report matched.',
        { reason: 'ambiguous_report' },
      );
    if (!root['@nasta_sida']) break;
    let next: URL;
    try {
      next = new URL(root['@nasta_sida'], 'https://data.riksdagen.se');
    } catch {
      throw schemaInvalid('Invalid report continuation URL.');
    }
    if (
      !['http:', 'https:'].includes(next.protocol) ||
      next.hostname !== 'data.riksdagen.se' ||
      next.pathname !== '/dokumentlista/' ||
      next.username ||
      next.password ||
      Number(next.searchParams.get('p')) !== page + 1
    )
      throw schemaInvalid('Invalid report continuation identity.');
    page += 1;
    budget.check();
    loaded = await service.loadJson(
      {
        path: '/dokumentlista/',
        query: { doktyp: 'bet', rm, bet, sz: 2, p: page, utformat: 'json' },
        schema: listSchema,
        ttlMs: 120000,
        cacheable: () => false,
      },
      budget,
    );
    if (!loaded.found)
      throw schemaInvalid('Report continuation unexpectedly returned a missing response.');
  }
  const row = candidates[0];
  if (!row) return { found: false, documentId: `${rm}:${bet}`, retrievedAt: loaded.retrievedAt };
  const result = await loadDocumentStatus(
    service,
    parseSourceIdentity(row.dok_id, normalizeDocumentId),
    budget,
  );
  if (
    result.found &&
    (result.record.metadata.session !== rm ||
      result.record.metadata.designation?.toUpperCase() !== bet ||
      result.record.metadata.documentType?.toLowerCase() !== 'bet')
  )
    identityFailure();
  return result;
}
