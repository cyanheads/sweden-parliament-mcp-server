/** @fileoverview Synthetic vote records and report decisions. @module tests/services/riksdag/vote-fixtures */

/** The decision-status parts of a report status record: properties, activities, point methods. */
export interface ReportStatus {
  aktivitet?: { kod: string; namn: string; datum?: string; status: string }[];
  /** Replaces every point's beslutstyp, as an undecided report publishes it empty. */
  beslutstyp?: string;
  uppgift?: { kod: string; namn: string; text: string }[];
}

/** 2025/26:FöU17 after its decision: chamber status Beslutat and an occurred BES. */
export const DECIDED_STATUS: ReportStatus = {
  uppgift: [
    { kod: 'arendestatuskammaren', namn: 'Beslutat', text: '' },
    { kod: 'beslutdatumtid', namn: 'Datum och tid för beslutet', text: '2026-06-03 00:00:00' },
    { kod: 'statustext', namn: 'statustext', text: 'Ärendet är avslutat' },
  ],
  aktivitet: [
    { kod: 'JUS', namn: 'Justering', datum: '2026-05-26 00:00:00', status: 'inträffat' },
    { kod: 'BEH', namn: 'Behandling', datum: '2026-06-01 00:00:00', status: 'inträffat' },
    { kod: 'BES', namn: 'Beslut', datum: '2026-06-03 00:00:00', status: 'inträffat' },
  ],
};

/** 2026/27:JuU9 before its decision: a scheduled beslutdatumtid, a planned BES, empty methods. */
export const UNDECIDED_STATUS: ReportStatus = {
  uppgift: [
    { kod: 'beslutdatumtid', namn: 'Datum och tid för beslutet', text: '2026-11-25 00:00:00' },
    { kod: 'statustext', namn: 'statustext', text: 'Ärendet är klart för debatt' },
  ],
  aktivitet: [
    { kod: 'TRY', namn: 'Trycklov', datum: '2026-11-20 00:00:00', status: 'inträffat' },
    { kod: 'BEH', namn: 'Behandling', datum: '2026-11-25 00:00:00', status: 'planerat' },
    { kod: 'BES', namn: 'Beslut', datum: '2026-11-25 00:00:00', status: 'planerat' },
  ],
  beslutstyp: '',
};

/** Source-ordered synthetic decisions include explicit and unknown voting methods. */
export function voteReport(count = 4, status: ReportStatus = {}) {
  return {
    dokumentstatus: {
      dokument: { dok_id: 'HC01KU1', doktyp: 'bet', rm: '2024/25', beteckning: 'KU1' },
      dokutskottsforslag: {
        utskottsforslag: Array.from({ length: count }, (_, i) => ({
          punkt: String(i + 1),
          rubrik: `Syntetisk punkt ${i + 1}`,
          forslag: `Förslag ${i + 1}`,
          ...(status.beslutstyp !== undefined
            ? { beslutstyp: status.beslutstyp }
            : i === 0
              ? { beslutstyp: 'acklamation' }
              : i === 1 || i === 3
                ? { beslutstyp: 'röstning' }
                : {}),
          rm: '2024/25',
          bet: 'KU1',
        })),
      },
      ...(status.uppgift ? { dokuppgift: { uppgift: status.uppgift } } : {}),
      ...(status.aktivitet ? { dokaktivitet: { aktivitet: status.aktivitet } } : {}),
    },
  };
}

/** Whole synthetic member main-vote rows with independent stable identities. */
export function memberVoteRows(count = 4) {
  return Array.from({ length: count }, (_, i) => ({
    votering_id: `vote-${String(count - i).padStart(4, '0')}`,
    intressent_id: '0001',
    rm: '2024/25',
    beteckning: 'KU1',
    punkt: String(i + 1),
    systemdatum: '2025-01-02 12:00:00',
    namn: 'Synthetic Member',
    parti: 'S',
    valkrets: 'Stockholms kommun',
    rost: i % 2 === 0 ? 'Ja' : 'Avstår',
    avser: 'motivering',
    dok_id: 'HC01KU1',
    votering_url_xml: `/votering/row-${i + 1}`,
  }));
}

/** One member-0001 vote row for report `beteckning`; `systemdatum` is omitted when absent. */
export function timestampedMemberRow(
  votering_id: string,
  beteckning: string,
  punkt: string,
  avser: string,
  systemdatum?: string,
) {
  return {
    votering_id,
    intressent_id: '0001',
    rm: '2024/25',
    beteckning,
    punkt,
    avser,
    parti: 'S',
    rost: 'Ja',
    dok_id: `HC01${beteckning}`,
    ...(systemdatum ? { systemdatum } : {}),
  };
}

/** One member's rows with varied, shared and missing source timestamps, in scrambled source order. */
export function timestampedMemberRows() {
  const row = timestampedMemberRow;
  return [
    row('F', 'KU3', '1', 'sakfrågan'),
    row('A', 'KU2', '1', 'sakfrågan', '2025-01-03 10:00:00'),
    row('H', 'KU4', '2', 'sakfrågan', '2025-01-01 08:00:00'),
    row('C', 'KU1', '1', 'sakfrågan', '2025-01-02 09:00:00'),
    row('G', 'KU1', '1', 'motivfrågan'),
    row('E', 'KU1', '0', 'frågan', '2025-01-02 09:00:00'),
    row('B', 'KU1', '2', 'sakfrågan', '2025-01-02 09:00:00'),
    row('H', 'KU4', '2', 'motivfrågan', '2025-01-01 08:00:00'),
    row('D', 'FiU1', '3', 'sakfrågan', '2025-01-02 09:00:00'),
  ];
}

