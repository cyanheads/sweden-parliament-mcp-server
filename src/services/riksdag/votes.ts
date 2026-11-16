/**
 * @fileoverview Complete main-vote candidates and authoritative report-point hydration.
 * @module services/riksdag/votes
 */
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import { documentDecisionSchema, loadDocumentStatus, resolveReport } from './documents.js';
import {
  canonicalDocumentId,
  normalizeDocumentId,
  normalizeReport,
  normalizeSession,
} from './normalize.js';
import type { RiksdagService } from './riksdag-service.js';
import { revisionOf } from './text.js';
import type { ToolBudget } from './transport.js';
import {
  assertCompleteCandidates,
  collectionOf,
  optionalWireString,
  parseSourceIdentity,
  schemaInvalid,
  sourceUrl,
  wireCount,
} from './wire.js';

const s = optionalWireString;
const memberWire = z.object({
  votering_id: z.string().min(1),
  intressent_id: z.string().regex(/^\d+$/),
  rm: z.string().min(1),
  beteckning: s,
  punkt: wireCount.optional(),
  systemdatum: s,
  namn: s,
  parti: s,
  valkrets: s,
  rost: s,
  avser: s,
  dok_id: s,
  votering_url_xml: s,
});
const memberList = z.object({
  voteringlista: z.object({
    '@antal': wireCount.optional(),
    '@villkor': s,
    '@q': s,
    '@varning': s,
    votering: collectionOf(memberWire),
  }),
});

/** One complete published member main-vote row, without unrelated personal fields. */
export const memberVoteSchema = z
  .object({
    voteId: z.string().describe('Published main-vote identifier.'),
    memberId: z.string().describe('Numeric source member ID, retaining leading zeros.'),
    session: z.string().describe('Published parliamentary session.'),
    report: z
      .string()
      .optional()
      .describe(
        'Published designation: a committee report, or on point-zero rows a vote designation such as 0118-1.',
      ),
    point: z.number().int().positive().optional().describe('Published report point.'),
    systemDate: z
      .string()
      .optional()
      .describe(
        'Source record timestamp at published precision; it orders member-mode rows and is not the vote date.',
      ),
    name: z.string().optional().describe('Source-authored member name.'),
    party: z.string().optional().describe('Published party code for this vote.'),
    constituency: z.string().optional().describe('Published constituency.'),
    vote: z
      .string()
      .optional()
      .describe('Published vote label, without restricting its vocabulary.'),
    avser: z
      .string()
      .optional()
      .describe(
        'Whether the main vote concerns the substantive issue or motivation, as published.',
      ),
    documentId: z
      .string()
      .optional()
      .describe(
        'Linked document ID, normalized as riksdag_get_document returns it; IDs outside that format keep their published spelling.',
      ),
    sourceUrl: z.string().optional().describe('Published main-vote source link.'),
  })
  .describe('One published member main vote.');
const otherVoteSchema = z
  .object({
    vote: z.string().describe('Other published vote label.'),
    count: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Exact counted ballots with this label; absent when the group has ballots without published labels.',
      ),
  })
  .describe('A published vote label outside the four standard labels.');
/** Party aggregates count complete published ballots without inventing missing labels. */
export const partyVoteSchema = z
  .object({
    party: z.string().describe('Published party code.'),
    yes: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Exact Ja ballot count; absent when any group ballot lacks its label.'),
    no: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Exact Nej ballot count; absent when any group ballot lacks its label.'),
    abstain: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Exact Avstår ballot count; absent when any group ballot lacks its label.'),
    absent: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Exact Frånvarande ballot count; absent when any group ballot lacks its label.'),
    otherVotes: z.array(otherVoteSchema).describe('Every additional published vote-label count.'),
    observedVoteLabels: z
      .array(z.string().describe('A published ballot label.'))
      .optional()
      .describe(
        'Observed labels in an incomplete group; these observations do not establish exact totals.',
      ),
    avser: z.string().optional().describe('Published subject of this main-vote group.'),
  })
  .describe('One complete party aggregate with no invented counts.');
