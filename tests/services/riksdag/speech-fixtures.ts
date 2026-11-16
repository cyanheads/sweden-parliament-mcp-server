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

/**
 * Related-document links shaped like the 2024/25 session: a report debate linked in the source's
 * mixed case (16 speeches on HC01FöU1), an interpellation debate (9 on HC10698) and a joint
 * interpellation debate whose speeches each link three documents (10).
 */
export const relatedGroups = [
  { relDokId: 'HC01FöU1', count: 16 },
  { relDokId: 'HC10698', count: 9 },
  { relDokId: 'HC10134, HC10150, HC10163', count: 10 },
  { relDokId: 'HC01KU1', count: 3 },
  { relDokId: 'okänd länk', count: 1 },
  { relDokId: undefined, count: 2 },
] as const;

/** Synthetic speech rows numbered 1..41 in {@link relatedGroups} order, each with its group's link. */
export function relatedSpeechRows() {
  return relatedGroups
    .flatMap(({ relDokId, count }) => Array.from({ length: count }, () => relDokId))
    .map((relDokId, index) => ({
      ...speechRow(index + 1),
      ...(relDokId === undefined ? {} : { rel_dok_id: relDokId }),
    }));
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
