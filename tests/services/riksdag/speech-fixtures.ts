/** @fileoverview Synthetic speech wire records; no live person records. @module tests/services/riksdag/speech-fixtures */

/** Stable synthetic protocol identities and sparse published values. */
export function speechRow(number = 1) {
  return {
    dok_id: 'HC091',
    anforande_nummer: String(number),
    dok_rm: '2024/25',
    anforande_id: `synthetic-uuid-${number}`,
    intressent_id: '0001',
    parti: 'S',
    talare: 'Synthetic Speaker',
    avsnittsrubrik: 'Åtgärder för miljön',
    underrubrik: 'Östersjön och klimat',
    replik: 'N',
    anforandetext: '',
    anforande_url_xml: `//data.riksdagen.se/anforande/HC091-${number}`,
    anforande_url_html: `//data.riksdagen.se/anforande/HC091-${number}/html`,
    protokoll_url_www: '//www.riksdagen.se/sv/dokument-och-lagar/protokoll/#1',
  };
}

/** A complete synthetic candidate response, optionally using singleton wire shape. */
export function speechList(count = 3) {
  return {
    anforandelista: {
      '@antal': String(count),
      anforande: Array.from({ length: count }, (_, index) => speechRow(index + 1)),
    },
  };
}
