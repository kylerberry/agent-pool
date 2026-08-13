import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { acceptDirectTasks } from '../../src/domains/work-intake/direct-intake.ts';
import { InMemoryIdempotencyStore } from '../../src/domains/work-intake/idempotency.ts';
import { isRejection } from '../../src/domains/work-intake/contracts.ts';
import { accepted, body, deps, unit } from './direct-intake.fixtures.ts';

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