/**
 * One member's 2024/25 rows across reports: FöU1 points 1 and 3 (one published decomposed), a
 * point-zero `votering` row whose designation is not a report, and a row without a designation.
 */
export function memberReportRows() {
  const row = (
    votering_id: string,
    beteckning: string | undefined,
    punkt: string,
    rost: string,
    systemdatum: string,
    dok_id: string,
  ) => ({
    votering_id,
    intressent_id: '098412828516',
    rm: '2024/25',
    ...(beteckning === undefined ? {} : { beteckning }),
    punkt,
    systemdatum,
    parti: 'S',
    rost,
    avser: 'sakfrågan',
    dok_id,
  });
  return [
    row('V-KU1-1', 'KU1', '1', 'Ja', '2024-11-20 10:00:00', 'HC01KU1'),
    row('V-FOU1-3', 'FöU1', '3', 'Ja', '2024-12-04 16:16:26', 'HC01FöU1'),
    row('V-VOTERING', '0118-1', '0', 'Ja', '2025-01-18 10:00:00', 'HC010118-1'),
    row('V-FIU1-2', 'FiU1', '2', 'Nej', '2024-11-27 10:00:00', 'HC01FiU1'),
    row('V-SPARSE', undefined, '1', 'Ja', '2024-12-01 10:00:00', 'HC01SKU1'),
    row('V-FOU1-1', 'FöU1', '1', 'Nej', '2024-12-04 16:16:26', 'HC01FöU1'),
  ];
}

/**
 * Report FöU1 as Riksdagen publishes it: mixed-case designation and document ID on the list,
 * status and ballot routes, three points, and `ballotCount` ballots per point.
 */
export function publishedReportFetch(ballotCount = 3): typeof fetch {
  const document = { dok_id: 'HC01FöU1', doktyp: 'bet', rm: '2024/25', beteckning: 'FöU1' };
  return async (request) => {
    const url = new URL(String(request));
    const path = decodeURIComponent(url.pathname);
    if (path === '/dokumentlista/')
      return Response.json({ dokumentlista: { '@traffar': '1', dokument: document } });
    if (path === '/dokumentstatus/HC01FÖU1.json')
      return Response.json({
        dokumentstatus: {
          dokument: document,
          dokutskottsforslag: {
            utskottsforslag: [1, 2, 3].map((punkt) => ({
              punkt: String(punkt),
              beslutstyp: 'röstning',
              rm: '2024/25',
              bet: 'FöU1',
            })),
          },
        },
      });
    if (path === '/voteringlista/') {
      const punkt = url.searchParams.get('punkt') ?? '';
      return Response.json({
        voteringlista: {
          '@antal': String(ballotCount),
          votering: Array.from({ length: ballotCount }, (_, i) => ({
            votering_id: `V-FOU1-${punkt}`,
            intressent_id: String(i + 1).padStart(4, '0'),
            rm: '2024/25',
            beteckning: 'FöU1',
            punkt,
            parti: 'S',
            rost: 'Ja',
            avser: 'sakfrågan',
            dok_id: 'HC01FöU1',
          })),
        },
      });
    }
    throw new Error(`Unexpected synthetic route ${path}`);
  };
}

/**
 * Rows carrying every field Riksdagen publishes, at published lengths: one point's KU1 ballots
 * (one voteId, many members) or one member's session rows (many voteIds).
 */
export function publishedSizeRows(count: number, shape: 'ballots' | 'member') {
  return Array.from({ length: count }, (_, i) => {
    const voteId =
      shape === 'ballots'
        ? '0D9B5C9E-4A3B-4F7A-9C1E-2B6A8D4E7F10'
        : `0D9B5C9E-4A3B-4F7A-9C1E-${String(i).padStart(12, '0')}`;
    return {
      hangar_id: String(5296756 + i),
      votering_id: voteId,
      intressent_id: shape === 'ballots' ? String(i + 1).padStart(13, '0') : '0257612529618',
      rm: '2024/25',
      beteckning: 'KU1',
      punkt: shape === 'ballots' ? '1' : String((i % 30) + 1),
      punkttyp: 'Huvudvotering',
      systemdatum: '2024-12-04 16:16:26',
      namn: `Syntetisk Ledamot ${i}`,
      fornamn: 'Syntetisk',
      efternamn: `Ledamot ${i}`,
      parti: 'S',
      valkrets: 'Västra Götalands läns västra',
      rost: i % 3 ? 'Ja' : 'Nej',
      avser: 'sakfrågan',
      votering: 'huvud',
      dok_id: 'HC01KU1',
      votering_url_xml: `http://data.riksdagen.se/votering/${voteId}`,
    };
  });
}

/** Route only known report endpoints; grouped data remains controlled by the test. */
export function reportFetch(
  groups: (point: number) => unknown = () => ({ voteringlista: { '@antal': '0' } }),
  count = 4,
  status: ReportStatus = {},
): typeof fetch {
  return async (request) => {
    const url = new URL(String(request));
    if (url.pathname === '/dokumentstatus/HC01KU1.json')
      return Response.json(voteReport(count, status));
    if (url.pathname === '/dokumentlista/')
      return Response.json({
        dokumentlista: {
          '@traffar': '1',
          dokument: { dok_id: 'HC01KU1', doktyp: 'bet', rm: '2024/25', beteckning: 'KU1' },
        },
      });
    if (url.pathname === '/voteringlista/')
      return Response.json(groups(Number(url.searchParams.get('punkt'))));
    throw new Error(`Unexpected synthetic route ${url.pathname}`);
  };
}