/** The complete source decision accompanies the main-vote data and provenance. */
export const reportPointSchema = z
  .object({
    decision: documentDecisionSchema.describe('Complete authoritative decision for this point.'),
    rollCallState: z
      .enum(['available', 'acclamation', 'not_published', 'unknown'])
      .describe(
        'Published roll-call availability; acclamation requires explicit decision evidence.',
      ),
    parties: z
      .array(partyVoteSchema)
      .describe(
        'Every identifiable party/avser aggregate derived from complete published point ballots.',
      ),
    provenance: z
      .object({
        decisionSourceUrl: z.string().describe('Authoritative report-status source.'),
        votesSourceUrl: z.string().describe('Fixed-origin complete ungrouped main-vote query.'),
        upstreamQuery: z
          .string()
          .optional()
          .describe('Published query echo, not independent identity proof.'),
        upstreamWarnings: z
          .array(z.string().describe('A published source warning.'))
          .optional()
          .describe('Every published warning for this main-vote query.'),
        retrievedAt: z.string().describe('Main-vote source-fetch time.'),
      })
      .describe('Separate authoritative decision and complete-ballot sources.'),
  })
  .describe('One report point with complete party results and source evidence.');

const sourceSession = (value: string) => parseSourceIdentity(value, normalizeSession);
const sourceReport = (value: string, session: string) =>
  parseSourceIdentity(value, (report) => normalizeReport(report, session));

const STANDARD_VOTE_LABELS = new Map<string, 'yes' | 'no' | 'abstain' | 'absent'>([
  ['Ja', 'yes'],
  ['Nej', 'no'],
  ['Avstår', 'abstain'],
  ['Frånvarande', 'absent'],
]);

function identityFailure(): never {
  throw new McpError(
    JsonRpcErrorCode.SerializationError,
    'The vote response contradicts the requested identity.',
    { reason: 'upstream_identity_mismatch' },
  );
}
function queryEcho(root: {
  '@q'?: string | undefined;
  '@villkor'?: string | undefined;
}): string | undefined {
  return root['@q'] && root['@villkor']
    ? JSON.stringify({ q: root['@q'], villkor: root['@villkor'] })
    : (root['@q'] ?? root['@villkor']);
}
function validateConditions(
  value: string | undefined,
  expected: ReadonlyMap<string, string>,
): void {
  if (!value) return;
  for (const match of value.matchAll(/(?:^|:)\s*([a-z]+)=([^:]*)(?=:|$)/g)) {
    const key = match[1];
    const actual = match[2]?.trim();
    if (
      key !== undefined &&
      expected.has(key) &&
      actual?.toUpperCase() !== expected.get(key)?.toUpperCase()
    )
      identityFailure();
  }
}
function memberRows(
  root: z.infer<typeof memberList>['voteringlista'],
  session: string,
  memberId: string | undefined,
  party?: string,
  selection?: { report: string; point: number; documentId: string },
) {
  const conditions = new Map([['rm', session]]);
  if (memberId !== undefined) conditions.set('iid', memberId);
  if (selection) {
    conditions.set('bet', selection.report);
    conditions.set('punkt', String(selection.point));
  }
  validateConditions(root['@villkor'], conditions);
  assertCompleteCandidates(root.votering, root['@antal'], (row) =>
    JSON.stringify([row.votering_id.toUpperCase(), row.intressent_id, row.avser ?? null]),
  );
  for (const row of root.votering) {
    if (
      sourceSession(row.rm) !== session ||
      (memberId !== undefined && row.intressent_id !== memberId) ||
      (party !== undefined &&
        row.parti !== undefined &&
        row.parti.toUpperCase() !== party.toUpperCase())
    )
      identityFailure();
    if (
      selection &&
      (row.beteckning === undefined ||
        sourceReport(row.beteckning, session) !== selection.report ||
        row.punkt !== selection.point ||
        row.dok_id === undefined ||
        parseSourceIdentity(row.dok_id, normalizeDocumentId) !== selection.documentId)
    )
      identityFailure();
    if (row.votering_url_xml) sourceUrl(row.votering_url_xml);
  }
  return root.votering
    .map((row) => ({
      voteId: row.votering_id,
      memberId: row.intressent_id,
      session: sourceSession(row.rm),
      report: row.beteckning,
      ...(row.punkt ? { point: row.punkt } : {}),
      systemDate: row.systemdatum,
      name: row.namn,
      party: row.parti,
      constituency: row.valkrets,
      vote: row.rost,
      avser: row.avser,
      // A linked ID outside the document grammar keeps its published spelling; a row never fails the call.
      documentId:
        row.dok_id === undefined ? undefined : (canonicalDocumentId(row.dok_id) ?? row.dok_id),
      ...(row.votering_url_xml ? { sourceUrl: sourceUrl(row.votering_url_xml) } : {}),
    }))
    .sort(selection ? ballotOrder : memberOrder);
}

