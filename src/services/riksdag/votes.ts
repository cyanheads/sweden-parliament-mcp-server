/**
 * @fileoverview Complete main-vote candidates and authoritative report-point hydration.
 * @module services/riksdag/votes
 */
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { documentDecisionSchema, loadDocumentStatus, resolveReport } from './documents.js';
import { normalizeReport, normalizeSession } from './normalize.js';
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
  datum: s,
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
    votering: collectionOf(memberWire)
      .optional()
      .transform((rows) => rows ?? []),
  }),
});
const groupedWire = z
  .object({ parti: z.string().min(1), rm: s, bet: s, beteckning: s, punkt: s, avser: s })
  .catchall(z.string().nullish());
const groupedList = z.object({
  voteringlista: z.object({
    '@antal': wireCount.optional(),
    '@villkor': s,
    '@q': s,
    '@varning': s,
    votering: collectionOf(groupedWire)
      .optional()
      .transform((rows) => rows ?? []),
  }),
});

/** One complete published member main-vote row, without unrelated personal fields. */
export const memberVoteSchema = z
  .object({
    voteId: z.string().describe('Published main-vote identifier.'),
    memberId: z.string().describe('Numeric source member ID, retaining leading zeros.'),
    session: z.string().describe('Published parliamentary session.'),
    report: z.string().optional().describe('Published committee-report designation.'),
    point: z.number().int().positive().optional().describe('Published report point.'),
    date: z.string().optional().describe('Vote date at source precision.'),
    systemDate: z.string().optional().describe('Source system timestamp at published precision.'),
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
    documentId: z.string().optional().describe('Published linked report document ID.'),
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
      .describe('Published count; absent when its source cell is blank.'),
  })
  .describe('A published vote label outside the four standard labels.');
/** Complete party aggregates retain sparse cells and any additional vote labels. */
export const partyVoteSchema = z
  .object({
    party: z.string().describe('Published party code.'),
    yes: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Published Ja count; absent is not zero.'),
    no: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Published Nej count; absent is not zero.'),
    abstain: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Published Avstår count; absent is not zero.'),
    absent: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Published Frånvarande count; absent is not zero.'),
    otherVotes: z.array(otherVoteSchema).describe('Every additional published vote-label count.'),
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
    parties: z.array(partyVoteSchema).describe('Every party aggregate returned for this point.'),
    provenance: z
      .object({
        decisionSourceUrl: z.string().describe('Authoritative report-status source.'),
        votesSourceUrl: z.string().describe('Fixed-origin grouped main-vote query.'),
        upstreamQuery: z
          .string()
          .optional()
          .describe('Published query echo, not independent identity proof.'),
        upstreamWarnings: z
          .array(z.string().describe('A published source warning.'))
          .optional()
          .describe('Every published warning for this grouped main-vote query.'),
        retrievedAt: z.string().describe('Grouped-vote source-fetch time.'),
      })
      .describe('Separate authoritative decision and grouped-vote sources.'),
  })
  .describe('One report point with complete party results and source evidence.');

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
  memberId: string,
  party?: string,
) {
  validateConditions(
    root['@villkor'],
    new Map([
      ['rm', session],
      ['iid', memberId],
    ]),
  );
  assertCompleteCandidates(
    root.votering,
    root['@antal'],
    (row) => `${row.votering_id.toUpperCase()}:${row.intressent_id}`,
  );
  for (const row of root.votering) {
    if (
      parseSourceIdentity(row.rm, normalizeSession) !== session ||
      row.intressent_id !== memberId ||
      (party !== undefined &&
        row.parti !== undefined &&
        row.parti.toUpperCase() !== party.toUpperCase())
    )
      identityFailure();
    if (row.punkt !== undefined && row.punkt < 1)
      throw schemaInvalid('A vote point is not positive.');
    if (row.votering_url_xml) sourceUrl(row.votering_url_xml);
  }
  return root.votering
    .map((row) => ({
      voteId: row.votering_id,
      memberId: row.intressent_id,
      session: parseSourceIdentity(row.rm, normalizeSession),
      report: row.beteckning,
      point: row.punkt,
      date: row.datum,
      systemDate: row.systemdatum,
      name: row.namn,
      party: row.parti,
      constituency: row.valkrets,
      vote: row.rost,
      avser: row.avser,
      documentId: row.dok_id,
      ...(row.votering_url_xml ? { sourceUrl: sourceUrl(row.votering_url_xml) } : {}),
    }))
    .sort((a, b) =>
      `${a.voteId.toUpperCase()}:${a.memberId}`.localeCompare(
        `${b.voteId.toUpperCase()}:${b.memberId}`,
      ),
    );
}

/** Acquires and validates the full bounded response before caching, revision or local filtering. */
export async function loadMemberVotes(
  service: RiksdagService,
  session: string,
  memberId: string,
  party: string | undefined,
  budget: ToolBudget,
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
  budget.check();
  return {
    rows:
      party === undefined
        ? candidates
        : candidates.filter((row) => row.party?.toUpperCase() === party.toUpperCase()),
    candidateCount: candidates.length,
    revision,
    retrievedAt: loaded.retrievedAt,
    ...(queryEcho(root) ? { upstreamQuery: queryEcho(root) } : {}),
    ...(root['@varning'] ? { upstreamWarnings: [root['@varning']] } : {}),
  };
}

