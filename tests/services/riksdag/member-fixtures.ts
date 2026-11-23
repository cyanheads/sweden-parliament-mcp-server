/** @fileoverview Synthetic member register records and ordered assignments. @module tests/services/riksdag/member-fixtures */

/** Sparse fictional register rows covering each relevant service-status category. */
export function memberRows() {
  return [
    {
      intressent_id: '0004',
      sourceid: 'synthetic-4',
      tilltalsnamn: 'Åsa',
      efternamn: 'Öberg Synthetic',
      parti: 'S',
      valkrets: 'Stockholms kommun',
      status: 'Statsråd',
    },
    {
      intressent_id: '0002',
      sourceid: 'synthetic-2',
      tilltalsnamn: 'Åsa',
      efternamn: 'Öberg Synthetic',
      parti: 'S',
      valkrets: 'Stockholms kommun',
      status: 'Förste vice talman (tjänstgörande riksdagsledamot)',
    },
    {
      intressent_id: '0003',
      sourceid: 'synthetic-3',
      tilltalsnamn: 'Åsa',
      efternamn: 'Andersson Synthetic',
      parti: 'S',
      valkrets: 'Stockholms län',
      status: 'Tidigare riksdagsledamot',
    },
    {
      intressent_id: '0001',
      sourceid: 'synthetic-1',
      tilltalsnamn: 'Åsa',
      efternamn: 'Öberg Synthetic',
      parti: 'S',
      valkrets: 'Stockholms kommun',
      status: 'Tjänstgörande riksdagsledamot',
    },
  ];
}

/** The `@systemdatum` every synthetic roster response carries. */
export const SOURCE_TIME = '2026-11-23 15:53:11';

/** One assignment as the register publishes it, including fields the server ignores. */
function assignment(iid: string, organ: string, role: string, from: string, tom: string) {
  return {
    organ_kod: organ,
    roll_kod: role,
    ordningsnummer: '0',
    status: '',
    typ: 'uppdrag',
    from,
    tom,
    uppgift: [`Synthetic ${organ} description`],
    intressent_id: iid,
    hangar_id: '5000000',
    sortering: '40',
  };
}

function rosterPerson(
  iid: string,
  given: string,
  family: string,
  sortName: string,
  party: string,
  constituency: string,
  status: string,
  uppdrag: ReturnType<typeof assignment>[],
) {
  const sourceid = `00000000-0000-4000-8000-00000000${iid}`;
  return {
    hangar_guid: `10000000-0000-4000-8000-00000000${iid}`,
    sourceid,
    intressent_id: iid,
    hangar_id: '5000000',
    fodd_ar: '1980',
    kon: 'kvinna',
    efternamn: family,
    tilltalsnamn: given,
    sorteringsnamn: sortName,
    iort: '',
    parti: party,
    valkrets: constituency,
    status,
    person_url_xml: `https://data.riksdagen.se/person/${sourceid}`,
    personuppdrag: {
      uppdrag: [
        {
          ...assignment(
            iid,
            'kam',
            'Riksdagsledamot',
            '2026-09-28 11:00:00',
            '2030-09-23 10:59:00',
          ),
          typ: 'kammaruppdrag',
          uppgift: [{}],
        },
        ...uppdrag,
      ],
    },
  };
}

/**
 * Register rows shaped like a `personlista` committee response at {@link SOURCE_TIME}: a current and
 * a past stint, a duplicated current assignment, a date-only end on the source day, a same-day role
 * change, and (`0105`) only past and future assignments. `organ` is the code as `personuppdrag`
 * spells it, which can differ in case from the committee code (`MJU`, `EUN`).
 */
export function rosterRows(organ = 'FiU') {
  return [
    rosterPerson(
      '0101',
      'Anna',
      'Palmén Synthetic',
      'Palmén Synthetic,Anna',
      'S',
      'Stockholms kommun',
      'Tjänstgörande riksdagsledamot',
      [
        assignment('0101', organ, 'Suppleant', '2026-10-06 11:00:00', '2030-10-01 10:59:00'),
        assignment('0101', organ, 'Ledamot', '2022-10-04', '2026-09-26'),
      ],
    ),
    rosterPerson(
      '0102',
      'Bertil',
      'Synthetic',
      'Synthetic,Bertil',
      'SD',
      'Skåne läns västra',
      'Tjänstgörande riksdagsledamot',
      [
        assignment('0102', organ, 'Suppleant', '2026-10-06 11:00:00', '2030-10-01 10:59:00'),
        assignment('0102', organ, 'Suppleant', '2026-10-06 11:00:00', '2030-10-01 10:59:00'),
      ],
    ),
    rosterPerson(
      '0103',
      'Cecilia',
      'von Synthetic',
      'Synthetic,Cecilia',
      'S',
      'Stockholms län',
      'Tjänstgörande ersättare',
      [assignment('0103', organ, 'Extra suppleant', '2026-11-01', '2026-11-23')],
    ),
    rosterPerson(
      '0104',
      'David',
      'Synthetic',
      'Synthetic,David',
      'M',
      'Stockholms kommun',
      'Tidigare riksdagsledamot',
      [
        assignment('0104', organ, 'Ledamot', '2026-10-06 11:00:00', '2026-10-06 11:30:00'),
        assignment('0104', organ, 'Ordförande', '2026-10-06 11:31:00', '2030-09-23 10:59:00'),
      ],
    ),
  ];
}

/** A roster row whose assignments in `organ` ended the day before {@link SOURCE_TIME} or start after it. */
export function rosterRowWithoutCurrentAssignment(organ = 'FiU') {
  return rosterPerson(
    '0105',
    'Eva',
    'Synthetic',
    'Synthetic,Eva',
    'S',
    'Stockholms kommun',
    'Tjänstgörande riksdagsledamot',
    [
      assignment('0105', organ, 'Ledamot', '2018-09-24', '2026-11-22'),
      assignment('0105', organ, 'Suppleant', '2026-11-24 00:00:00', '2030-10-01 10:59:00'),
    ],
  );
}

/** One assignment as the tool returns it, matching {@link rosterRows} entries in `organ`. */
export function rosterAssignment(role: string, from: string, to: string, organ = 'FiU') {
  return {
    organ,
    role,
    type: 'uppdrag',
    from,
    to,
    descriptions: [`Synthetic ${organ} description`],
  };
}

/** A `personlista` payload carrying {@link SOURCE_TIME}; `hits` defaults to the row count. */
export function registerPayload(person: unknown[], hits = person.length) {
  return { personlista: { '@systemdatum': SOURCE_TIME, '@hits': String(hits), person } };
}

/** Ordered synthetic history; date values deliberately do not imply service status. */
export function memberDetail(count = 3) {
  return {
    intressent_id: '0001',
    sourceid: 'synthetic-1',
    tilltalsnamn: 'Synthetic',
    efternamn: 'Member',
    parti: 'S',
    valkrets: 'Stockholms kommun',
    status: 'Tidigare riksdagsledamot',
    personuppdrag: {
      uppdrag: Array.from({ length: count }, (_, i) => ({
        organ_kod: `ORG${count - i}`,
        roll_kod: `Roll ${i + 1}`,
        status: 'Publicerad',
        typ: 'uppdrag',
        from: `2020-01-0${(i % 9) + 1} 12:00:00`,
        tom: '2099-12-31',
        uppgift: [`Beskrivning ${i + 1}`, `Detalj ${i + 1}`],
        intressent_id: '0001',
      })),
    },
  };
}
