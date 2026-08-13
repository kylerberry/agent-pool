import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { acceptDirectTasks } from '../../src/domains/work-intake/direct-intake.ts';
import { InMemoryIdempotencyStore } from '../../src/domains/work-intake/idempotency.ts';
import { isRejection } from '../../src/domains/work-intake/contracts.ts';
import { accepted, body, deps, unit } from './direct-intake.fixtures.ts';

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
