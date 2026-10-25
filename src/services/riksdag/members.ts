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
  uppgift: collectionOf(z.union([z.string(), z.object({}).strict()]))
    .optional()
    .transform((values) =>
      (values ?? []).filter((value): value is string => typeof value === 'string'),
    ),
  intressent_id: s,
});
const memberWire = z.object({
  intressent_id: s.refine((value) => value === undefined || /^\d+$/.test(value)),
  sourceid: s,
  tilltalsnamn: s,
  efternamn: s,
  parti: s,
  valkrets: s,
  status: s,
  person_url_xml: s,
  personuppdrag: z
    .object({
      uppdrag: collectionOf(assignmentWire)
        .optional()
        .transform((rows) => rows ?? []),
    })
    .nullish(),
});
const registerWire = z.object({
  personlista: z.object({
    '@hits': wireCount,
    person: collectionOf(memberWire)
      .optional()
      .transform((rows) => rows ?? []),
  }),
});

/** Sparse public register identity; contact properties and photographs are excluded. */
export const memberSchema = z
  .object({
    memberId: z
      .string()
      .optional()
      .describe(
        'Numeric register IID, including leading zeros; absent for some European Parliament entries.',
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
function identityFailure(): never {
  throw new McpError(
    JsonRpcErrorCode.SerializationError,
    'The member register contradicts the requested identity or party.',
    { reason: 'upstream_identity_mismatch' },
  );
}
function metadata(row: z.infer<typeof memberWire>): z.infer<typeof memberSchema> {
  const names = [row.tilltalsnamn, row.efternamn].filter((name) => name !== undefined);
  return {
    memberId: row.intressent_id,
    sourceRecordId: row.sourceid,
    detailAvailable: row.intressent_id !== undefined,
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
function validate(
  root: z.infer<typeof registerWire>['personlista'],
  party?: string,
  memberId?: string,
): void {
  if (root['@hits'] !== root.person.length)
    throw schemaInvalid('Member register hit count contradicts its returned rows.');
  if (root.person.length >= 50_000)
    throw new McpError(
      JsonRpcErrorCode.ValidationError,
      'The complete member candidate boundary was reached.',
      { reason: 'candidate_limit_reached' },
    );
  const seen = new Set<string>();
  for (const row of root.person) {
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
    for (const assignment of row.personuppdrag?.uppdrag ?? [])
      if (assignment.intressent_id !== undefined && assignment.intressent_id !== row.intressent_id)
        identityFailure();
  }
  if (memberId !== undefined && root.person.length > 1) identityFailure();
}

/** Fetches one complete service register; @hits counts this returned register, unlike @antal. */
export async function loadMembers(
  service: RiksdagService,
  budget: ToolBudget,
  filters: { party?: string; memberId?: string } = {},
) {
  const loaded = await service.loadJson(
    {
      path: '/personlista/',
      query: { rdlstatus: 'tjanst', utformat: 'json', parti: filters.party, iid: filters.memberId },
      schema: registerWire,
      ttlMs: 300000,
      cacheable: (data) => {
        validate(data.personlista, filters.party, filters.memberId);
        return data.personlista.person.length > 0;
      },
    },
    budget,
  );
  if (!loaded.found)
    throw schemaInvalid('Member register unexpectedly returned a missing HTTP response.');
  validate(loaded.data.personlista, filters.party, filters.memberId);
  const records = loaded.data.personlista.person.map((row) => ({
    ...metadata(row),
    assignments: (row.personuppdrag?.uppdrag ?? []).map((assignment) => ({
      organ: assignment.organ_kod,
      role: assignment.roll_kod,
      status: assignment.status,
      type: assignment.typ,
      from: assignment.from,
      to: assignment.tom,
      descriptions: assignment.uppgift,
    })),
  }));
  budget.check();
  return { records, retrievedAt: loaded.retrievedAt };
}