type VoteRow = z.infer<typeof memberVoteSchema>;

/**
 * Comparable spelling of a published row designation. Never `normalizeReport`: point-zero rows
 * carry non-report designations such as `0118-1`.
 */
function designationKey(value: string | undefined): string | undefined {
  return value?.normalize('NFC').toUpperCase();
}

/** Code-unit order, independent of runtime collation, so revisions agree across runtimes. */
function compareText(a: string | undefined, b: string | undefined, absent: 'first' | 'last') {
  if (a === b) return 0;
  if (a === undefined) return absent === 'first' ? -1 : 1;
  if (b === undefined) return absent === 'first' ? 1 : -1;
  return a < b ? -1 : 1;
}

/**
 * Source-timestamp order: `systemDate` (rows without one last), then report (by its comparable
 * spelling), point (absent first), avser and voteId — total over the (voteId, memberId, avser)
 * identity within one member. `systemDate` is the record's source timestamp, not the vote date.
 */
function memberOrder(a: VoteRow, b: VoteRow): number {
  return (
    compareText(a.systemDate, b.systemDate, 'last') ||
    compareText(designationKey(a.report), designationKey(b.report), 'first') ||
    (a.point ?? 0) - (b.point ?? 0) ||
    compareText(a.avser, b.avser, 'first') ||
    compareText(a.voteId.toUpperCase(), b.voteId.toUpperCase(), 'first')
  );
}

/** One point's ballots: voteId, then memberId, with avser as the final identity tiebreak. */
function ballotOrder(a: VoteRow, b: VoteRow): number {
  return (
    compareText(a.voteId.toUpperCase(), b.voteId.toUpperCase(), 'first') ||
    compareText(a.memberId, b.memberId, 'first') ||
    compareText(a.avser, b.avser, 'first')
  );
}

/**
 * Acquires and validates the full bounded response before caching, revision or local filtering.
 * `selection.report` (a `normalizeReport` key) and its optional `point` narrow `rows` after the
 * party filter; `candidateCount` and `revision` keep describing the member/session set.
 */
export async function loadMemberVotes(
  service: RiksdagService,
  session: string,
  memberId: string,
  party: string | undefined,
  budget: ToolBudget,
  selection?: { report: string; point: number | undefined },
) {
  const loaded = await service.loadJson(
    {
      path: '/voteringlista/',
      query: { rm: session, iid: memberId, parti: party, sz: 50000, utformat: 'json' },
      schema: memberList,
      ttlMs: 300000,
      cacheable: (data) => {
        memberRows(data.voteringlista, session, memberId, party);
        return data.voteringlista.votering.length > 0;
      },
    },
    budget,
  );
  if (!loaded.found) throw schemaInvalid('The vote list unexpectedly returned a missing response.');
  const root = loaded.data.voteringlista;
  const candidates = memberRows(root, session, memberId, party);
  const revision = await revisionOf(candidates);
  const upstreamQuery = queryEcho(root);
  budget.check();
  const partyRows =
    party === undefined
      ? candidates
      : candidates.filter((row) => row.party?.toUpperCase() === party.toUpperCase());
  return {
    rows:
      selection === undefined
        ? partyRows
        : partyRows.filter(
            (row) =>
              designationKey(row.report) === selection.report &&
              (selection.point === undefined || row.point === selection.point),
          ),
    candidateCount: candidates.length,
    revision,
    retrievedAt: loaded.retrievedAt,
    ...(upstreamQuery ? { upstreamQuery } : {}),
    ...(root['@varning'] ? { upstreamWarnings: [root['@varning']] } : {}),
  };
}

