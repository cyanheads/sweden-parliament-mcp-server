/** @fileoverview Complete member-register acquisition and sparse assignment normalization. @module services/riksdag/members */
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { RiksdagService } from './riksdag-service.js';
import type { ToolBudget } from './transport.js';
import {
  collectionOf,
  optionalWireString as s,
  schemaInvalid,
  sourceUrl,
  wireCount,
} from './wire.js';

const assignmentWire = z.object({
  organ_kod: s,
  roll_kod: s,
  status: s,
  typ: s,
  from: s,
  tom: s,
  uppgift: collectionOf(z.union([z.string(), z.object({}).strict()])).transform((values) =>
    values.filter((value): value is string => typeof value === 'string'),
  ),
  intressent_id: s,
});
const memberWire = z.object({
  intressent_id: s.refine(
    (value) => value === undefined || /^\d+$/.test(value) || z.uuid().safeParse(value).success,
  ),
  sourceid: s,
  tilltalsnamn: s,
  efternamn: s,
  parti: s,
  valkrets: s,
  status: s,
  person_url_xml: s,
  personuppdrag: z
    .object({
      uppdrag: collectionOf(assignmentWire),
    })
    .nullish()
    .or(z.literal('').transform(() => undefined)),
});
const registerWire = z.object({
  personlista: z.object({
    /** Source time; read only to select current committee assignments. */
    '@systemdatum': s,
    '@hits': wireCount,
    person: collectionOf(memberWire),
  }),
});
type Register = z.infer<typeof registerWire>['personlista'];
type AssignmentWire = z.infer<typeof assignmentWire>;

/** Register request filters, each sent upstream. */
export interface MemberFilters {
  /** Committee code, sent as `org`; the source returns its current holders in either register. */
  committee?: string | undefined;
  /** Sort-name prefix, sent as `enamn`. */
  familyNamePrefix?: string | undefined;
  memberId?: string | undefined;
  party?: string | undefined;
  register?: 'service' | 'all' | undefined;
}

/** Sparse public register identity; contact properties and photographs are excluded. */
export const memberSchema = z
  .object({
    memberId: z
      .string()
      .optional()
      .describe(
        'Numeric register IID, including leading zeros; absent for some historical and European Parliament entries.',
      ),
    sourceRecordId: z
      .string()
      .optional()
      .describe('Source register UUID, distinct from the member IID.'),
    detailAvailable: z
      .boolean()
      .describe('Whether a numeric member IID is published for riksdag_get_member.'),
    name: z.string().optional().describe('Published given and family names, when present.'),
    givenName: z.string().optional().describe('Published given name.'),
    familyName: z.string().optional().describe('Published family name.'),
    party: z.string().optional().describe('Published party code.'),
    constituency: z.string().optional().describe('Published constituency label.'),
    status: z.string().optional().describe('Unmodified source service-status label.'),
    serviceClassification: z
      .enum(['serving', 'not_serving', 'unknown'])
      .describe('Source-defined Swedish chamber service; unknown is retained.'),
    sourceUrl: z.string().describe('Public register source URL.'),
  })
  .describe('Public member register metadata.');
/** Published assignment history, retaining source order and date precision. */
export const assignmentSchema = z
  .object({
    organ: z.string().optional().describe('Source organ code.'),
    role: z.string().optional().describe('Source role label.'),
    status: z.string().optional().describe('Source assignment status.'),
    type: z.string().optional().describe('Source assignment type.'),
    from: z
      .string()
      .optional()
      .describe('Source start date or timestamp, without inferred timezone.'),
    to: z
      .string()
      .optional()
      .describe('Source end date or timestamp; not proof of current service.'),
    descriptions: z
      .array(z.string().describe('Unmodified assignment description.'))
      .describe('Published descriptions in source order.'),
  })
  .describe('A published assignment.');

function classification(status: string | undefined): 'serving' | 'not_serving' | 'unknown' {
  if (
    status === 'Tjänstgörande riksdagsledamot' ||
    status === 'Tjänstgörande ersättare' ||
    status === 'Tjänstgörande statsrådsersättare' ||
    status === 'Tjänstgörande talmansersättare' ||
    status?.endsWith('(tjänstgörande riksdagsledamot)')
  )
    return 'serving';
  if (
    status !== undefined &&
    [
      'Tidigare ersättare',
      'Tidigare riksdagsledamot',
      'Tillgänglig ersättare',
      'Tidigare statsråd',
      'Europaparlamentariker',
      'Tidigare europaparlamentariker',
    ].includes(status)
  )
    return 'not_serving';
  return 'unknown';
}
function identityFailure(
  message = 'The member register contradicts the requested identity or party.',
): never {
  throw new McpError(JsonRpcErrorCode.SerializationError, message, {
    reason: 'upstream_identity_mismatch',
  });
}

/** `@systemdatum` and assignment bounds share one fixed-width form, so string order is time order. */
const SOURCE_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const ASSIGNMENT_BOUND = /^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?$/;

/** `personuppdrag` spells some organ codes in another case than `org` takes (`MJU`, `EUN`). */
function inCommittee(assignment: AssignmentWire, committee: string): boolean {
  return assignment.organ_kod?.toLowerCase() === committee.toLowerCase();
}

/** The interval contains the source time; a date-only end lasts through that day and an absent bound is open. */
function currentAt({ from, tom }: AssignmentWire, sourceTime: string): boolean {
  return (
    (from === undefined || from <= sourceTime) &&
    (tom === undefined || (tom.length === 10 ? tom >= sourceTime.slice(0, 10) : tom >= sourceTime))
  );
}

