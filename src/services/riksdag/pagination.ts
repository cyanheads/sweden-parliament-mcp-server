/**
 * @fileoverview Measured whole-row and code-point pagination without silent loss.
 * @module services/riksdag/pagination
 */
import { measureResponse, type SuccessEnrichment } from './output.js';
import { codePointLength, sliceCodePoints } from './text.js';
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
  if (measureResponse(result, enrichment) > RESPONSE_TARGET_BYTES) {
    enrichment.notices.push(
      'An indivisible entry exceeds the default response target and is returned intact; continuation advances after that entry.',
    );
    result = build(selected, truncated ? selected.length : limit, truncated);
  }
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
  const { text, offset, length, build, enrichment, budget } = options;
  budget?.check();
  const total = codePointLength(text);
  if (offset > total)
    enrichment.notices.push(
      'The text offset is beyond the available text; this is an empty terminal page.',
    );
  const requested = Math.min(length ?? 1000, Math.max(0, total - offset));
  let result = build(sliceCodePoints(text, offset, requested), requested);
  if (measureResponse(result, enrichment) <= RESPONSE_TARGET_BYTES) {
    budget?.check();
    return result;
  }
  if (length !== undefined) {
    enrichment.notices.push(
      'The explicit textLength is honored and this response exceeds the default response target.',
    );
    result = build(sliceCodePoints(text, offset, requested), requested);
    budget?.check();
    return result;
  }
  enrichment.notices.push(
    'The default text page was shortened to fit the response target; follow nextTextCall to continue without text loss.',
  );
  let low = requested === 0 ? 0 : 1;
  let high = requested;
  while (low < high) {
    budget?.check();
    const middle = Math.ceil((low + high) / 2);
    const candidate = build(sliceCodePoints(text, offset, middle), middle);
    if (measureResponse(candidate, enrichment) <= RESPONSE_TARGET_BYTES) low = middle;
    else high = middle - 1;
  }
  result = build(sliceCodePoints(text, offset, low), low);
  if (measureResponse(result, enrichment) > RESPONSE_TARGET_BYTES)
    enrichment.notices.push(
      'The non-text metadata exceeds the default response target and is returned intact.',
    );
  budget?.check();
  return result;
}
