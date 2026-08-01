import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateRoutingPolicyPublication } from '../../src/domains/model-routing-and-evaluation/routing-policy.ts';

const validPublication = {
  version: 2,
  status: 'eval-derived',
  actor: 'pool-worker',
  source: 'builder-eval-run-2026-07',
  roles: {
    building: { primary: 'moonshot/kimi-k2.7-code', fallback: ['openai-codex/gpt-5.6-terra'] },
  },
  rules: {
    builderEvaluatorMustDiffer: true,
  },
};

const allowedRoles = new Set(['building']);

describe('validateRoutingPolicyPublication', () => {
  it('accepts a valid publication', () => {
    const pub = validateRoutingPolicyPublication(validPublication, 'pool-worker', allowedRoles);
    assert.equal(pub.version, 2);
    assert.equal(pub.status, 'eval-derived');
    assert.equal(pub.actor, 'pool-worker');
    assert.equal(pub.source, 'builder-eval-run-2026-07');
    assert.equal(pub.roles.building.primary, 'moonshot/kimi-k2.7-code');
    assert.deepEqual(pub.roles.building.fallback, ['openai-codex/gpt-5.6-terra']);
  });

  it('rejects a fractional version', () => {
    assert.throws(
      () => validateRoutingPolicyPublication({ ...validPublication, version: 1.5 }, 'pool-worker', allowedRoles),
      /version.*positive integer/i,
    );
  });

  it('rejects NaN as a version', () => {
    assert.throws(
      () => validateRoutingPolicyPublication({ ...validPublication, version: Number.NaN }, 'pool-worker', allowedRoles),
      /version.*positive integer/i,
    );
  });

  it('rejects Infinity as a version', () => {
    assert.throws(
      () => validateRoutingPolicyPublication(
        { ...validPublication, version: Number.POSITIVE_INFINITY },
        'pool-worker',
        allowedRoles,
      ),
      /version.*positive integer/i,
    );
  });

  it('rejects zero and negative versions', () => {
    assert.throws(
      () => validateRoutingPolicyPublication({ ...validPublication, version: 0 }, 'pool-worker', allowedRoles),
      /version.*positive integer/i,
    );
    assert.throws(
      () => validateRoutingPolicyPublication({ ...validPublication, version: -1 }, 'pool-worker', allowedRoles),
      /version.*positive integer/i,
    );
  });

  it('rejects a non-numeric version', () => {
    assert.throws(
      () => validateRoutingPolicyPublication({ ...validPublication, version: '2' }, 'pool-worker', allowedRoles),
      /version.*positive integer/i,
    );
  });
});
