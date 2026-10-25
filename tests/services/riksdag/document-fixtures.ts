/** @fileoverview Synthetic parliamentary wire records without live person data. @module tests/services/riksdag/document-fixtures */

/** A complete synthetic report with independent nested section collections. */
export function reportFixture(count = 3) {
  return {
    dokumentstatus: {
      dokument: {
        dok_id: 'HC01KU1',
        doktyp: 'bet',
        subtyp: 'bet',
        rm: '2024/25',
        beteckning: 'KU1',
        titel: 'Syntetisk rapport',
        status: 'Publicerad',
        datum: '2025-01-02',
        publicerad: '2025-01-02 12:00:00',
        html: '<h1>Rubrik 😀</h1><p>Första stycket.</p><p>Andra stycket.</p>',
        text: '<xml>Not plain text</xml>',
        dokument_url_html: '//data.riksdagen.se/dokument/HC01KU1',
        dokument_url_text: '/dokument/HC01KU1.text',
      },
      dokutskottsforslag: {
        utskottsforslag: Array.from({ length: count }, (_, i) => ({
          punkt: String(i + 1),
          rubrik: `Punkt ${i + 1}`,
          forslag: `<p>Förslag ${i + 1}</p>`,
          beslutstyp: i === 0 ? 'acklamation' : 'röstning',
          votering_id: `vote-${i + 1}`,
          vinnare: 'utskottet',
          rm: '2024/25',
          bet: 'KU1',
          votering_url_xml: `/votering/${i + 1}`,
        })),
      },
      dokmotforslag: {
        motforslag: Array.from({ length: count }, (_, i) => ({
          nummer: String(i + 1),
          rubrik: `Reservation ${i + 1}`,
          partier: 'S, M',
          typ: 'reservation',
          utskottsforslag_punkt: String(i + 1),
        })),
      },
      dokaktivitet: {
        aktivitet: Array.from({ length: count }, (_, i) => ({
          kod: `A${i + 1}`,
          namn: `Händelse ${i + 1}`,
          datum: '2025-01-02 12:00',
          status: 'publicerad',
          process: 'beredning',
        })),
      },
      dokuppgift: {
        uppgift: [
          { kod: 'arendestatuskammaren', namn: 'Avgjort', text: 'Kammarens uppgift' },
          ...Array.from({ length: count - 1 }, (_, i) => ({
            kod: `P${i + 2}`,
            namn: `Egenskap ${i + 2}`,
            text: `Värde ${i + 2}`,
          })),
        ],
      },
      dokbilaga: {
        bilaga: Array.from({ length: count }, (_, i) => ({
          titel: `Bilaga ${i + 1}`,
          subtitel: 'Underlag',
          filnamn: `synthetic-${i + 1}.pdf`,
          filtyp: 'pdf',
          filstorlek: '00042',
          fil_url: `https://example.test/attachment-${i + 1}.pdf`,
        })),
      },
      dokreferens: {
        referens: Array.from({ length: count }, (_, i) => ({
          referenstyp: 'behandlar',
          uppgift: 'Källrelation',
          ref_dok_id: `hc02mot${i + 1}`,
          ref_dok_typ: 'mot',
          ref_dok_rm: '2024/25',
          ref_dok_bet: String(i + 1),
          ref_dok_titel: `Motion ${i + 1}`,
          ref_dok_subtitel: 'Underrubrik',
        })),
      },
    },
  };
}
