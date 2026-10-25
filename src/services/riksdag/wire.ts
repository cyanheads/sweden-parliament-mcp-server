/**
 * @fileoverview Shared sparse-wire normalization and complete-set invariants.
 * @module services/riksdag/wire
 */
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';

/** Empty source strings carry no published value; nonempty text retains its bytes. */
export const optionalWireString = z
  .string()
  .nullish()
  .transform((value) =>
    value === null || value === undefined || value.trim() === '' ? undefined : value,
  );

/** Source counts are decimal strings, never truthiness or numeric coercion. */
export const wireCount = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .refine(Number.isSafeInteger, 'Count exceeds the safe integer range.');

/** Normalizes optional child collections without accepting primitives as rows. */
export function collectionOf<S extends z.ZodType>(schema: S) {
  return z
    .union([z.array(schema), schema, z.null()])
    .optional()
    .transform((value) =>
      value === null || value === undefined ? [] : Array.isArray(value) ? value : [value],
    );
}

/** Classifies deterministic malformed upstream data without exposing its payload. */
export function schemaInvalid(message: string): McpError {
  return new McpError(JsonRpcErrorCode.SerializationError, message, {
    reason: 'upstream_schema_invalid',
    retryable: false,
  });
}

/** Reuses identifier rules at the source boundary without blaming valid caller input. */
export function parseSourceIdentity<T>(value: string, parse: (value: string) => T): T {
  try {
    return parse(value);
  } catch (cause) {
    if (cause instanceof McpError && cause.data?.reason === 'invalid_filter')
      throw new McpError(
        JsonRpcErrorCode.SerializationError,
        'The source supplied a malformed parliamentary identifier.',
        { reason: 'upstream_schema_invalid', retryable: false },
        { cause },
      );
    throw cause;
  }
}

/** Converts source-relative links only; these links are never fetch destinations. */
export function sourceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value, 'https://data.riksdagen.se');
  } catch {
    throw schemaInvalid('The source supplied a malformed link.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw schemaInvalid('The source supplied an unsupported link protocol.');
  if (url.username || url.password)
    throw schemaInvalid('The source supplied a credential-bearing link.');
  return url.href;
}

/** Validates completeness and unique stable identities before filtering or caching. */
export function assertCompleteCandidates<T>(
  rows: T[],
  returnedCount: number | undefined,
  identity: (row: T) => string,
): void {
  if (rows.length >= 50_000 || (returnedCount !== undefined && returnedCount >= 50_000)) {
    throw new McpError(
      JsonRpcErrorCode.ValidationError,
      'The source candidate boundary was reached; a narrower selection is required for complete traversal.',
      { reason: 'candidate_limit_reached' },
    );
  }
  if (returnedCount === undefined || returnedCount !== rows.length)
    throw schemaInvalid(
      'The source returned-row count does not match the complete candidate response.',
    );
  const identities = new Set<string>();
  for (const row of rows) {
    const key = identity(row);
    if (identities.has(key))
      throw schemaInvalid('The source returned duplicate stable row identities.');
    identities.add(key);
  }
}