function assignmentOf(assignment: AssignmentWire): z.infer<typeof assignmentSchema> {
  return {
    organ: assignment.organ_kod,
    role: assignment.roll_kod,
    status: assignment.status,
    type: assignment.typ,
    from: assignment.from,
    to: assignment.tom,
    descriptions: assignment.uppgift,
  };
}
function metadata(row: z.infer<typeof memberWire>): z.infer<typeof memberSchema> {
  const names = [row.tilltalsnamn, row.efternamn].filter((name) => name !== undefined);
  const memberId =
    row.intressent_id !== undefined && /^\d+$/.test(row.intressent_id)
      ? row.intressent_id
      : undefined;
  return {
    memberId,
    sourceRecordId: row.sourceid ?? (memberId === undefined ? row.intressent_id : undefined),
    detailAvailable: memberId !== undefined,
    name: names.length ? names.join(' ') : undefined,
    givenName: row.tilltalsnamn,
    familyName: row.efternamn,
    party: row.parti,
    constituency: row.valkrets,
    status: row.status,
    serviceClassification: classification(row.status),
    sourceUrl: row.person_url_xml
      ? sourceUrl(row.person_url_xml)
      : row.sourceid
        ? `https://data.riksdagen.se/person/${row.sourceid}`
        : `https://data.riksdagen.se/personlista/?iid=${row.intressent_id}&rdlstatus=tjanst&utformat=json`,
  };
}
/** A committee response's `@hits` counts assignments, not people, so only plain service lists are count-checked. */
function validate(root: Register, filters: MemberFilters): void {
  const { committee, memberId, party } = filters;
  if (filters.register !== 'all' && committee === undefined && root['@hits'] !== root.person.length)
    throw schemaInvalid('Member register hit count contradicts its returned rows.');
  if (
    committee !== undefined &&
    root.person.length > 0 &&
    !SOURCE_TIME.test(root['@systemdatum'] ?? '')
  )
    throw schemaInvalid('Committee roster lacks a valid source time.');
  if (root.person.length >= 50_000)
    throw new McpError(
      JsonRpcErrorCode.ValidationError,
      'The complete member candidate boundary was reached.',
      { reason: 'candidate_limit_reached' },
    );
  const seen = new Set<string>();
  for (const row of root.person) {
    if (
      row.intressent_id !== undefined &&
      !/^\d+$/.test(row.intressent_id) &&
      row.sourceid !== row.intressent_id
    )
      throw schemaInvalid('Historical member UUID contradicts its source identity.');
    if (
      row.intressent_id !== undefined &&
      !/^\d+$/.test(row.intressent_id) &&
      row.person_url_xml !== undefined &&
      sourceUrl(row.person_url_xml) !== `https://data.riksdagen.se/person/${row.intressent_id}`
    )
      identityFailure();
    const identity = row.intressent_id ?? row.sourceid;
    if (identity === undefined)
      throw schemaInvalid('Member register row lacks both IID and source record identity.');
    if (seen.has(identity)) throw schemaInvalid('Member register contains duplicate IIDs.');
    seen.add(identity);
    if (
      (party !== undefined && row.parti !== party) ||
      (memberId !== undefined && row.intressent_id !== memberId)
    )
      identityFailure();
    metadata(row);
    const assignments = row.personuppdrag?.uppdrag ?? [];
    for (const assignment of assignments)
      if (assignment.intressent_id !== undefined && assignment.intressent_id !== row.intressent_id)
        identityFailure();
    if (committee === undefined) continue;
    const held = assignments.filter((assignment) => inCommittee(assignment, committee));
    if (!held.length)
      identityFailure(
        'The member register returned a row with no assignment in the requested committee.',
      );
    for (const { from, tom } of held)
      if (
        (from !== undefined && !ASSIGNMENT_BOUND.test(from)) ||
        (tom !== undefined && !ASSIGNMENT_BOUND.test(tom))
      )
        throw schemaInvalid('Committee assignment bound is not a source date or timestamp.');
  }
  if (memberId !== undefined && root.person.length > 1) identityFailure();
}

/**
 * Fetches the selected register; source-reported hits remain distinct from returned rows. With
 * `committee`, each record also carries its assignments in that committee current at the
 * response's source time.
 */
export async function loadMembers(
  service: RiksdagService,
  budget: ToolBudget,
  filters: MemberFilters = {},
) {
  const { committee } = filters;
  const loaded = await service.loadJson(
    {
      path: '/personlista/',
      query: {
        rdlstatus: filters.register === 'all' ? 'samtliga' : 'tjanst',
        utformat: 'json',
        parti: filters.party,
        iid: filters.memberId,
        org: committee,
        enamn: filters.familyNamePrefix,
      },
      schema: registerWire,
      ttlMs: 300000,
      cacheable: (data) => {
        validate(data.personlista, filters);
        return data.personlista.person.length > 0;
      },
    },
    budget,
  );
  if (!loaded.found)
    throw schemaInvalid('Member register unexpectedly returned a missing HTTP response.');
  const register = loaded.data.personlista;
  validate(register, filters);
  const sourceTime = register['@systemdatum'];
  const records = register.person.map((row) => {
    const assignments = row.personuppdrag?.uppdrag ?? [];
    return {
      ...metadata(row),
      assignments: assignments.map(assignmentOf),
      // validate() requires a source time on every committee response that has rows.
      ...(committee === undefined || sourceTime === undefined
        ? {}
        : {
            committeeAssignments: assignments
              .filter(
                (assignment) =>
                  inCommittee(assignment, committee) && currentAt(assignment, sourceTime),
              )
              .map(assignmentOf),
          }),
    };
  });
  budget.check();
  return {
    records,
    sourceReportedCount: register['@hits'],
    sourceTime,
    retrievedAt: loaded.retrievedAt,
  };
}
