import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { findUnorderableUnits, validateSubmission } from '../../src/domains/work-intake/unit-validation.ts';
import { INTAKE_LIMITS } from '../../src/domains/work-intake/contracts.ts';

const unit = (overrides: Record<string, unknown> = {}) => ({
  id: 'a',
  intent: 'do the thing',
  change_spec: 'change the thing',
  acceptance_criteria: ['the thing is changed'],
  ...overrides,
});

const submission = (overrides: Record<string, unknown> = {}) => ({
  repo: 'owner/repo',
  branch: 'main',
  ...overrides,
});

function codes(body: unknown): string[] {
  const result = validateSubmission(body);
  assert.equal(result.ok, false, 'expected validation to fail');
  return result.ok ? [] : result.violations.map((v) => v.code);
}

describe('validateSubmission — one boundary, two shapes (AC1)', () => {
  it('accepts a single direct unit', () => {
    const result = validateSubmission(submission({ unit: unit() }));
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.shape, 'single_unit');
    assert.equal(result.ok && result.value.units.length, 1);
  });

  it('accepts a flat unit array with depends_on edges', () => {
    const result = validateSubmission(
      submission({
        units: [unit({ id: 'a' }), unit({ id: 'b', depends_on: ['a'] }), unit({ id: 'c', depends_on: ['a', 'b'] })],
      }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.shape, 'hand_authored_dag');
    assert.equal(result.ok && result.value.units.length, 3);
  });

  it('accepts convergence — a unit with multiple parents', () => {
    const result = validateSubmission(
      submission({
        units: [unit({ id: 'a' }), unit({ id: 'b' }), unit({ id: 'c', depends_on: ['a', 'b'] })],
      }),
    );
    assert.equal(result.ok, true);
  });

  it('rejects a submission carrying both unit and units', () => {
    assert.ok(codes(submission({ unit: unit(), units: [unit()] })).includes('AMBIGUOUS_SUBMISSION_SHAPE'));
  });

  it('rejects a submission carrying neither', () => {
    assert.ok(codes(submission()).includes('EMPTY_SUBMISSION'));
  });

  it('rejects an empty units array', () => {
    assert.ok(codes(submission({ units: [] })).includes('EMPTY_SUBMISSION'));
  });

  it('rejects dependencies on a single-unit submission', () => {
    assert.ok(
      codes(submission({ unit: unit({ depends_on: ['nonexistent'] }) })).includes(
        'SINGLE_UNIT_HAS_DEPENDENCIES',
      ),
    );
  });
});

describe('validateSubmission — deterministic rejections (AC2)', () => {
  it('rejects duplicate unit ids', () => {
    assert.ok(codes(submission({ units: [unit({ id: 'a' }), unit({ id: 'a' })] })).includes('DUPLICATE_UNIT_ID'));
  });

  it('rejects a dependency on an unknown unit', () => {
    assert.ok(
      codes(submission({ units: [unit({ id: 'a', depends_on: ['ghost'] })] })).includes('UNKNOWN_DEPENDENCY'),
    );
  });

  it('rejects a self dependency', () => {
    assert.ok(codes(submission({ units: [unit({ id: 'a', depends_on: ['a'] })] })).includes('SELF_DEPENDENCY'));
  });

  it('rejects a two-node cycle', () => {
    assert.ok(
      codes(
        submission({ units: [unit({ id: 'a', depends_on: ['b'] }), unit({ id: 'b', depends_on: ['a'] })] }),
      ).includes('DEPENDENCY_CYCLE'),
    );
  });

  it('rejects a longer cycle', () => {
    assert.ok(
      codes(
        submission({
          units: [
            unit({ id: 'a', depends_on: ['c'] }),
            unit({ id: 'b', depends_on: ['a'] }),
            unit({ id: 'c', depends_on: ['b'] }),
          ],
        }),
      ).includes('DEPENDENCY_CYCLE'),
    );
  });

  it('names every unit in the cycle, sorted', () => {
    const result = validateSubmission(
      submission({ units: [unit({ id: 'z', depends_on: ['y'] }), unit({ id: 'y', depends_on: ['z'] })] }),
    );
    assert.equal(result.ok, false);
    const cycle = result.ok ? undefined : result.violations.find((v) => v.code === 'DEPENDENCY_CYCLE');
    assert.match(cycle?.message ?? '', /y, z/);
  });

  it('rejects unknown fields on a unit', () => {
    assert.ok(codes(submission({ unit: unit({ status: 'pending' }) })).includes('UNKNOWN_FIELD'));
  });

  it('rejects controller-owned and C-owned fields specifically (ADR-018)', () => {
    for (const field of ['status', 'retry_count', 'budget_spent', 'required_role', 'complexity']) {
      assert.ok(
        codes(submission({ unit: unit({ [field]: 'x' }) })).includes('UNKNOWN_FIELD'),
        `${field} must be rejected as an unknown field`,
      );
    }
  });

  it('rejects unknown fields on the submission envelope', () => {
    assert.ok(codes(submission({ unit: unit(), priority: 'high' })).includes('UNKNOWN_FIELD'));
  });

  it('rejects missing acceptance criteria', () => {
    const withoutCriteria = unit();
    delete (withoutCriteria as Record<string, unknown>).acceptance_criteria;
    assert.ok(codes(submission({ unit: withoutCriteria })).includes('MISSING_ACCEPTANCE_CRITERIA'));
  });

  it('rejects an empty acceptance criteria array', () => {
    assert.ok(
      codes(submission({ unit: unit({ acceptance_criteria: [] }) })).includes('MISSING_ACCEPTANCE_CRITERIA'),
    );
  });

  it('rejects blank acceptance criteria', () => {
    assert.ok(
      codes(submission({ unit: unit({ acceptance_criteria: ['   '] }) })).includes(
        'MISSING_ACCEPTANCE_CRITERIA',
      ),
    );
  });

  it('rejects non-string acceptance criteria', () => {
    assert.ok(codes(submission({ unit: unit({ acceptance_criteria: [42] }) })).includes('INVALID_FIELD_TYPE'));
  });

  it('rejects duplicate dependency entries', () => {
    assert.ok(
      codes(
        submission({ units: [unit({ id: 'a' }), unit({ id: 'b', depends_on: ['a', 'a'] })] }),
      ).includes('DUPLICATE_DEPENDENCY'),
    );
  });

  it('produces byte-identical violations for identical payloads', () => {
    const body = submission({ units: [unit({ id: 'a', depends_on: ['a'] }), unit({ id: 'a' })] });
    const first = validateSubmission(structuredClone(body));
    const second = validateSubmission(structuredClone(body));
    assert.equal(first.ok, false);
    assert.deepEqual(
      first.ok ? null : first.violations,
      second.ok ? null : (second as { violations: unknown }).violations,
    );
  });

  it('orders violations independently of unit ordering in the payload', () => {
    const result = validateSubmission(
      submission({ units: [unit({ id: 'b', status: 'x' }), unit({ id: 'a', status: 'x' })] }),
    );
    assert.equal(result.ok, false);
    const paths = result.ok ? [] : result.violations.map((v) => v.path);
    assert.deepEqual(paths, [...paths].sort());
  });
});