/**
 * A direct documentId names the record being compared, so its disagreement with the requested
 * session or report is caller input. A report resolved from `report` never reaches these checks
 * disagreeing: `resolveReport` already fails it as `upstream_identity_mismatch`.
 */
function selectionMismatch(message: string, hint: string): never {
  throw validationError(message, { reason: 'invalid_filter', recovery: { hint } });
}

/**
 * Loads the authoritative full point catalog before any local page is selected. The returned
 * `report` is the published designation (`FöU1`) and `reportKey` its `normalizeReport` key. A
 * direct documentId naming a non-report, another session's report or a report disagreeing with
 * `report` throws `invalid_filter`; a status record missing type, session or designation stays
 * `upstream_identity_mismatch`.
 */
export async function loadVoteReport(
  service: RiksdagService,
  session: string,
  report: string | undefined,
  documentId: string | undefined,
  budget: ToolBudget,
) {
  const loaded = documentId
    ? await loadDocumentStatus(service, documentId, budget)
    : await resolveReport(service, session, report ?? '', budget);
  if (!loaded.found) return loaded;
  const { documentType, session: publishedSession, designation } = loaded.record.metadata;
  if (!documentType || !publishedSession || !designation) identityFailure();
  const id = loaded.documentId;
  if (documentType.toLowerCase() !== 'bet')
    selectionMismatch(
      `Document ${id} is a ${documentType} document, not a committee report (bet).`,
      `Call riksdag_get_document with documentId ${id} and sections references to list the reports that treated it (behandlas_i), then retry riksdag_get_votes with one of their documentIds; otherwise use riksdag_search_documents with documentType "bet" and session ${session}.`,
    );
  const reportSession = sourceSession(publishedSession);
  if (reportSession !== session)
    selectionMismatch(
      `Report ${id} belongs to session ${reportSession}, not ${session}.`,
      `Retry riksdag_get_votes with session ${reportSession} and the same documentId ${id}.`,
    );
  const reportKey = sourceReport(designation, session);
  if (report && reportKey !== report)
    selectionMismatch(
      `Report ${id} is report ${designation}, not ${report}.`,
      `Pass report or documentId alone: documentId ${id} selects report ${designation}.`,
    );
  const decisions = [...loaded.record.decisions].sort((a, b) => a.point - b.point);
  for (const decision of decisions) {
    if (
      (decision.session && sourceSession(decision.session) !== session) ||
      (decision.report && sourceReport(decision.report, session) !== reportKey)
    )
      identityFailure();
  }
  const revision = await revisionOf({
    documentId: loaded.documentId,
    session,
    report: reportKey,
    decisions,
  });
  budget.check();
  return { ...loaded, report: designation, reportKey, decisions, revision };
}

function pointRows(
  root: z.infer<typeof memberList>['voteringlista'],
  session: string,
  report: string,
  point: number,
  documentId: string,
) {
  return memberRows(root, session, undefined, undefined, { report, point, documentId });
}

