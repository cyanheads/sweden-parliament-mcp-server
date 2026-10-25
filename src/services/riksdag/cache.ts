/**
 * @fileoverview Process-local byte-bounded LRU for validated public JSON.
 * @module services/riksdag/cache
 */
interface Entry {
  expiresAt: number;
  retrievedAt: string;
  serialized: string;
  sizeBytes: number;
}

/** Stores only serialized successes so callers cannot mutate cached values. */
export class PublicResponseCache {
  readonly #entries = new Map<string, Entry>();
  #sizeBytes = 0;

  /** Returns a serialized validated success and refreshes its LRU position. */
  get(key: string): { serialized: string; retrievedAt: string } | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.#delete(key, entry);
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return { serialized: entry.serialized, retrievedAt: entry.retrievedAt };
  }

  /** Oversized entries are omitted; eviction never serves stale data. */
  set(key: string, serialized: string, retrievedAt: string, ttlMs: number): void {
    const prior = this.#entries.get(key);
    if (prior) this.#delete(key, prior);
    const sizeBytes = new TextEncoder().encode(serialized).byteLength;
    if (sizeBytes > 32 * 1024 * 1024) return;
    for (const [oldKey, entry] of this.#entries) {
      if (entry.expiresAt <= Date.now()) this.#delete(oldKey, entry);
    }
    while (this.#entries.size >= 64 || this.#sizeBytes + sizeBytes > 32 * 1024 * 1024) {
      const oldest = this.#entries.entries().next().value;
      if (!oldest) break;
      this.#delete(oldest[0], oldest[1]);
    }
    this.#entries.set(key, { serialized, retrievedAt, expiresAt: Date.now() + ttlMs, sizeBytes });
    this.#sizeBytes += sizeBytes;
  }

  #delete(key: string, entry: Entry): void {
    this.#entries.delete(key);
    this.#sizeBytes -= entry.sizeBytes;
  }
}
