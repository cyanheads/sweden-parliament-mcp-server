/** @fileoverview Strict source identifier and local filter normalization. @module services/riksdag/normalize */
import { z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { REFERENCE_TABLES, type ReferenceEntry, type ReferenceTopic } from './reference-data.js';

/** Trim optional input; whitespace-only values are unset. */
export function optionalString(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

/**
 * The message a normalizer raises for a format, shared with that format's `formatString` schema.
 * `field` names the caller's input field where it differs from the format name.
 */
function formatMessage(format: string, field = format): string {
  return format === 'session'
    ? `Invalid ${field}; use YYYY/YY, consecutive YYYY/YYYY, or a calendar year YYYY.`
    : format === 'date'
      ? `Invalid ${field}; use a valid Gregorian date in YYYY-MM-DD format.`
      : format === 'date range'
        ? 'Invalid date range; dateFrom must be on or before dateTo.'
        : `Invalid ${field}; use riksdag_list_reference to check its format or code.`;
}

function invalid(format: string, field = format): never {
  throw validationError(formatMessage(format, field), { reason: 'invalid_filter', field });
}

/** Caller-input formats that carry a raw-input JSON Schema pattern. */
export type InputFormat = 'session' | 'date' | 'memberId' | 'documentId' | 'speechId' | 'report';

/**
 * Pattern sources are plain string literals with doubled backslashes so the advertised pattern stays
 * ASCII: vitest's transform rewrites a `\uXXXX` escape inside `String.raw` or a regex literal to the
 * literal character.
 */
const SWEDISH_LETTERS = 'A-Za-z\\u00C5\\u00C4\\u00D6\\u00E5\\u00E4\\u00F6';
/** Combining diaeresis and ring above: decomposed ä, ö and å, which NFC composes. */
const COMBINING_MARKS = '\\u0308\\u030A';
/** KELVIN SIGN and ANGSTROM SIGN, which NFC maps to K and Å. */
const NFC_LETTERS = '\\u212A\\u212B';
/** Document IDs also admit LONG S, which the `iu` normalizer matches by case folding to s. */
const DOCUMENT_LETTERS = `${SWEDISH_LETTERS}${NFC_LETTERS}\\u017F`;
const REPORT_LETTERS = `${SWEDISH_LETTERS}${NFC_LETTERS}`;
/** Vote-record prefixes are ASCII; KELVIN SIGN is the one character NFC maps to an ASCII letter. */
const VOTE_RECORD_LETTERS = 'A-Za-z\\u212A';
const SESSION_CORE = '[1-9]\\d{3}(?:/(?:\\d{2}|[1-9]\\d{3}))?';

/**
 * Each format's accepted forms as written by the caller, before trim and NFC. Case is spelled out
 * because Zod emits `regex.source` without flags. A core admits every value its normalizer accepts;
 * the value checks (session arithmetic, calendar dates, report-session agreement, which composed
 * letters are Swedish) stay with the normalizer.
 */
const FORMAT_CORES: Record<InputFormat, string> = {
  session: SESSION_CORE,
  date: '[1-9]\\d{3}-\\d{2}-\\d{2}',
  memberId: '\\d+',
  speechId: '[A-Za-z][A-Za-z0-9]09\\d+-[1-9]\\d*',
  documentId: `[${DOCUMENT_LETTERS}][${DOCUMENT_LETTERS}0-9${COMBINING_MARKS}]{3,}|[${VOTE_RECORD_LETTERS}][${VOTE_RECORD_LETTERS}0-9]19\\d{4}-[1-9]\\d*|[Ss][Ff][Ss]-[Nn]?[1-9]\\d{3}-[1-9]\\d*|(?:[Ss][Ff][Ss]\\s+)?[Nn]?[1-9]\\d{3}:[1-9]\\d*`,
  report: `(?:${SESSION_CORE}\\s*:\\s*)?[${REPORT_LETTERS}][${REPORT_LETTERS}${COMBINING_MARKS}]*[1-9]\\d*`,
};

/**
 * A string schema whose flag-free `pattern` admits every raw value the format's normalizer accepts,
 * surrounding whitespace included (JS `\s` is exactly the `trim()` set). `blank` also admits `''` and
 * whitespace-only values. A mismatch carries the normalizer's format message, naming `field` when
 * the caller's field is not named for its format. The body owns its trailing whitespace so a
 * blank-admitting pattern never runs two adjacent `\s*`; normalize-pattern-timing.test.ts pins the
 * CPU bound.
 */
export function formatString(
  format: InputFormat,
  options: { blank: boolean; field?: string },
): z.ZodString {
  const core = FORMAT_CORES[format];
  const pattern = options.blank ? `^\\s*(?:(?:${core})\\s*)?$` : `^\\s*(?:${core})\\s*$`;
  return z.string().regex(new RegExp(pattern), formatMessage(format, options.field));
}

function exactKey(value: string): string {
  return value.trim().normalize('NFC').toLocaleLowerCase('sv-SE');
}

function uniqueCode(rows: readonly ReferenceEntry[]): string | undefined {
  const codes = new Set(rows.map((row) => row.code));
  return codes.size === 1 ? [...codes][0] : undefined;
}

/** Resolve a code or unique exact Swedish/available English label, preserving official code spelling. */
export function normalizeCode(
  value: string,
  topic: 'document_types' | 'committees' | 'parties' | 'constituencies',
): string {
  const key = exactKey(value);
  const rows = REFERENCE_TABLES[topic];
  return (
    uniqueCode(rows.filter((row) => exactKey(row.code) === key)) ??
    uniqueCode(
      rows.filter(
        (row) =>
          (topic !== 'document_types' || row.subtype === '') &&
          [row.labelSv, row.labelEn].some(
            (label) => label !== undefined && exactKey(label) === key,
          ),
      ),
    ) ??
    invalid(topic)
  );
}

/** Normalize published sessions, permitting well-formed sessions newer than the snapshot. */
export function normalizeSession(value: string): string {
  const session = value.trim();
  if (/^[1-9]\d{3}$/.test(session)) return session;
  const match = /^([1-9]\d{3})\/(\d{2}|[1-9]\d{3})$/.exec(session);
  if (!match) return invalid('session');
  const [, startYear = '', end = ''] = match;
  const start = Number(startYear);
  if (start === 1999 && (end === '00' || end === '2000')) return '1999/2000';
  const expectedEnd = end.length === 4 ? start + 1 : (start + 1) % 100;
  if (Number(end) !== expectedEnd) return invalid('session');
  return `${startYear}/${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * The canonical spelling of an ordinary document ID, a vote-record ID (session code, series 19,
 * four digits and a positive number: `H6190118-1`) or an unambiguous SFS alias (`sfs-YYYY-N`,
 * `SFS YYYY:N`, `YYYY:N`), including the source's N-prefixed SFS numbers (`sfs-N2026-7`,
 * `SFS N2026:7`, `N2026:7`); undefined for any other value.
 */
export function canonicalDocumentId(value: string): string | undefined {
  const id = value.trim().normalize('NFC');
  const sfs =
    /^sfs-(n?)([1-9]\d{3})-([1-9]\d*)$/i.exec(id) ??
    /^(?:sfs\s+)?(n?)([1-9]\d{3}):([1-9]\d*)$/i.exec(id);
  if (sfs) {
    const [, series, year, number] = sfs;
    return `sfs-${series ? 'N' : ''}${year}-${number}`;
  }
  return /^[a-zåäö][a-zåäö0-9]{3,}$/iu.test(id) || /^[a-z][a-z0-9]19\d{4}-[1-9]\d*$/i.test(id)
    ? id.toUpperCase()
    : undefined;
}

/** {@link canonicalDocumentId} for caller input; `field` names the caller's input field in the rejection. */
export function normalizeDocumentId(value: string, field = 'documentId'): string {
  return canonicalDocumentId(value) ?? invalid('documentId', field);
}

/** Preserve numeric member identifiers byte-for-byte after trimming, including leading zeros. */
export function normalizeMemberId(value: string): string {
  const id = value.trim();
  if (!/^\d+$/.test(id)) return invalid('memberId');
  return id;
}

/** Accept retrieval IDs only: protocol document ID followed by a positive speech number. */
export function normalizeSpeechId(value: string): string {
  const match = /^([a-z][a-z0-9]{3,})-([1-9]\d*)$/i.exec(value.trim());
  const protocolId = match?.[1];
  if (protocolId === undefined || !/^[a-z0-9]{2}09\d+$/i.test(protocolId))
    return invalid('speechId');
  return `${protocolId.toUpperCase()}-${match?.[2]}`;
}

/** Resolve an NFC report designation, trimming each part, and reject a disagreeing composite session prefix. */
export function normalizeReport(value: string, session: string): string {
  const parts = value
    .normalize('NFC')
    .split(':')
    .map((part) => part.trim());
  if (parts.length > 2) return invalid('report');
  const firstPart = parts[0] ?? invalid('report');
  if (parts.length === 2 && normalizeSession(firstPart) !== normalizeSession(session))
    return invalid('report session');
  const designation = parts.at(-1) ?? invalid('report');
  if (!/^[a-zåäö]+[1-9]\d*$/i.test(designation)) return invalid('report');
  return designation.toUpperCase();
}

/** Validate an actual Gregorian ISO date without JavaScript date overflow; `field` names the caller's input field in the rejection. */
export function normalizeDate(value: string, field = 'date'): string {
  const date = value.trim();
  const match = /^([1-9]\d{3})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return invalid('date', field);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const monthLength = lengths[month - 1];
  if (monthLength === undefined || day < 1 || day > monthLength) return invalid('date', field);
  return date;
}

/** Normalize optional inclusive date bounds and reject reversed intervals. */
export function normalizeDateRange(
  from: string | undefined,
  to: string | undefined,
): { dateFrom?: string; dateTo?: string } {
  const trimmedFrom = optionalString(from);
  const trimmedTo = optionalString(to);
  const dateFrom = trimmedFrom === undefined ? undefined : normalizeDate(trimmedFrom, 'dateFrom');
  const dateTo = trimmedTo === undefined ? undefined : normalizeDate(trimmedTo, 'dateTo');
  if (dateFrom !== undefined && dateTo !== undefined && dateFrom > dateTo)
    return invalid('date range');
  return {
    ...(dateFrom === undefined ? {} : { dateFrom }),
    ...(dateTo === undefined ? {} : { dateTo }),
  };
}

function searchable(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('sv-SE')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Normalize case/diacritics and punctuation into deduplicated tokens; reject punctuation-only filters. */
export function normalizeTokens(value: string): string[] {
  const tokens = [...new Set(searchable(value).split(/\s+/u).filter(Boolean))];
  if (tokens.length === 0) return invalid('name or heading filter');
  return tokens;
}

/** Match every normalized token as a substring of the combined name or heading text. */
export function matchesAllTokens(value: string, tokens: readonly string[]): boolean {
  const normalized = searchable(value);
  return tokens.every((token) => normalized.includes(token));
}

/** Runtime guard for topic names used by callers without an input schema. */
export function isReferenceTopic(value: string): value is ReferenceTopic {
  return Object.hasOwn(REFERENCE_TABLES, value);
}
