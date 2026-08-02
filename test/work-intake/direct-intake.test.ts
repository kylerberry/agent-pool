import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { acceptDirectTasks } from '../../src/domains/work-intake/direct-intake.ts';
import { InMemoryIdempotencyStore } from '../../src/domains/work-intake/idempotency.ts';
import { isRejection } from '../../src/domains/work-intake/contracts.ts';
import type { DirectTaskAcceptance, DirectTaskResult } from '../../src/domains/work-intake/contracts.ts';

function deps(seed = 0) {
  let counter = seed;
  return {
    store: new InMemoryIdempotencyStore(),
    generateSubmissionId: () => `sub-${++counter}`,
  };
}

const unit = (overrides: Record<string, unknown> = {}) => ({
  id: 'a',
  intent: 'do the thing',
  change_spec: 'change the thing',
  acceptance_criteria: ['the thing is changed'],
  ...overrides,
});

const body = (overrides: Record<string, unknown> = {}) => ({
  repo: 'owner/repo',
  branch: 'main',
  ...overrides,
});

function accepted(result: DirectTaskResult): DirectTaskAcceptance {
  assert.equal(isRejection(result), false, `expected acceptance, got ${JSON.stringify(result)}`);
  return result as DirectTaskAcceptance;
}

describe('acceptDirectTasks — single boundary (AC1)', () => {
  it('accepts one direct unit', () => {
    const result = accepted(acceptDirectTasks({ callerId: 'caller-1', body: body({ unit: unit() }) }, deps()));
    assert.equal(result.submission_shape, 'single_unit');
    assert.equal(result.units.length, 1);
  });

  it('accepts a flat DAG through the same function', () => {
    const result = accepted(
      acceptDirectTasks(
        { callerId: 'caller-1', body: body({ units: [unit({ id: 'a' }), unit({ id: 'b', depends_on: ['a'] })] }) },
        deps(),
      ),
    );
    assert.equal(result.submission_shape, 'hand_authored_dag');
    assert.deepEqual(result.units.map((u) => u.id), ['a', 'b']);
    assert.deepEqual(result.units[1]?.depends_on, ['a']);
  });

  it('normalizes absent depends_on to an empty array', () => {
    const result = accepted(acceptDirectTasks({ callerId: 'c', body: body({ unit: unit() }) }, deps()));
    assert.deepEqual(result.units[0]?.depends_on, []);
  });
});

