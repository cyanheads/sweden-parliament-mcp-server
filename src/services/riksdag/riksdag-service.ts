/**
 * @fileoverview Injectable public upstream service with validated-success caching.
 * @module services/riksdag/riksdag-service
 */
import type { z } from '@cyanheads/mcp-ts-core';
import { PublicResponseCache } from './cache.js';
import {
  type JsonLoadResult,
  type JsonLoadSpec,
  RiksdagTransport,
  type ToolBudget,
} from './transport.js';

/** Test requests and production requests cross the same injected Fetch boundary. */
export interface RiksdagServiceOptions {
  fetch?: typeof globalThis.fetch;
}

/** One application instance owns the public cache and shared upstream permits. */
export class RiksdagService {
  readonly #transport: RiksdagTransport;
  readonly #cache = new PublicResponseCache();

  constructor(options: RiksdagServiceOptions = {}) {
    this.#transport = new RiksdagTransport(options.fetch ?? globalThis.fetch);
  }

  /** Endpoint schemas parse upstream JSON before any value can enter the cache. */
  async loadJson<S extends z.ZodType>(
    spec: JsonLoadSpec<S>,
    budget: ToolBudget,
  ): Promise<JsonLoadResult<z.output<S>>> {
    budget.check();
    const url = this.#transport.url(spec.path, spec.query);
    const key = url.href;
    const cached = this.#cache.get(key);
    if (cached) {
      const decoded: unknown = JSON.parse(cached.serialized);
      const result = spec.schema.safeParse(decoded);
      budget.check();
      if (!result.success)
        throw new Error('A cached validated response failed its endpoint schema.');
      return { found: true, data: result.data, retrievedAt: cached.retrievedAt };
    }
    const result = await this.#transport.load(url, spec, budget);
    budget.check();
    if (result.found && spec.cacheable?.(result.data) === true) {
      this.#cache.set(key, result.wireJson, result.retrievedAt, spec.ttlMs);
    }
    budget.check();
    return result.found
      ? { found: true, data: result.data, retrievedAt: result.retrievedAt }
      : result;
  }

  /** Releases queued callers during application teardown. */
  dispose(): void {
    this.#transport.dispose();
  }
}

let service: RiksdagService | undefined;

/** Initializes the service once in application setup. */
export function initRiksdagService(options: RiksdagServiceOptions = {}): void {
  service?.dispose();
  service = new RiksdagService(options);
}

/** Returns the configured process service, failing loudly before setup. */
export function getRiksdagService(): RiksdagService {
  if (!service)
    throw new Error('RiksdagService is not initialized; call initRiksdagService in setup.');
  return service;
}
