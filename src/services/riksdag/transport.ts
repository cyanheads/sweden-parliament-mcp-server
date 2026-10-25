/**
 * @fileoverview Fixed-origin Fetch transport and one disposable tool deadline.
 * @module services/riksdag/transport
 */
import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createPacer,
  defaultIsTransient,
  httpErrorFromResponse,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import { schemaInvalid } from './wire.js';

/** The same budget must reach every fetch, hydration, parse and rendering step. */
export interface ToolBudget extends Disposable {
  check(): void;
  remainingMs(): number;
  readonly signal: AbortSignal;
}

/** Starts the total 55-second budget; dispose it when the handler returns. */
export function createToolBudget(callerSignal?: AbortSignal): ToolBudget {
  const deadlineAt = Date.now() + 55_000;
  const controller = new AbortController();
  const expired = () =>
    new McpError(
      JsonRpcErrorCode.Timeout,
      'The tool exhausted its total upstream budget. Retry later or narrow the selection.',
      { reason: 'tool_deadline_exceeded' },
    );
  const timer = setTimeout(() => controller.abort(expired()), 55_000);
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;
  return {
    signal,
    remainingMs: () => Math.max(0, deadlineAt - Date.now()),
    check() {
      if (callerSignal?.aborted)
        throw new McpError(
          JsonRpcErrorCode.RequestCancelled,
          'The caller cancelled the request.',
          undefined,
          { cause: callerSignal.reason },
        );
      if (Date.now() >= deadlineAt || controller.signal.aborted) throw expired();
    },
    [Symbol.dispose]() {
      clearTimeout(timer);
    },
  };
}

/** Endpoint modules supply only their explicit verified query mapping. */
export type QueryParameters = Readonly<Record<string, string | number | undefined>>;

/** Validation and expected-miss policy belong to the owning endpoint module. */
export interface JsonLoadSpec<S extends z.ZodType> {
  cacheable?: (data: z.output<S>) => boolean;
  expected404?: boolean;
  path: string;
  query?: QueryParameters;
  schema: S;
  ttlMs: 120000 | 300000;
}

/** Fetch outcomes retain source-fetch time even when the payload is absent. */
export type JsonLoadResult<T> =
  | { found: true; data: T; retrievedAt: string }
  | { found: false; retrievedAt: string };

type TransportResult<T> =
  | { found: true; data: T; retrievedAt: string; wireJson: string }
  | { found: false; retrievedAt: string };

const ORIGIN = 'https://data.riksdagen.se';
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** Owns permits through body consumption, releasing them before retry backoff. */
export class RiksdagTransport {
  readonly #fetch: typeof globalThis.fetch;
  readonly #pacer = createPacer({ name: 'riksdag', maxConcurrent: 2, maxQueueDepth: 20 });

  constructor(fetch: typeof globalThis.fetch) {
    this.#fetch = fetch;
  }

  /** Constructs a deterministic fixed-origin key, rejecting non-route input. */
  url(path: string, query: QueryParameters = {}): URL {
    if (
      !/^\/(?:dokumentlista|dokumentstatus|anforandelista|anforande|voteringlista|personlista)(?:\/|\?|$)/.test(
        path,
      ) ||
      path.includes('?') ||
      path.includes('#') ||
      path.includes('\\')
    )
      throw new Error('Riksdag endpoint modules must supply a fixed supported route.');
    const url = new URL(path, ORIGIN);
    this.#assertOrigin(url);
    if (
      !/^\/(?:dokumentlista|dokumentstatus|anforandelista|anforande|voteringlista|personlista)(?:\/|$)/.test(
        url.pathname,
      )
    )
      throw new Error('A Riksdag route cannot contain path traversal.');
    for (const [key, value] of Object.entries(query).sort(([a], [b]) => a.localeCompare(b))) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }

