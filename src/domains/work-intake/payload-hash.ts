/**
 * Canonical payload hashing for caller-scoped idempotency (ADR-031).
 *
 * The hash must be stable across key ordering and JSON whitespace so that a
 * genuine retry replays, while any semantic change to the payload conflicts.
 */

import { createHash } from 'node:crypto';

const MAX_CANONICAL_DEPTH = 32;

/**
 * Serialize a JSON value with object keys sorted, so that two payloads which
 * differ only in key order hash identically.
 *
 * Rejects cyclic and pathologically nested input rather than recursing forever
 * on untrusted data. `undefined` object properties are omitted, matching
 * `JSON.stringify`, so an absent field and an explicitly-undefined field agree.
 */
export function canonicalize(value: unknown, depth = 0): string {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new RangeError('payload nesting exceeds canonicalization depth limit');
  }

  if (value === null) return 'null';

  const valueType = typeof value;

  if (valueType === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new TypeError('non-finite numbers are not canonicalizable');
    }
    return JSON.stringify(value);
  }

  if (valueType === 'string' || valueType === 'boolean') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalize(item, depth + 1));
    return `[${items.join(',')}]`;
  }

  if (valueType === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const entries: string[] = [];
    for (const key of keys) {
      const entryValue = record[key];
      if (entryValue === undefined) continue;
      entries.push(`${JSON.stringify(key)}:${canonicalize(entryValue, depth + 1)}`);
    }
    return `{${entries.join(',')}}`;
  }

  throw new TypeError(`value of type ${valueType} is not canonicalizable`);
}

/** SHA-256 over the canonical form, hex encoded. */
export function hashPayload(value: unknown): string {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}