/** Loads the authoritative full point catalog before any local page is selected. */
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
  const metadata = loaded.record.metadata;
  if (
    !metadata.session ||
    parseSourceIdentity(metadata.session, normalizeSession) !== session ||
    metadata.documentType?.toLowerCase() !== 'bet' ||
    !metadata.designation ||
    (report &&
      parseSourceIdentity(metadata.designation, (value) => normalizeReport(value, session)) !==
        report)
  )
    identityFailure();
  const designation = parseSourceIdentity(metadata.designation, (value) =>
    normalizeReport(value, session),
  );
  const decisions = [...loaded.record.decisions].sort((a, b) => a.point - b.point);
  for (const decision of decisions) {
    if (
      (decision.session && parseSourceIdentity(decision.session, normalizeSession) !== session) ||
      (decision.report &&
        parseSourceIdentity(decision.report, (value) => normalizeReport(value, session)) !==
          designation)
    )
      identityFailure();
  }
  const revision = await revisionOf({
    documentId: loaded.documentId,
    session,
    report: designation,
    decisions,
  });
  budget.check();
  return { ...loaded, report: designation, decisions, revision };
}

function groupedRows(
  root: z.infer<typeof groupedList>['voteringlista'],
  session: string,
  report: string,
  point: number,
) {
  validateConditions(
    root['@villkor'],
    new Map([
      ['rm', session],
      ['bet', report],
      ['punkt', String(point)],
    ]),
  );
  if (root.votering.length >= 500 || (root['@antal'] !== undefined && root['@antal'] >= 500))
    throw new McpError(
      JsonRpcErrorCode.ValidationError,
      'The grouped vote boundary was reached; complete party groups cannot be returned for this selection.',
      { reason: 'candidate_limit_reached' },
    );
  if (root['@antal'] === undefined || root['@antal'] !== root.votering.length)
    throw schemaInvalid('The grouped vote count does not match its returned rows.');
  const seen = new Set<string>();
  const reserved = new Set(['parti', 'rm', 'bet', 'beteckning', 'punkt', 'avser']);
  const labels = new Map<string, 'yes' | 'no' | 'abstain' | 'absent'>([
    ['Ja', 'yes'],
    ['Nej', 'no'],
    ['Avstår', 'abstain'],
    ['Frånvarande', 'absent'],
  ] as const);
  return root.votering.map((row) => {
    if (seen.has(row.parti)) throw schemaInvalid('The grouped response repeats a party.');
    seen.add(row.parti);
    if (
      (row.rm && parseSourceIdentity(row.rm, normalizeSession) !== session) ||
      ((row.bet ?? row.beteckning) &&
        parseSourceIdentity(row.bet ?? row.beteckning ?? '', (value) =>
          normalizeReport(value, session),
        ) !== report) ||
      (row.punkt && row.punkt !== String(point))
    )
      identityFailure();
    const counts: { yes?: number; no?: number; abstain?: number; absent?: number } = {};
    const otherVotes: z.infer<typeof otherVoteSchema>[] = [];
    for (const [vote, raw] of Object.entries(row)) {
      if (reserved.has(vote)) continue;
      const parsed =
        raw === null || raw === undefined || raw.trim() === ''
          ? undefined
          : wireCount.safeParse(raw);
      if (parsed !== undefined && !parsed.success)
        throw schemaInvalid('A grouped vote count is not a nonnegative integer.');
      const count = parsed?.data;
      const key = labels.get(vote);
      if (key) {
        if (count !== undefined) counts[key] = count;
      } else otherVotes.push({ vote, ...(count === undefined ? {} : { count }) });
    }
    return { party: row.parti, ...counts, otherVotes, ...(row.avser ? { avser: row.avser } : {}) };
  });
}

/** Hydrates one whole point; caller retains every hydrated point even if it exceeds the target. */
export async function hydrateVotePoint(
  service: RiksdagService,
  session: string,
  report: string,
  documentId: string,
  decision: z.infer<typeof documentDecisionSchema>,
  budget: ToolBudget,
) {
  const query = {
    rm: session,
    bet: report,
    punkt: decision.point,
    gruppering: 'parti',
    sz: 500,
    utformat: 'json',
  };
  const loaded = await service.loadJson(
    {
      path: '/voteringlista/',
      query,
      schema: groupedList,
      ttlMs: 300000,
      cacheable: (data) => {
        groupedRows(data.voteringlista, session, report, decision.point);
        return data.voteringlista.votering.length > 0;
      },
    },
    budget,
  );
  if (!loaded.found) throw schemaInvalid('Grouped votes unexpectedly returned a missing response.');
  const root = loaded.data.voteringlista;
  const parties = groupedRows(root, session, report, decision.point);
  const rollCallState =
    decision.decisionType?.toLowerCase() === 'acklamation'
      ? 'acclamation'
      : parties.length
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
      votesSourceUrl: `https://data.riksdagen.se/voteringlista/?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))}`,
      ...(queryEcho(root) ? { upstreamQuery: queryEcho(root) } : {}),
      ...(root['@varning'] ? { upstreamWarnings: [root['@varning']] } : {}),
      retrievedAt: loaded.retrievedAt,
    },
  } satisfies z.infer<typeof reportPointSchema>;
}
