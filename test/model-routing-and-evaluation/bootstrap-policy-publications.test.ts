import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadWorkerBootstrapPolicy,
  loadOrchestratorBootstrapPolicy,
  loadWorkerEvalPublication,
  loadOrchestratorEvalPublication,
} from '../../src/domains/model-routing-and-evaluation/bootstrap-policy.ts';
import * as bp from '../../src/domains/model-routing-and-evaluation/bootstrap-policy.ts';
import { APPROVED_MODELS } from '../../src/domains/model-routing-and-evaluation/approved-models.ts';
import { orchestratorFixture, workerFixture } from './bootstrap-policy.fixtures.ts';

describe('eval-derived policy publications', () => {
  const validWorkerPublication = {
    version: 2,
    status: 'eval-derived',
    actor: 'pool-worker',
    source: 'builder-eval-run-2026-07',
    capability_rank: {
      'openai-codex/gpt-5.6-luna': 1,
      'moonshot/kimi-k2.7-code': 2,
      'openai-codex/gpt-5.6-terra': 3,
      'moonshot/kimi-k3': 4,
      'openai-codex/gpt-5.6-sol': 5,
    },
    roles: {
      node_conductor: { primary: 'openai-codex/gpt-5.6-terra', fallback: ['moonshot/kimi-k3'] },
      planning: { primary: 'openai-codex/gpt-5.6-terra', fallback: ['moonshot/kimi-k3'] },
      building: { primary: 'moonshot/kimi-k2.7-code', fallback: ['openai-codex/gpt-5.6-terra'] },
      assessing: { primary: 'openai-codex/gpt-5.6-sol', fallback: ['moonshot/kimi-k3'] },
      tightening: { primary: 'openai-codex/gpt-5.6-sol', fallback: ['openai-codex/gpt-5.6-terra'] },
      sharpening: { primary: 'openai-codex/gpt-5.6-luna', fallback: ['openai-codex/gpt-5.6-terra'] },
      failure_diagnosis: { primary: 'openai-codex/gpt-5.6-terra', fallback: ['openai-codex/gpt-5.6-sol'] },
    },
    rules: {
      builderEvaluatorMustDiffer: true,
      evaluatorMustNotBeLowerCapability: true,
      reserveSolFromNormalBuilding: true,
      failClosedOnUnavailableExplicitModel: true,
    },
  };

  const validOrchestratorPublication = {
    version: 2,
    status: 'eval-derived',
    actor: 'orchestrator-control-plane',
    source: 'decomposition-eval-run-2026-07',
    roles: {
      decomposition: { primary: 'moonshot/kimi-k3', fallback: ['openai-codex/gpt-5.6-sol'] },
    },
    rules: {
      failClosedOnUnavailableExplicitModel: true,
    },
  };

  it('accepts a valid worker eval-derived publication', () => {
    const policy = loadWorkerEvalPublication(validWorkerPublication);
    assert.equal(policy.version, 2);
    assert.equal(policy.status, 'eval-derived');
    assert.equal(policy.actor, 'pool-worker');
    assert.equal(policy.getCapabilityRank('openai-codex/gpt-5.6-sol'), 5);
    const building = policy.getRoleConfig('building');
    assert.ok(building);
    assert.equal(building!.primary, 'moonshot/kimi-k2.7-code');
  });

  it('accepts a valid orchestrator eval-derived publication', () => {
    const policy = loadOrchestratorEvalPublication(validOrchestratorPublication);
    assert.equal(policy.version, 2);
    assert.equal(policy.actor, 'orchestrator-control-plane');
    const decomposition = policy.getRoleConfig('decomposition');
    assert.ok(decomposition);
    assert.equal(decomposition!.primary, 'moonshot/kimi-k3');
  });

  it('accepts a builder-only worker eval-derived publication', () => {
    const builderOnly = {
      ...validWorkerPublication,
      source: 'builder-rf-eval-run-2026-07',
      roles: {
        building: { primary: 'moonshot/kimi-k2.7-code', fallback: ['openai-codex/gpt-5.6-terra'] },
      },
    };
    const policy = loadWorkerEvalPublication(builderOnly);
    assert.ok(policy.getRoleConfig('building'));
    assert.equal(policy.getRoleConfig('planning'), undefined);
  });

  it('rejects an eval-derived publication with a non-eval-derived status', () => {
    const tampered = { ...validWorkerPublication, status: 'published' };
    assert.throws(() => loadWorkerEvalPublication(tampered), /status/i);
  });

  it('rejects an unapproved model in a publication', () => {
    const tampered = {
      ...validWorkerPublication,
      roles: {
        ...validWorkerPublication.roles,
        building: { primary: 'anthropic/claude_sonnet', fallback: [] },
      },
    };
    assert.throws(() => loadWorkerEvalPublication(tampered), /approved/i);
  });

  it('rejects aliases and unqualified IDs in publications', () => {
    const aliasPub = {
      ...validWorkerPublication,
      roles: {
        ...validWorkerPublication.roles,
        building: { primary: 'moonshot/kimi-k2.7', fallback: [] },
      },
    };
    assert.throws(() => loadWorkerEvalPublication(aliasPub), /approved/i);
  });

  it('rejects unknown fields in publications', () => {
    const tampered = { ...validWorkerPublication, empiricalThreshold: 0.85 };
    assert.throws(() => loadWorkerEvalPublication(tampered), /unknown/i);
  });

  it('rejects unknown rules in worker eval-derived publications', () => {
    const tampered = {
      ...validWorkerPublication,
      rules: { ...validWorkerPublication.rules, fakeRule: true },
    };
    assert.throws(() => loadWorkerEvalPublication(tampered), /unknown|rule/i);
  });

  it('rejects disabled builder/evaluator diversity in eval-derived publications', () => {
    const tampered = {
      ...validWorkerPublication,
      rules: { ...validWorkerPublication.rules, builderEvaluatorMustDiffer: false },
    };
    assert.throws(() => loadWorkerEvalPublication(tampered), /builder.*evaluator|diversity/i);
  });

  it('rejects disabled evaluator capability invariant in eval-derived publications', () => {
    const tampered = {
      ...validWorkerPublication,
      rules: { ...validWorkerPublication.rules, evaluatorMustNotBeLowerCapability: false },
    };
    assert.throws(() => loadWorkerEvalPublication(tampered), /evaluator|capability/i);
  });

  it('rejects malformed version and status', () => {
    assert.throws(() => loadWorkerEvalPublication({ ...validWorkerPublication, version: '2' }), /version/i);
    assert.throws(() => loadWorkerEvalPublication({ ...validWorkerPublication, status: '' }), /status/i);
  });

  it('rejects non-integer versions in worker eval-derived publications', () => {
    assert.throws(() => loadWorkerEvalPublication({ ...validWorkerPublication, version: 1.5 }), /version/i);
    assert.throws(() => loadWorkerEvalPublication({ ...validWorkerPublication, version: Number.NaN }), /version/i);
    assert.throws(() => loadWorkerEvalPublication({ ...validWorkerPublication, version: Number.POSITIVE_INFINITY }), /version/i);
  });

  it('rejects non-integer versions in orchestrator eval-derived publications', () => {
    assert.throws(() => loadOrchestratorEvalPublication({ ...validOrchestratorPublication, version: 1.5 }), /version/i);
    assert.throws(() => loadOrchestratorEvalPublication({ ...validOrchestratorPublication, version: Number.NaN }), /version/i);
    assert.throws(() => loadOrchestratorEvalPublication({ ...validOrchestratorPublication, version: Number.POSITIVE_INFINITY }), /version/i);
  });

  it('rejects duplicate candidates in a publication role config', () => {
    const tampered = {
      ...validWorkerPublication,
      roles: {
        ...validWorkerPublication.roles,
        building: { primary: 'moonshot/kimi-k2.7-code', fallback: ['moonshot/kimi-k2.7-code'] },
      },
    };
    assert.throws(() => loadWorkerEvalPublication(tampered), /duplicate/i);
  });

  it('rejects unknown fields in a publication role config', () => {
    const tampered = {
      ...validWorkerPublication,
      roles: {
        ...validWorkerPublication.roles,
        building: { primary: 'moonshot/kimi-k2.7-code', fallback: [], extra: 'x' },
      },
    };
    assert.throws(() => loadWorkerEvalPublication(tampered), /unknown/i);
  });

  it('rejects missing required worker roles no longer as a blanket requirement', () => {
    // Per-role evidence means a publication may be incomplete, but it must not claim
    // a role it does not own. A worker publication without building is accepted;
    // routing for missing roles will fail closed at the router.
    const { building: _, ...remainingRoles } = validWorkerPublication.roles;
    const tampered = { ...validWorkerPublication, roles: remainingRoles };
    const policy = loadWorkerEvalPublication(tampered);
    assert.equal(policy.getRoleConfig('building'), undefined);
  });

  it('rejects worker publications containing decomposition', () => {
    const tampered = {
      ...validWorkerPublication,
      roles: {
        ...validWorkerPublication.roles,
        decomposition: { primary: 'moonshot/kimi-k3', fallback: [] },
      },
    };
    assert.throws(() => loadWorkerEvalPublication(tampered), /decomposition/i);
  });

  it('rejects orchestrator publications containing worker roles', () => {
    const tampered = {
      ...validOrchestratorPublication,
      roles: {
        ...validOrchestratorPublication.roles,
        building: { primary: 'moonshot/kimi-k2.7-code', fallback: [] },
      },
    };
    assert.throws(() => loadOrchestratorEvalPublication(tampered), /building/i);
  });

  it('rejects publications whose actor disagrees with their role set', () => {
    assert.throws(() => loadOrchestratorEvalPublication(validWorkerPublication), /actor/i);
    assert.throws(() => loadWorkerEvalPublication(validOrchestratorPublication), /actor/i);
  });

  it('rejects non-unique capability ranks in worker publications', () => {
    const tampered = {
      ...validWorkerPublication,
      capability_rank: {
        ...validWorkerPublication.capability_rank,
        'openai-codex/gpt-5.6-luna': 2,
      },
    };
    assert.throws(() => loadWorkerEvalPublication(tampered), /rank/i);
  });

  it('rejects malformed capability ranks in worker publications', () => {
    const base = validWorkerPublication.capability_rank;
    assert.throws(() => loadWorkerEvalPublication({ ...validWorkerPublication, capability_rank: { ...base, 'openai-codex/gpt-5.6-luna': 0 } }), /rank/i);
    assert.throws(() => loadWorkerEvalPublication({ ...validWorkerPublication, capability_rank: { ...base, 'openai-codex/gpt-5.6-luna': 2.5 } }), /rank/i);
    assert.throws(() => loadWorkerEvalPublication({ ...validWorkerPublication, capability_rank: { ...base, 'openai-codex/gpt-5.6-luna': Number.NaN } }), /rank/i);
  });

  it('rejects extra models outside the canonical registry', () => {
    const tampered = {
      ...validWorkerPublication,
      capability_rank: {
        ...validWorkerPublication.capability_rank,
        'anthropic/claude-sonnet': 6,
      },
    };
    assert.throws(() => loadWorkerEvalPublication(tampered), /approved/i);
  });

  it('rejects worker publications missing source metadata', () => {
    const tampered = { ...validWorkerPublication, source: '' };
    assert.throws(() => loadWorkerEvalPublication(tampered), /source/i);
  });
});
