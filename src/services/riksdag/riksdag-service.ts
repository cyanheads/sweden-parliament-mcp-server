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

/** A found load also carries one string derived from its data. */
export type DerivedJsonLoadResult<T> =
  | { found: true; data: T; retrievedAt: string; derived: string }
  | { found: false; retrievedAt: string };

/** A found load plus the cache identity of the wire it was parsed from. */
type CacheAwareLoad<T> =
  | {
      found: true;
      data: T;
      retrievedAt: string;
      key: string;
      /** Wire held by the cache entry the data came from; absent when nothing was cached. */
      serialized?: string;
      derived?: string;
    }
  | { found: false; retrievedAt: string };

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
    const loaded = await this.#load(spec, budget);
    return loaded.found
      ? { found: true, data: loaded.data, retrievedAt: loaded.retrievedAt }
      : loaded;
  }

  /**
   * Loads like {@link loadJson} and also returns `derive(data)`, memoized on the cache entry the
   * data was parsed from: a later hit on that same entry skips `derive`, and the memo expires,
   * evicts and is replaced with it. `derive` must be a synchronous pure function of the data, so a
   * cancelled caller leaves a complete memo or none; no caller ever waits on another's work.
   */
  async loadJsonDerived<S extends z.ZodType>(
    spec: JsonLoadSpec<S>,
    budget: ToolBudget,
    derive: (data: z.output<S>) => string,
  ): Promise<DerivedJsonLoadResult<z.output<S>>> {
    const loaded = await this.#load(spec, budget);
    if (!loaded.found) return loaded;
    const { data, retrievedAt, key, serialized } = loaded;
    let { derived } = loaded;
    if (derived === undefined) {
      derived = derive(data);
      // Memoized before the check, so a caller cancelled mid-derive still leaves a complete memo.
      if (serialized !== undefined) this.#cache.memoize(key, serialized, derived);
      budget.check();
    }
    return { found: true, data, retrievedAt, derived };
  }

  async #load<S extends z.ZodType>(
    spec: JsonLoadSpec<S>,
    budget: ToolBudget,
  ): Promise<CacheAwareLoad<z.output<S>>> {
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
      return {
        found: true,
        data: result.data,
        retrievedAt: cached.retrievedAt,
        key,
        serialized: cached.serialized,
        ...(cached.derived === undefined ? {} : { derived: cached.derived }),
      };
    }
    const result = await this.#transport.load(url, spec, budget);
    budget.check();
    if (!result.found) return result;
    const cacheable = spec.cacheable?.(result.data) === true;
    if (cacheable) this.#cache.set(key, result.wireJson, result.retrievedAt, spec.ttlMs);
    budget.check();
    return {
      found: true,
      data: result.data,
      retrievedAt: result.retrievedAt,
      key,
      ...(cacheable ? { serialized: result.wireJson } : {}),
    };
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
