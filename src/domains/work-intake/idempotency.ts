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

export class InMemoryIdempotencyStore implements IdempotencyStore {
  readonly #records = new Map<string, IdempotencyRecord>();

  get(scopeKey: string): IdempotencyRecord | undefined {
    return this.#records.get(scopeKey);
  }

  put(scopeKey: string, record: IdempotencyRecord): void {
    this.#records.set(scopeKey, record);
  }

  get size(): number {
    return this.#records.size;
  }
}
