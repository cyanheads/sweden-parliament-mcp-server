/**
 * @fileoverview Unicode code-point text pages sized by the caller's length, never by bytes.
 * @module services/riksdag/pagination
 */
import type { SuccessEnrichment } from './output.js';
import type { ToolBudget } from './transport.js';

/** Code points in a text page whose caller omits an explicit length. */
export const DEFAULT_TEXT_PAGE_CODE_POINTS = 8000;

/**
 * One code-point page of `text`: the default page is {@link DEFAULT_TEXT_PAGE_CODE_POINTS},
 * an explicit `length` is honored, and an offset past the end yields an empty terminal page
 * with a notice.
 */
export function pageText<R>(options: {
  text: string;
  offset: number;
  length?: number;
  build: (text: string, returnedLength: number) => R;
  enrichment: SuccessEnrichment;
  budget?: ToolBudget;
}): R {
  const { text, offset, length, build, enrichment, budget } = options;
  const source = { text, offset, ...(length === undefined ? {} : { length }) };
  const page = textPage(source, enrichment, budget);
  budget?.check();
  return build(page.text, page.returnedLength);
}

/** One independently continued representation in a combined response. */
export interface TextPageSource {
  length?: number;
  offset: number;
  pastEndNotice?: string;
  text: string;
}

/** Pages every independently continued text channel by code point, as {@link pageText} does one. */
export function pageTexts<S extends TextPageSource, R>(options: {
  sources: readonly S[];
  build: (pages: { source: S; text: string; returnedLength: number; totalLength: number }[]) => R;
  enrichment: SuccessEnrichment;
  budget?: ToolBudget;
}): R {
  const { sources, build, enrichment, budget } = options;
  const pages = sources.map((source) => textPage(source, enrichment, budget));
  budget?.check();
  return build(pages);
}

function textPage<S extends TextPageSource>(
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
  const returnedLength = Math.min(
    source.length ?? DEFAULT_TEXT_PAGE_CODE_POINTS,
    Math.max(0, remaining),
  );
  return {
    source,
    text: codePoints.slice(source.offset, source.offset + returnedLength).join(''),
    returnedLength,
    totalLength: codePoints.length,
  };
}