/** Loads every validated published ballot for one authoritative report point. */
export async function loadPointBallots(
  service: RiksdagService,
  session: string,
  report: string,
  documentId: string,
  point: number,
  budget: ToolBudget,
) {
  const query = {
    rm: session,
    bet: report,
    punkt: point,
    sz: 50000,
    utformat: 'json',
  };
  const loaded = await service.loadJson(
    {
      path: '/voteringlista/',
      query,
      schema: memberList,
      ttlMs: 300000,
      cacheable: (data) => {
        pointRows(data.voteringlista, session, report, point, documentId);
        return data.voteringlista.votering.length > 0;
      },
    },
    budget,
  );
  if (!loaded.found) throw schemaInvalid('The vote list unexpectedly returned a missing response.');
  const root = loaded.data.voteringlista;
  const rows = pointRows(root, session, report, point, documentId);
  const upstreamQuery = queryEcho(root);
  budget.check();
  return {
    rows,
    retrievedAt: loaded.retrievedAt,
    sourceUrl: `https://data.riksdagen.se/voteringlista/?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))}`,
    ...(upstreamQuery ? { upstreamQuery } : {}),
    ...(root['@varning'] ? { upstreamWarnings: [root['@varning']] } : {}),
  };
}

function aggregateBallots(rows: readonly z.infer<typeof memberVoteSchema>[]) {
  const groups = new Map<
    string,
    { rows: z.infer<typeof memberVoteSchema>[]; party: string; avser?: string }
  >();
  for (const row of rows) {
    // Sparse party identities cannot establish a named party aggregate.
    if (row.party === undefined) continue;
    const key = JSON.stringify([row.party, row.avser ?? null]);
    let group = groups.get(key);
    if (!group) {
      group = {
        rows: [],
        party: row.party,
        ...(row.avser === undefined ? {} : { avser: row.avser }),
      };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()].map(({ rows: ballots, party, avser }) => {
    const complete = ballots.every((row) => row.vote !== undefined);
    const counts: { yes?: number; no?: number; abstain?: number; absent?: number } = complete
      ? { yes: 0, no: 0, abstain: 0, absent: 0 }
      : {};
    const others = new Map<string, number>();
    for (const row of ballots) {
      if (row.vote === undefined) continue;
      const key = STANDARD_VOTE_LABELS.get(row.vote);
      if (key) {
        if (complete) counts[key] = (counts[key] ?? 0) + 1;
      } else others.set(row.vote, (others.get(row.vote) ?? 0) + 1);
    }
    return {
      party,
      ...counts,
      otherVotes: [...others].map(([vote, count]) => ({ vote, ...(complete ? { count } : {}) })),
      ...(!complete
        ? {
            observedVoteLabels: [
              ...new Set(ballots.flatMap((row) => (row.vote === undefined ? [] : [row.vote]))),
            ],
          }
        : {}),
      ...(avser === undefined ? {} : { avser }),
    };
  });
}

/** Hydrates one whole point from its complete published ballots, loading them unless supplied. */
export async function hydrateVotePoint(
  service: RiksdagService,
  session: string,
  report: string,
  documentId: string,
  decision: z.infer<typeof documentDecisionSchema>,
  budget: ToolBudget,
  ballots?: Awaited<ReturnType<typeof loadPointBallots>>,
) {
  const loaded =
    ballots ??
    (await loadPointBallots(service, session, report, documentId, decision.point, budget));
  const parties = aggregateBallots(loaded.rows);
  const rollCallState =
    decision.decisionType?.toLowerCase() === 'acklamation'
      ? 'acclamation'
      : loaded.rows.length
        ? 'available'
        : decision.decisionType?.toLowerCase() === 'röstning'
          ? 'not_published'
          : 'unknown';
  budget.check();
  return {
    decision,
    rollCallState,
    parties,
    provenance: {
      decisionSourceUrl: `https://data.riksdagen.se/dokumentstatus/${documentId}.json`,
      votesSourceUrl: loaded.sourceUrl,
      ...(loaded.upstreamQuery ? { upstreamQuery: loaded.upstreamQuery } : {}),
      ...(loaded.upstreamWarnings ? { upstreamWarnings: loaded.upstreamWarnings } : {}),
      retrievedAt: loaded.retrievedAt,
    },
  } satisfies z.infer<typeof reportPointSchema>;
}
