import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizeWrite,
  getPhaseGrant,
  isExecutionFailure,
  phaseHasCapability,
} from '../../src/domains/agent-execution/index.ts';

const ROOTS = { workspaceRoot: '/workspace', knowledgeSinkRoot: '/workspace/docs/wiki' };

describe('phase-scoped capability grants', () => {
  it('denies write to every review phase', () => {
    for (const phase of ['C', 'A', 'T']) {
      assert.equal(phaseHasCapability(phase, 'write'), false, `${phase} must not hold write`);
      assert.equal(phaseHasCapability(phase, 'edit'), false, `${phase} must not hold edit`);
      const authorization = authorizeWrite(phase, ROOTS);
      assert.ok(isExecutionFailure(authorization));
      assert.equal(authorization.code, 'CAPABILITY_DENIED');
    }
  });

  it('denies the evaluator any capability to edit what it judges', () => {
    // ADR-029: A's write denial is the load-bearing grant.
    const grant = getPhaseGrant('A');
    assert.ok(!isExecutionFailure(grant));
    assert.equal(grant.writeScope, null);
    assert.deepEqual([...grant.capabilities].sort(), ['graphify', 'grep', 'read']);
  });

  it('grants the builder workspace writes', () => {
    for (const phase of ['R', 'F']) {
      assert.equal(phaseHasCapability(phase, 'write'), true);
      const authorization = authorizeWrite(phase, ROOTS);
      assert.ok(!isExecutionFailure(authorization));
      assert.equal(authorization.scope, 'workspace');
      assert.equal(authorization.root, '/workspace');
    }
  });

  it('confines Sharpen to an owner-approved knowledge sink', () => {
    const authorization = authorizeWrite('S', ROOTS);
    assert.ok(!isExecutionFailure(authorization));
    assert.equal(authorization.scope, 'knowledge-sink');
    assert.equal(authorization.root, '/workspace/docs/wiki');
  });

  it('denies Sharpen a write when no sink has been approved instead of creating one', () => {
    const authorization = authorizeWrite('S', { workspaceRoot: '/workspace' });
    assert.ok(isExecutionFailure(authorization));
    assert.equal(authorization.code, 'WRITE_PATH_OUT_OF_SCOPE');
  });

  it('gives Tighten security tooling without write', () => {
    assert.equal(phaseHasCapability('T', 'security_tooling'), true);
    assert.equal(phaseHasCapability('T', 'write'), false);
  });

  it('fails closed on an unknown or injected phase name', () => {
    for (const phase of ['X', 'r', '', 'constructor', '__proto__', 'toString']) {
      const grant = getPhaseGrant(phase);
      assert.ok(isExecutionFailure(grant), `${phase} must not resolve to a grant`);
      assert.equal(grant.code, 'UNKNOWN_PHASE');
      assert.equal(phaseHasCapability(phase, 'write'), false);
    }
  });

  it('returns immutable grants', () => {
    const grant = getPhaseGrant('R');
    assert.ok(!isExecutionFailure(grant));
    assert.equal(Object.isFrozen(grant), true);
    assert.equal(Object.isFrozen(grant.capabilities), true);
  });
});
