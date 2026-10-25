/** @fileoverview Synthetic vote records and report decisions. @module tests/services/riksdag/vote-fixtures */

/** Source-ordered synthetic decisions include explicit and unknown voting methods. */
export function voteReport(count = 4) {
  return {
    dokumentstatus: {
      dokument: { dok_id: 'HC01KU1', doktyp: 'bet', rm: '2024/25', beteckning: 'KU1' },
      dokutskottsforslag: {
        utskottsforslag: Array.from({ length: count }, (_, i) => ({
          punkt: String(i + 1),
          rubrik: `Syntetisk punkt ${i + 1}`,
          forslag: `Förslag ${i + 1}`,
          ...(i === 0
            ? { beslutstyp: 'acklamation' }
            : i === 1 || i === 3
              ? { beslutstyp: 'röstning' }
              : {}),
          rm: '2024/25',
          bet: 'KU1',
        })),
      },
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
    datum: '2025-01-02',
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

/** Route only known report endpoints; grouped data remains controlled by the test. */
export function reportFetch(
  groups: (point: number) => unknown = () => ({ voteringlista: { '@antal': '0' } }),
  count = 4,
): typeof fetch {
  return async (request) => {
    const url = new URL(String(request));
    if (url.pathname === '/dokumentstatus/HC01KU1.json') return Response.json(voteReport(count));
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
