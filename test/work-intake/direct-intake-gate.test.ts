import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { acceptDirectTasks } from '../../src/domains/work-intake/direct-intake.ts';
import { InMemoryIdempotencyStore } from '../../src/domains/work-intake/idempotency.ts';
import { isRejection } from '../../src/domains/work-intake/contracts.ts';
import { accepted, body, deps, unit } from './direct-intake.fixtures.ts';

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
