import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalize, hashPayload } from '../../src/domains/work-intake/payload-hash.ts';

describe('canonicalize', () => {
  it('is stable across object key ordering', () => {
    assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }));
  });

  it('preserves array ordering as significant', () => {
    assert.notEqual(canonicalize(['a', 'b']), canonicalize(['b', 'a']));
  });

  it('treats an absent field and an undefined field alike', () => {
    assert.equal(canonicalize({ a: 1 }), canonicalize({ a: 1, b: undefined }));
  });

  it('distinguishes null from absent', () => {
    assert.notEqual(canonicalize({ a: 1 }), canonicalize({ a: 1, b: null }));
  });

  it('rejects excessive nesting rather than recursing without bound', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 64; i += 1) deep = { nested: deep };
    assert.throws(() => canonicalize(deep), RangeError);
  });

  it('rejects non-finite numbers', () => {
    assert.throws(() => canonicalize({ a: Number.NaN }), TypeError);
    assert.throws(() => canonicalize({ a: Number.POSITIVE_INFINITY }), TypeError);
  });

  it('rejects values it cannot canonicalize', () => {
    assert.throws(() => canonicalize({ a: () => 1 }), TypeError);
  });
});

describe('hashPayload', () => {
  it('produces a stable hex digest', () => {
    assert.match(hashPayload({ a: 1 }), /^[0-9a-f]{64}$/);
    assert.equal(hashPayload({ a: 1, b: 2 }), hashPayload({ b: 2, a: 1 }));
  });

  it('changes when any value changes', () => {
    assert.notEqual(hashPayload({ a: 1 }), hashPayload({ a: 2 }));
  });

  it('does not collide across differently-shaped payloads with similar text', () => {
    assert.notEqual(hashPayload({ ab: 'c' }), hashPayload({ a: 'bc' }));
  });
});