  /** Retry includes body read and schema parsing, within the shared tool budget. */
  async load<S extends z.ZodType>(
    url: URL,
    spec: JsonLoadSpec<S>,
    budget: ToolBudget,
  ): Promise<TransportResult<z.output<S>>> {
    budget.check();
    try {
      return await withRetry(
        ({ signal }) => {
          budget.check();
          return this.#pacer.run(
            async () => {
              budget.check();
              const controller = new AbortController();
              const timer = setTimeout(
                () =>
                  controller.abort(
                    new DOMException('The upstream attempt timed out.', 'TimeoutError'),
                  ),
                Math.min(50_000, budget.remainingMs()),
              );
              const attemptSignal = AbortSignal.any([signal, controller.signal]);
              try {
                const response = await this.#request(url, attemptSignal);
                const retrievedAt = new Date().toISOString();
                if (response.status === 404 && spec.expected404) {
                  await response.body?.cancel();
                  budget.check();
                  return { found: false as const, retrievedAt };
                }
                if (!response.ok) {
                  await response.body?.cancel();
                  const error = await httpErrorFromResponse(response, {
                    service: 'Riksdagen',
                    captureBody: false,
                  });
                  throw error;
                }
                const text = response.body
                  ? await new Response(
                      response.body.pipeThrough(new TransformStream(), { signal: attemptSignal }),
                    )
                      .text()
                      .catch((error: unknown) => this.#networkError(error))
                  : '';
                budget.check();
                if (/^\s*<(?:!doctype\s+html|html(?:\s|>))/i.test(text)) {
                  if (
                    spec.expected404 &&
                    /(?:404\s*(?:[-:]\s*)?not\s+found|sidan\s+(?:kunde\s+inte\s+hittas|finns\s+inte)|page\s+not\s+found)/i.test(
                      text,
                    )
                  )
                    return { found: false as const, retrievedAt };
                  if (
                    /(?:service\s+unavailable|internal\s+server\s+error|bad\s+gateway|gateway\s+timeout|<(?:title|h1)[^>]*>[^<]*(?:503|502|504|500))/i.test(
                      text,
                    )
                  )
                    throw new McpError(
                      JsonRpcErrorCode.ServiceUnavailable,
                      'Riksdagen returned an HTML service-error response.',
                      { reason: 'upstream_unavailable', retryable: true },
                    );
                  throw schemaInvalid(
                    'Riksdagen returned HTML instead of the expected JSON response.',
                  );
                }
                let parsed: unknown;
                try {
                  parsed = JSON.parse(text);
                } catch (cause) {
                  throw new McpError(
                    JsonRpcErrorCode.SerializationError,
                    'Riksdagen returned invalid JSON.',
                    { reason: 'upstream_schema_invalid', retryable: false },
                    { cause },
                  );
                }
                const result = spec.schema.safeParse(parsed);
                budget.check();
                if (!result.success)
                  throw schemaInvalid(
                    'The Riksdagen response does not match the endpoint wire contract.',
                  );
                return { found: true as const, data: result.data, retrievedAt, wireJson: text };
              } catch (cause) {
                budget.check();
                if (controller.signal.aborted)
                  throw new McpError(
                    JsonRpcErrorCode.Timeout,
                    'The upstream request attempt timed out.',
                    { retryable: true },
                    { cause },
                  );
                if (cause instanceof McpError) throw cause;
                if (signal.aborted) throw signal.reason;
                throw cause;
              } finally {
                clearTimeout(timer);
              }
            },
            { signal },
          );
        },
        {
          signal: budget.signal,
          deadlineMs: budget.remainingMs(),
          maxRetries: 1,
          baseDelayMs: 500,
          maxDelayMs: 2000,
          jitter: 0,
          operation: 'Riksdagen JSON read',
          isTransient: (error) =>
            !budget.signal.aborted &&
            error instanceof McpError &&
            error.data?.reason !== 'pacer_shed' &&
            (typeof error.data?.status === 'number'
              ? RETRY_STATUSES.has(error.data.status)
              : defaultIsTransient(error)),
        },
      );
    } catch (error) {
      budget.check();
      if (error instanceof McpError && error.data?.reason === 'pacer_shed')
        throw new McpError(
          JsonRpcErrorCode.RateLimited,
          'The upstream request queue is full.',
          {
            reason: 'upstream_queue_full',
            recovery: {
              hint: 'Wait before retrying the same tool, and request fewer simultaneous searches.',
            },
          },
          { cause: error },
        );
      throw error;
    }
  }

  async #request(initial: URL, signal: AbortSignal): Promise<Response> {
    let url = initial;
    for (let redirects = 0; redirects <= 5; redirects++) {
      signal.throwIfAborted();
      this.#assertOrigin(url);
      const response = await this.#fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal,
      }).catch((error: unknown) => this.#networkError(error));
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 5)
        throw schemaInvalid('Riksdagen supplied an invalid or excessive redirect chain.');
      try {
        url = new URL(location, url);
      } catch {
        throw schemaInvalid('Riksdagen supplied an invalid redirect location.');
      }
      this.#assertOrigin(url);
    }
    throw new Error('Unreachable redirect loop.');
  }

  #assertOrigin(url: URL): void {
    if (url.origin !== ORIGIN || url.username || url.password)
      throw schemaInvalid('Riksdagen redirected outside its permitted HTTPS origin.');
  }

  #networkError(cause: unknown): never {
    if (cause instanceof TypeError)
      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        'The Riksdagen connection failed.',
        { reason: 'upstream_unavailable', retryable: true },
        { cause },
      );
    throw cause;
  }

  /** Rejects queued requests during shutdown. */
  dispose(): void {
    this.#pacer.dispose();
  }
}
