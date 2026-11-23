/**
 * @fileoverview Process-local byte-bounded LRU for validated public JSON and strings derived from it.
 * @module services/riksdag/cache
 */
interface Entry {
  /** One string derived from `serialized`, living and dying with this entry. */
  derived?: string;
  expiresAt: number;
  retrievedAt: string;
  serialized: string;
  /** UTF-8 bytes of `serialized` plus `derived`. */
  sizeBytes: number;
}

const MAX_ENTRIES = 64;
const MAX_BYTES = 32 * 1024 * 1024;
const encoder = new TextEncoder();
const utf8Bytes = (value: string) => encoder.encode(value).byteLength;

/** Stores only serialized successes and derived strings so callers cannot mutate cached values. */
export class PublicResponseCache {
  readonly #entries = new Map<string, Entry>();
  #sizeBytes = 0;

  /** Returns a serialized validated success, with its memo when one exists, and refreshes its LRU position. */
  get(key: string): { serialized: string; retrievedAt: string; derived?: string } | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.#delete(key, entry);
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return {
      serialized: entry.serialized,
      retrievedAt: entry.retrievedAt,
      ...(entry.derived === undefined ? {} : { derived: entry.derived }),
    };
  }

  /** Oversized entries are omitted; eviction never serves stale data. */
  set(key: string, serialized: string, retrievedAt: string, ttlMs: number): void {
    const prior = this.#entries.get(key);
    if (prior) this.#delete(key, prior);
    const sizeBytes = utf8Bytes(serialized);
    if (sizeBytes > MAX_BYTES) return;
    this.#makeRoom(sizeBytes, 1);
    this.#entries.set(key, { serialized, retrievedAt, expiresAt: Date.now() + ttlMs, sizeBytes });
    this.#sizeBytes += sizeBytes;
  }

  /**
   * Attaches `derived` to the live entry under `key` only while it still holds exactly `serialized`
   * and has no memo yet. Its UTF-8 bytes join the entry's size and the total bound, evicting older
   * entries; an entry whose wire plus memo would exceed the bound keeps no memo.
   */
  memoize(key: string, serialized: string, derived: string): void {
    const entry = this.#entries.get(key);
    if (
      !entry ||
      entry.serialized !== serialized ||
      entry.derived !== undefined ||
      entry.expiresAt <= Date.now()
    )
      return;
    const sizeBytes = utf8Bytes(derived);
    if (entry.sizeBytes + sizeBytes > MAX_BYTES) return;
    this.#makeRoom(sizeBytes, 0, key);
    entry.derived = derived;
    entry.sizeBytes += sizeBytes;
    this.#sizeBytes += sizeBytes;
  }

  /** Drops expired entries, then the least recently used, until `sizeBytes` and `addedEntries` fit; `keep` stays. */
  #makeRoom(sizeBytes: number, addedEntries: 0 | 1, keep?: string): void {
    const now = Date.now();
    for (const [key, entry] of this.#entries)
      if (key !== keep && entry.expiresAt <= now) this.#delete(key, entry);
    for (const [key, entry] of this.#entries) {
      if (
        this.#entries.size + addedEntries <= MAX_ENTRIES &&
        this.#sizeBytes + sizeBytes <= MAX_BYTES
      )
        break;
      if (key !== keep) this.#delete(key, entry);
    }
  }

  #delete(key: string, entry: Entry): void {
    this.#entries.delete(key);
    this.#sizeBytes -= entry.sizeBytes;
  }
}
