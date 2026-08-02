/**
 * Caller-scoped intake idempotency (ADR-031).
 *
 * Scope is `(caller_id, route, idempotency_key)`. The caller id comes from the
 * authenticated principal, never from the request body — otherwise one caller
 * could address another caller's key scope and read back their result.
 *
 * Only accepted submissions are recorded. A rejected payload does not burn the
 * key, so a caller may correct a malformed body and retry with the same key.
 */

import type { DirectTaskAcceptance } from './contracts.ts';
import { INTAKE_LIMITS } from './contracts.ts';

export const DIRECT_TASK_ROUTE = 'POST /tasks';

/** Printable ASCII without whitespace or control characters. */
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]+$/;

export type IdempotencyRecord = {
  readonly payload_hash: string;
  readonly result: DirectTaskAcceptance;
};

/**
 * Narrow persistence seam. The in-memory implementation below is sufficient for
 * this slice; the controller's SQLite store will implement the same interface
 * behind a unique constraint on the scope key (integration seam).
 */
export type IdempotencyStore = {
  get(scopeKey: string): IdempotencyRecord | undefined;
  put(scopeKey: string, record: IdempotencyRecord): void;
};

export function isValidIdempotencyKey(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= INTAKE_LIMITS.maxIdempotencyKeyLength &&
    IDEMPOTENCY_KEY_PATTERN.test(key)
  );
}

/**
 * Build the storage key. Components are length-prefixed so that no combination
 * of caller id and key can be crafted to collide with a different pair.
 */
export function idempotencyScopeKey(callerId: string, route: string, key: string): string {
  return [callerId, route, key].map((part) => `${part.length}:${part}`).join('|');
}

/** Default ceiling on retained records for the in-memory store. */
export const DEFAULT_MAX_IDEMPOTENCY_RECORDS = 10_000;

/**
 * Reference store for tests and single-process use.
 *
 * It is deliberately **bounded and fail-closed**. Evicting a record would be
 * the more available choice, but it silently breaks the guarantee the store
 * exists to provide: a replay after eviction re-executes as a fresh
 * submission. Refusing new records instead keeps every retained key honest and
 * makes exhaustion visible rather than silently incorrect.
 *
 * The durable controller-side store must not evict either; it should persist
 * to SQLite under a unique constraint on the scope key.
 */
export class IdempotencyCapacityExceededError extends Error {
  constructor(limit: number) {
    super(`idempotency store is full (${limit} records); a durable store is required`);
    this.name = 'IdempotencyCapacityExceededError';
  }
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  readonly #records = new Map<string, IdempotencyRecord>();
  readonly #limit: number;

  constructor(limit: number = DEFAULT_MAX_IDEMPOTENCY_RECORDS) {
    this.#limit = limit;
  }

  get(scopeKey: string): IdempotencyRecord | undefined {
    return this.#records.get(scopeKey);
  }

  put(scopeKey: string, record: IdempotencyRecord): void {
    if (!this.#records.has(scopeKey) && this.#records.size >= this.#limit) {
      throw new IdempotencyCapacityExceededError(this.#limit);
    }
    this.#records.set(scopeKey, record);
  }

  get size(): number {
    return this.#records.size;
  }
}
