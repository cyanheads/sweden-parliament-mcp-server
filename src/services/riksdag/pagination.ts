/**
 * @fileoverview Measured whole-row and code-point pagination without silent loss.
 * @module services/riksdag/pagination
 */
import { measureResponse, type SuccessEnrichment } from './output.js';
import type { ToolBudget } from './transport.js';

/** Default response target across both surfaces; indivisible entries may exceed it. */
export const RESPONSE_TARGET_BYTES = 24 * 1024;

/** Fits only whole local rows; build must advance continuation by selected.length. */
export function fitRows<T, R>(options: {
  rows: readonly T[];
  offset: number;
  limit: number;
  build: (selected: T[], appliedLimit: number, truncated: boolean) => R;
  enrichment: SuccessEnrichment;
  budget?: ToolBudget;
}): R {
  const { rows, offset, limit, build, enrichment, budget } = options;
  budget?.check();
  let selected = rows.slice(offset, offset + limit);
  let truncated = false;
  let result = build(selected, limit, truncated);
  if (measureResponse(result, enrichment) > RESPONSE_TARGET_BYTES && selected.length > 1) {
    enrichment.notices.push(
      'The local page was shortened to fit the response target; follow the complete next call for every remaining row.',
    );
    do {
      budget?.check();
      selected = selected.slice(0, -1);
      truncated = true;
      result = build(selected, selected.length, truncated);
    } while (selected.length > 1 && measureResponse(result, enrichment) > RESPONSE_TARGET_BYTES);
  }
  if (measureResponse(result, enrichment) > RESPONSE_TARGET_BYTES)
    enrichment.notices.push(
      'An indivisible entry exceeds the default response target and is returned intact; continuation advances after that entry.',
    );
  budget?.check();
  return result;
}

/** Explicit lengths are honored; default text pages shrink using the measured response. */
export function fitText<R>(options: {
  text: string;
  offset: number;
  length?: number;
  build: (text: string, returnedLength: number) => R;
  enrichment: SuccessEnrichment;
  budget?: ToolBudget;
}): R {
  const source = {
    text: options.text,
    offset: options.offset,
    ...(options.length === undefined ? {} : { length: options.length }),
  };
  const prepared = prepareTextSource(source, options.enrichment, options.budget);
  return fitTextResponse({
    hasDefault: source.length === undefined && prepared.requested > 0,
    hasExplicit: source.length !== undefined,
    enrichment: options.enrichment,
    candidate: (cap) => {
      options.budget?.check();
      const page = textPage(prepared, cap);
      return options.build(page.text, page.returnedLength);
    },
  });
}

/** One independently continued representation in a combined response. */
export interface TextPageSource {
  length?: number;
  offset: number;
  pastEndNotice?: string;
  text: string;
}

/** Fits all default text channels against the final envelope while retaining explicit lengths. */
export function fitTextPages<S extends TextPageSource, R>(options: {
  sources: readonly S[];
  build: (pages: { source: S; text: string; returnedLength: number; totalLength: number }[]) => R;
  enrichment: SuccessEnrichment;
  budget?: ToolBudget;
}): R {
  const { sources, build, enrichment, budget } = options;
  const prepared = sources.map((source) => prepareTextSource(source, enrichment, budget));
  const candidate = (cap: number) => {
    budget?.check();
    return build(prepared.map((entry) => textPage(entry, cap)));
  };
  return fitTextResponse({
    candidate,
    enrichment,
    hasDefault: prepared.some(
      ({ source, requested }) => source.length === undefined && requested > 0,
    ),
    hasExplicit: sources.some((source) => source.length !== undefined),
  });
}

function prepareTextSource<S extends TextPageSource>(
  source: S,
  enrichment: SuccessEnrichment,
  budget: ToolBudget | undefined,
) {
  budget?.check();
  const codePoints = Array.from(source.text);
  const remaining = codePoints.length - source.offset;
  if (remaining < 0)
    enrichment.notices.push(
      source.pastEndNotice ??
        'The text offset is beyond the available text; this is an empty terminal page.',
    );
  return { source, codePoints, requested: Math.min(source.length ?? 8000, Math.max(0, remaining)) };
}

function textPage<S extends TextPageSource>(
  entry: ReturnType<typeof prepareTextSource<S>>,
  cap: number,
) {
  const { source, codePoints, requested } = entry;
  const returnedLength = source.length === undefined ? Math.min(requested, cap) : requested;
  return {
    source,
    text: codePoints.slice(source.offset, source.offset + returnedLength).join(''),
    returnedLength,
    totalLength: codePoints.length,
  };
}

function fitTextResponse<R>({
  candidate,
  enrichment,
  hasDefault,
  hasExplicit,
}: {
  candidate: (cap: number) => R;
  enrichment: SuccessEnrichment;
  hasDefault: boolean;
  hasExplicit: boolean;
}): R {
  const full = candidate(8000);
  if (measureResponse(full, enrichment) <= RESPONSE_TARGET_BYTES) return full;
  if (hasDefault)
    enrichment.notices.push(
      'Default text pages were shortened to fit the response target; follow each complete text continuation without text loss.',
    );
  let low = 1;
  let high = 8000;
  while (hasDefault && low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measureResponse(candidate(middle), enrichment) <= RESPONSE_TARGET_BYTES) low = middle;
    else high = middle - 1;
  }
  const result = candidate(hasDefault ? low : 8000);
  if (measureResponse(result, enrichment) > RESPONSE_TARGET_BYTES)
    enrichment.notices.push(
      hasExplicit
        ? 'The explicit textLength or htmlLength is honored and this response exceeds the default response target.'
        : 'The non-text metadata exceeds the default response target and is returned intact.',
    );
  return result;
}
