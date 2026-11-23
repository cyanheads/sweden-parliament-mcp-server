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

/** A session-list row with the published date-only `dok_datum` and dated protocol link. */
export function publishedListRow(number = 1) {
  return {
    ...speechRow(number),
    dok_titel: 'Protokoll 2024/25:1 Tisdagen den 10 september',
    dok_datum: '2024-09-10',
    protokoll_url_www: `https://www.riksdagen.se/sv/dokument-och-lagar/dokument/protokoll/protokoll-2024251-tisdagen-den-10-september_HC091/#anf${number}`,
  };
}

/** A row without the `anforande_url_*` links, which detail records never publish. */
function withoutRowLinks<T extends ReturnType<typeof speechRow>>(row: T) {
  const { anforande_url_xml: _xml, anforande_url_html: _html, ...detail } = row;
  return detail;
}

/**
 * The detail record the source serves for a list row: `dok_datum` with a `00:00:00` time, the short
 * protocol link, and no `anforande_url_xml` or `anforande_url_html`.
 */
export function detailRecord(row: ReturnType<typeof publishedListRow>) {
  return {
    ...withoutRowLinks(row),
    dok_datum: `${row.dok_datum} 00:00:00`,
    protokoll_url_www: `https://www.riksdagen.se/sv/dokument-och-lagar/dokument/protokoll/protokoll_${row.dok_id}/#anf${row.anforande_nummer}`,
  };
}

/** The source UUIDs of a duplicated speech's two rows, differing in their leading byte as published. */
export function duplicateUuids(number: number) {
  const suffix = `${number.toString(16).padStart(6, '0')}-e8e4-f111-bf30-6805cafeabf9`;
  return { lowest: `07${suffix}`, highest: `58${suffix}` };
}

/**
 * The two rows the source publishes for one duplicated speech: identical except `anforande_id`,
 * `systemnyckel` and `systemdatum`, which the server never reads. `highestFirst` puts the higher
 * source UUID first.
 */
export function duplicatedRows(number: number, highestFirst = false) {
  const { lowest, highest } = duplicateUuids(number);
  const copies = [
    { ...speechRow(number), anforande_id: lowest, systemnyckel: `${700000 + 2 * number}` },
    { ...speechRow(number), anforande_id: highest, systemnyckel: `${700001 + 2 * number}` },
  ].map((row, index) => ({ ...row, systemdatum: `2026-10-09 14:44:3${index + 2}` }));
  return highestFirst ? copies.reverse() : copies;
}

/** A list row as the detail record the doubled XML body carries for it, with its body text. */
export function xmlDetailRecord(row: ReturnType<typeof speechRow>, anforandetext: string) {
  return { dok_hangar_id: '5286238', ...withoutRowLinks(row), dok_nummer: '1', anforandetext };
}

/**
 * Serializes detail records the way the source answers for a duplicated speech: concatenated
 * `<anforande>` elements without an XML declaration, CRLF between elements, text entity-escaped.
 */
export function speechXml(records: Record<string, string>[]) {
  const escaped = (value: string) =>
    value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return records
    .map(
      (record) =>
        `<anforande>\r\n${Object.entries(record)
          .map(([key, value]) => `<${key}>${escaped(value)}</${key}>\r\n`)
          .join('')}</anforande>\r\n`,
    )
    .join('');
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