describe('acceptDirectTasks — criteria preservation and provenance (AC3)', () => {
  it('preserves acceptance criteria exactly, including whitespace and order', () => {
    const criteria = ['  criterion with padding  ', 'SECOND Criterion.', 'third\nwith newline'];
    const result = accepted(
      acceptDirectTasks({ callerId: 'c', body: body({ unit: unit({ acceptance_criteria: criteria }) }) }, deps()),
    );
    assert.deepEqual(result.units[0]?.acceptance_criteria, criteria);
  });

  it('stamps origin=direct_task with source identifiers', () => {
    const result = accepted(
      acceptDirectTasks(
        { callerId: 'caller-7', body: body({ unit: unit({ id: 'unit-x' }) }), idempotencyKey: 'key-1' },
        deps(),
      ),
    );
    const provenance = result.units[0]?.acceptance_criteria_provenance;
    assert.equal(provenance?.origin, 'direct_task');
    assert.equal(provenance?.caller_id, 'caller-7');
    assert.equal(provenance?.unit_id, 'unit-x');
    assert.equal(provenance?.idempotency_key, 'key-1');
    assert.equal(provenance?.submission_id, result.submission_id);
  });

  it('emits the canonical direct_task spelling, never the hyphenated form', () => {
    // Locked from this side too: the worker attempt contract's criteria_origin
    // enum accepts direct_task only, and drift should fail at both ends.
    const result = accepted(acceptDirectTasks({ callerId: 'c', body: body({ unit: unit() }) }, deps()));
    const origin = result.units[0]?.acceptance_criteria_provenance.origin;
    assert.equal(origin, 'direct_task');
    assert.notEqual(origin as string, 'direct-task');
  });

  it('supplies a non-empty caller-facing id for criteria_origin.source_id', () => {
    // The worker contract requires source_id minLength 1; submission_id is the
    // caller-facing value that maps there.
    const result = accepted(acceptDirectTasks({ callerId: 'c', body: body({ unit: unit() }) }, deps()));
    assert.ok(result.submission_id.trim().length > 0);
    assert.equal(result.units[0]?.acceptance_criteria_provenance.submission_id, result.submission_id);
  });

  it('fails loudly when the injected id generator returns a blank id', () => {
    for (const bad of ['', '   ']) {
      assert.throws(
        () =>
          acceptDirectTasks(
            { callerId: 'c', body: body({ unit: unit() }) },
            { store: new InMemoryIdempotencyStore(), generateSubmissionId: () => bad },
          ),
        /non-empty caller-facing identifier/,
      );
    }
  });

  it('records a null idempotency key when none was supplied', () => {
    const result = accepted(acceptDirectTasks({ callerId: 'c', body: body({ unit: unit() }) }, deps()));
    assert.equal(result.units[0]?.acceptance_criteria_provenance.idempotency_key, null);
  });

  it('stamps every unit of a DAG with its own unit_id', () => {
    const result = accepted(
      acceptDirectTasks(
        { callerId: 'c', body: body({ units: [unit({ id: 'a' }), unit({ id: 'b', depends_on: ['a'] })] }) },
        deps(),
      ),
    );
    assert.deepEqual(
      result.units.map((u) => u.acceptance_criteria_provenance.unit_id),
      ['a', 'b'],
    );
  });

  it('freezes accepted criteria so they cannot drift after intake', () => {
    const result = accepted(acceptDirectTasks({ callerId: 'c', body: body({ unit: unit() }) }, deps()));
    assert.throws(() => {
      (result.units[0]!.acceptance_criteria as string[]).push('smuggled criterion');
    }, TypeError);
  });

  it('does not alias the caller array — later caller mutation cannot change stored criteria', () => {
    const criteria = ['original'];
    const result = accepted(
      acceptDirectTasks({ callerId: 'c', body: body({ unit: unit({ acceptance_criteria: criteria }) }) }, deps()),
    );
    criteria.push('added afterwards');
    assert.deepEqual(result.units[0]?.acceptance_criteria, ['original']);
  });
});

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

describe('acceptDirectTasks — Gate 2 and no decomposition (AC5)', () => {
  it('marks Gate 2 required and Gate 1 skipped on every acceptance', () => {
    for (const payload of [body({ unit: unit() }), body({ units: [unit({ id: 'a' })] })]) {
      const result = accepted(acceptDirectTasks({ callerId: 'c', body: payload }, deps()));
      assert.equal(result.gate2_required, true);
      assert.equal(result.gate1_required, false);
    }
  });

  it('keeps Gate 2 required on a replayed result', () => {
    const dependencies = deps();
    const request = { callerId: 'c', body: body({ unit: unit() }), idempotencyKey: 'k1' };
    acceptDirectTasks(request, dependencies);
    const replay = accepted(acceptDirectTasks(request, dependencies));
    assert.equal(replay.replayed, true);
    assert.equal(replay.gate2_required, true);
  });

  it('records that no decomposition ran', () => {
    const result = accepted(acceptDirectTasks({ callerId: 'c', body: body({ unit: unit() }) }, deps()));
    assert.equal(result.decomposition_invoked, false);
  });

  it('no caller input can clear the Gate 2 flag', () => {
    const smuggled = acceptDirectTasks(
      { callerId: 'c', body: { ...body({ unit: unit() }), gate2_required: false } },
      deps(),
    );
    assert.equal(isRejection(smuggled), true);
    assert.ok(isRejection(smuggled) && smuggled.violations.some((v) => v.code === 'UNKNOWN_FIELD'));
  });

  it('is synchronous — the boundary cannot await a model call', () => {
    assert.equal(acceptDirectTasks.constructor.name, 'Function');
    const result = acceptDirectTasks({ callerId: 'c', body: body({ unit: unit() }) }, deps());
    assert.equal(result instanceof Promise, false);
  });

  it('makes no network call while accepting a submission', () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (() => {
      called = true;
      throw new Error('the direct-task path must not make a network call');
    }) as typeof fetch;
    try {
      accepted(acceptDirectTasks({ callerId: 'c', body: body({ unit: unit() }) }, deps()));
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(called, false);
  });
});
