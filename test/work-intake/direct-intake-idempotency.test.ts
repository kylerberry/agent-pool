import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { acceptDirectTasks } from '../../src/domains/work-intake/direct-intake.ts';
import { InMemoryIdempotencyStore } from '../../src/domains/work-intake/idempotency.ts';
import { isRejection } from '../../src/domains/work-intake/contracts.ts';
import { accepted, body, deps, unit } from './direct-intake.fixtures.ts';

describe('acceptDirectTasks — caller-scoped idempotency (AC4)', () => {
  it('replays the original result for the same key and payload', () => {
    const dependencies = deps();
    const request = { callerId: 'c', body: body({ unit: unit() }), idempotencyKey: 'k1' };

    const first = accepted(acceptDirectTasks(request, dependencies));
    const second = accepted(acceptDirectTasks({ ...request, body: body({ unit: unit() }) }, dependencies));

    assert.equal(second.replayed, true);
    assert.equal(first.replayed, false);

    // The replay must be the original result in every respect but the flag
    // that marks it a replay — no field may be recomputed on the second call.
    const { replayed: _first, ...firstRest } = first;
    const { replayed: _second, ...secondRest } = second;
    assert.deepEqual(secondRest, firstRest);
  });

  it('replays without consuming a new submission id', () => {
    let generated = 0;
    const dependencies = {
      store: new InMemoryIdempotencyStore(),
      generateSubmissionId: () => `sub-${++generated}`,
    };
    const request = { callerId: 'c', body: body({ unit: unit() }), idempotencyKey: 'k1' };
    acceptDirectTasks(request, dependencies);
    acceptDirectTasks(request, dependencies);
    assert.equal(generated, 1, 'a replay must not mint a fresh submission id');
  });

  it('replays regardless of key ordering in the retried payload', () => {
    const dependencies = deps();
    const first = accepted(
      acceptDirectTasks(
        { callerId: 'c', body: { repo: 'owner/repo', branch: 'main', unit: unit() }, idempotencyKey: 'k1' },
        dependencies,
      ),
    );
    const second = accepted(
      acceptDirectTasks(
        {
          callerId: 'c',
          body: { unit: { acceptance_criteria: ['the thing is changed'], change_spec: 'change the thing', intent: 'do the thing', id: 'a' }, branch: 'main', repo: 'owner/repo' },
          idempotencyKey: 'k1',
        },
        dependencies,
      ),
    );
    assert.equal(second.submission_id, first.submission_id);
    assert.equal(second.replayed, true);
  });

  it('rejects the same key with a changed payload', () => {
    const dependencies = deps();
    acceptDirectTasks({ callerId: 'c', body: body({ unit: unit() }), idempotencyKey: 'k1' }, dependencies);

    const conflict = acceptDirectTasks(
      {
        callerId: 'c',
        body: body({ unit: unit({ acceptance_criteria: ['a different criterion'] }) }),
        idempotencyKey: 'k1',
      },
      dependencies,
    );

    assert.equal(isRejection(conflict), true);
    assert.deepEqual(
      isRejection(conflict) ? conflict.violations.map((v) => v.code) : [],
      ['IDEMPOTENCY_KEY_PAYLOAD_MISMATCH'],
    );
  });

  it('detects a changed payload even when only the branch differs', () => {
    const dependencies = deps();
    acceptDirectTasks({ callerId: 'c', body: body({ unit: unit() }), idempotencyKey: 'k1' }, dependencies);
    const conflict = acceptDirectTasks(
      { callerId: 'c', body: body({ branch: 'other', unit: unit() }), idempotencyKey: 'k1' },
      dependencies,
    );
    assert.equal(isRejection(conflict), true);
  });

  it('scopes keys per caller — the same key from another caller is a fresh submission', () => {
    const dependencies = deps();
    const first = accepted(
      acceptDirectTasks({ callerId: 'caller-a', body: body({ unit: unit() }), idempotencyKey: 'k1' }, dependencies),
    );
    const second = accepted(
      acceptDirectTasks({ callerId: 'caller-b', body: body({ unit: unit() }), idempotencyKey: 'k1' }, dependencies),
    );
    assert.notEqual(second.submission_id, first.submission_id);
    assert.equal(second.replayed, false);
  });

  it('cannot be tricked into a scope collision by crafted caller ids and keys', () => {
    const dependencies = deps();
    // Without length-prefixed scope components these two would share a key.
    const first = accepted(
      acceptDirectTasks({ callerId: 'a|b', body: body({ unit: unit() }), idempotencyKey: 'c' }, dependencies),
    );
    const second = accepted(
      acceptDirectTasks({ callerId: 'a', body: body({ unit: unit() }), idempotencyKey: 'b|c' }, dependencies),
    );
    assert.notEqual(second.submission_id, first.submission_id);
    assert.equal(second.replayed, false);
  });

  it('treats each submission without a key as new', () => {
    const dependencies = deps();
    const first = accepted(acceptDirectTasks({ callerId: 'c', body: body({ unit: unit() }) }, dependencies));
    const second = accepted(acceptDirectTasks({ callerId: 'c', body: body({ unit: unit() }) }, dependencies));
    assert.notEqual(second.submission_id, first.submission_id);
    assert.equal(dependencies.store.size, 0);
  });

  it('does not burn the key on a rejected payload', () => {
    const dependencies = deps();
    const rejected = acceptDirectTasks(
      { callerId: 'c', body: body({ unit: { id: 'a' } }), idempotencyKey: 'k1' },
      dependencies,
    );
    assert.equal(isRejection(rejected), true);
    assert.equal(dependencies.store.size, 0);

    const retried = accepted(
      acceptDirectTasks({ callerId: 'c', body: body({ unit: unit() }), idempotencyKey: 'k1' }, dependencies),
    );
    assert.equal(retried.replayed, false);
  });

  it('fails closed when the store is full rather than evicting a record', () => {
    // Eviction would silently break the replay guarantee: a retry after
    // eviction would re-execute as a fresh submission.
    const dependencies = {
      store: new InMemoryIdempotencyStore(1),
      generateSubmissionId: (() => {
        let n = 0;
        return () => `sub-${++n}`;
      })(),
    };
    acceptDirectTasks({ callerId: 'c', body: body({ unit: unit() }), idempotencyKey: 'k1' }, dependencies);
    assert.throws(
      () =>
        acceptDirectTasks(
          { callerId: 'c', body: body({ unit: unit({ id: 'b' }) }), idempotencyKey: 'k2' },
          dependencies,
        ),
      /idempotency store is full/,
    );
    // The already-recorded key still replays correctly.
    const replay = acceptDirectTasks(
      { callerId: 'c', body: body({ unit: unit() }), idempotencyKey: 'k1' },
      dependencies,
    );
    assert.equal(isRejection(replay), false);
  });

  it('rejects a malformed idempotency key', () => {
    for (const key of ['', ' ', 'has space', 'has\ttab', 'x'.repeat(256)]) {
      const result = acceptDirectTasks(
        { callerId: 'c', body: body({ unit: unit() }), idempotencyKey: key },
        deps(),
      );
      assert.equal(isRejection(result), true, `key ${JSON.stringify(key)} must be rejected`);
      assert.deepEqual(
        isRejection(result) ? result.violations.map((v) => v.code) : [],
        ['INVALID_IDEMPOTENCY_KEY'],
      );
    }
  });

  it('requires an authenticated caller id', () => {
    for (const callerId of ['', '   ']) {
      const result = acceptDirectTasks({ callerId, body: body({ unit: unit() }) }, deps());
      assert.equal(isRejection(result), true);
      assert.deepEqual(isRejection(result) ? result.violations.map((v) => v.code) : [], ['UNAUTHENTICATED']);
    }
  });
});
