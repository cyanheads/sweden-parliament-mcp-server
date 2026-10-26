/** @fileoverview Strict source identifier and local filter normalization. @module services/riksdag/normalize */
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { REFERENCE_TABLES, type ReferenceEntry, type ReferenceTopic } from './reference-data.js';

/** Trim optional input; whitespace-only values are unset. */
export function optionalString(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function invalid(field: string): never {
  const message =
    field === 'session'
      ? 'Invalid session; use YYYY/YY, consecutive YYYY/YYYY, or a calendar year YYYY.'
      : field === 'date'
        ? 'Invalid date; use a valid Gregorian date in YYYY-MM-DD format.'
        : field === 'date range'
          ? 'Invalid date range; dateFrom must be on or before dateTo.'
          : `Invalid ${field}; use riksdag_list_reference to check its format or code.`;
  throw validationError(message, { reason: 'invalid_filter', field });
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

/** Canonicalize an ordinary document ID or the three supported unambiguous SFS aliases. */
export function normalizeDocumentId(value: string): string {
  const id = value.trim().normalize('NFC');
  const sfs = /^(?:sfs-([1-9]\d{3})-([1-9]\d*)|(?:sfs\s+)?([1-9]\d{3}):([1-9]\d*))$/i.exec(id);
  if (sfs) return `sfs-${sfs[1] ?? sfs[3]}-${sfs[2] ?? sfs[4]}`;
  if (!/^[a-zåäö][a-zåäö0-9]{3,}$/iu.test(id)) return invalid('documentId');
  return id.toUpperCase();
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

/** Resolve a report designation and reject a disagreeing composite session prefix. */
export function normalizeReport(value: string, session: string): string {
  const parts = value.trim().split(':');
  if (parts.length > 2) return invalid('report');
  const firstPart = parts[0] ?? invalid('report');
  if (parts.length === 2 && normalizeSession(firstPart) !== normalizeSession(session))
    return invalid('report session');
  const designation = parts.at(-1) ?? invalid('report');
  if (!/^[a-zåäö]+[1-9]\d*$/i.test(designation)) return invalid('report');
  return designation.toUpperCase();
}

/** Validate an actual Gregorian ISO date without JavaScript date overflow. */
export function normalizeDate(value: string): string {
  const date = value.trim();
  const match = /^([1-9]\d{3})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return invalid('date');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const monthLength = lengths[month - 1];
  if (monthLength === undefined || day < 1 || day > monthLength) return invalid('date');
  return date;
}

/** Normalize optional inclusive date bounds and reject reversed intervals. */
export function normalizeDateRange(
  from: string | undefined,
  to: string | undefined,
): { dateFrom?: string; dateTo?: string } {
  const trimmedFrom = optionalString(from);
  const trimmedTo = optionalString(to);
  const dateFrom = trimmedFrom === undefined ? undefined : normalizeDate(trimmedFrom);
  const dateTo = trimmedTo === undefined ? undefined : normalizeDate(trimmedTo);
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
