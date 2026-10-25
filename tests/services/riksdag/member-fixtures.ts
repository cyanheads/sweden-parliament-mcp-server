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