describe('validateSubmission — malformed and hostile input', () => {
  it('rejects non-object bodies', () => {
    for (const body of [null, undefined, 'string', 42, true, []]) {
      assert.ok(codes(body).includes('MALFORMED_BODY'), `${JSON.stringify(body)} must be malformed`);
    }
  });

  it('rejects a missing repo or branch', () => {
    assert.ok(codes({ branch: 'main', unit: unit() }).includes('MISSING_FIELD'));
    assert.ok(codes({ repo: 'owner/repo', unit: unit() }).includes('MISSING_FIELD'));
  });

  it('rejects a blank repo', () => {
    assert.ok(codes(submission({ repo: '  ', unit: unit() })).includes('MISSING_FIELD'));
  });

  it('rejects a non-object unit', () => {
    assert.ok(codes(submission({ unit: 'not a unit' })).includes('INVALID_FIELD_TYPE'));
  });

  it('rejects a non-array units field', () => {
    assert.ok(codes(submission({ units: { a: 1 } })).includes('INVALID_FIELD_TYPE'));
  });

  it('rejects more units than the hard limit', () => {
    const units = Array.from({ length: INTAKE_LIMITS.maxUnits + 1 }, (_, i) => unit({ id: `u${i}` }));
    assert.ok(codes(submission({ units })).includes('TOO_MANY_UNITS'));
  });

  it('rejects oversized strings', () => {
    assert.ok(
      codes(submission({ unit: unit({ change_spec: 'x'.repeat(INTAKE_LIMITS.maxChangeSpecLength + 1) }) })).includes(
        'FIELD_TOO_LONG',
      ),
    );
  });

  it('treats a JSON-parsed __proto__ key as an unknown field, not a prototype write', () => {
    const body = JSON.parse('{"repo":"o/r","branch":"main","unit":{"__proto__":{"polluted":true}}}');
    assert.ok(codes(body).includes('UNKNOWN_FIELD'));
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  it('does not pollute the object prototype via a constructor key', () => {
    const body = JSON.parse('{"repo":"o/r","branch":"main","constructor":{"x":1},"unit":{}}');
    assert.ok(codes(body).includes('UNKNOWN_FIELD'));
    assert.equal(({} as Record<string, unknown>).x, undefined);
  });

  it('rejects malformed repo targets', () => {
    for (const repo of ['no-slash', 'a/b/c', '../escape', 'owner/repo; rm -rf /', 'owner/re po']) {
      assert.ok(
        codes(submission({ repo, unit: unit() })).includes('INVALID_FIELD_FORMAT'),
        `repo ${JSON.stringify(repo)} must be rejected`,
      );
    }
  });

  it('rejects branch names that are unsafe to pass downstream', () => {
    for (const branch of ['--upload-pack=evil', 'feature/../../etc', 'has space', 'has;semicolon']) {
      assert.ok(
        codes(submission({ branch, unit: unit() })).includes('INVALID_FIELD_FORMAT'),
        `branch ${JSON.stringify(branch)} must be rejected`,
      );
    }
  });

  it('accepts ordinary repo and branch targets', () => {
    for (const branch of ['main', 'feature/some-thing', 'release/1.2.3', 'fix_42']) {
      assert.equal(validateSubmission(submission({ branch, unit: unit() })).ok, true, branch);
    }
  });

  it('truncates a caller-supplied key when echoing it back in a violation', () => {
    const longKey = 'k'.repeat(5_000);
    const result = validateSubmission(submission({ unit: unit({ [longKey]: 1 }) }));
    assert.equal(result.ok, false);
    const unknown = result.ok ? undefined : result.violations.find((v) => v.code === 'UNKNOWN_FIELD');
    assert.ok((unknown?.path.length ?? 0) < 100, 'echoed key must be truncated');
  });

  it('reports too many acceptance criteria as an oversized field', () => {
    const criteria = Array.from({ length: INTAKE_LIMITS.maxCriteriaPerUnit + 1 }, (_, i) => `c${i}`);
    assert.ok(codes(submission({ unit: unit({ acceptance_criteria: criteria }) })).includes('FIELD_TOO_LONG'));
  });

  it('rejects an object whose fields are only reachable through its prototype', () => {
    // No own keys, so an unknown-field scan sees nothing, yet every read
    // resolves through the prototype chain.
    const disguised = Object.create({ repo: 'owner/repo', branch: 'main', unit: unit() });
    assert.ok(codes(disguised).includes('MALFORMED_BODY'));
  });

  it('rejects a unit whose fields are only inherited', () => {
    const disguisedUnit = Object.create(unit());
    assert.ok(codes(submission({ unit: disguisedUnit })).includes('INVALID_FIELD_TYPE'));
  });

  it('caps the number of reported violations', () => {
    const hostile: Record<string, unknown> = { ...unit() };
    for (let i = 0; i < 10_000; i += 1) hostile[`junk${i}`] = i;
    const result = validateSubmission(submission({ unit: hostile }));
    assert.equal(result.ok, false);
    const count = result.ok ? 0 : result.violations.length;
    assert.ok(count > 0 && count <= 100, `expected a capped violation list, got ${count}`);
  });

  it('caps deterministically — the same hostile payload yields the same subset', () => {
    const build = () => {
      const hostile: Record<string, unknown> = { ...unit() };
      for (let i = 0; i < 500; i += 1) hostile[`junk${i}`] = i;
      return validateSubmission(submission({ unit: hostile }));
    };
    const a = build();
    const b = build();
    assert.deepEqual(a.ok ? null : a.violations, b.ok ? null : (b as { violations: unknown }).violations);
  });

  it('rejects git-invalid branch and repo shapes', () => {
    for (const branch of ['feature//x', '/leading', 'trailing/', 'a/./b', '.']) {
      assert.ok(
        codes(submission({ branch, unit: unit() })).includes('INVALID_FIELD_FORMAT'),
        `branch ${JSON.stringify(branch)} must be rejected`,
      );
    }
    for (const repo of ['./repo', 'owner/.', '../repo']) {
      assert.ok(
        codes(submission({ repo, unit: unit() })).includes('INVALID_FIELD_FORMAT'),
        `repo ${JSON.stringify(repo)} must be rejected`,
      );
    }
  });

  it('handles a deep dependency chain without stack overflow', () => {
    const units = Array.from({ length: 300 }, (_, i) =>
      unit({ id: `u${i}`, ...(i === 0 ? {} : { depends_on: [`u${i - 1}`] }) }),
    );
    assert.equal(validateSubmission(submission({ units })).ok, true);
  });
});

describe('findUnorderableUnits', () => {
  it('returns nothing for an acyclic graph', () => {
    assert.deepEqual(
      findUnorderableUnits([
        { id: 'a', intent: 'i', change_spec: 'c', acceptance_criteria: ['x'] },
        { id: 'b', intent: 'i', change_spec: 'c', acceptance_criteria: ['x'], depends_on: ['a'] },
      ]),
      [],
    );
  });

  it('returns the cycle members for a cyclic graph', () => {
    assert.deepEqual(
      findUnorderableUnits([
        { id: 'a', intent: 'i', change_spec: 'c', acceptance_criteria: ['x'], depends_on: ['b'] },
        { id: 'b', intent: 'i', change_spec: 'c', acceptance_criteria: ['x'], depends_on: ['a'] },
      ]),
      ['a', 'b'],
    );
  });
});
