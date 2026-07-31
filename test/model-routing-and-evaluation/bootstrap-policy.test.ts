import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  loadWorkerBootstrapPolicy,
  loadOrchestratorBootstrapPolicy,
  loadWorkerEvalPublication,
  loadOrchestratorEvalPublication,
} from '../../src/domains/model-routing-and-evaluation/bootstrap-policy.ts';
import * as bp from '../../src/domains/model-routing-and-evaluation/bootstrap-policy.ts';
import { APPROVED_MODELS } from '../../src/domains/model-routing-and-evaluation/approved-models.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerFixturePath = join(__dirname, '../../packages/worker-harness/config/model-routing.bootstrap.json');
const orchestratorFixturePath = join(__dirname, '../../packages/orchestrator-harness/config/model-routing.bootstrap.json');

const workerFixture = JSON.parse(readFileSync(workerFixturePath, 'utf8'));
const orchestratorFixture = JSON.parse(readFileSync(orchestratorFixturePath, 'utf8'));

describe('bootstrap policy loaders', () => {
  it('loads the worker bootstrap with version, status, actor, capability ranks, roles, and rules', () => {
    const policy = loadWorkerBootstrapPolicy(workerFixture);
    assert.equal(policy.version, 1);
    assert.equal(policy.status, 'bootstrap-until-eval-derived');
    assert.equal(policy.actor, 'pool-worker');
    assert.deepEqual(policy.getCapabilityRank('openai-codex/gpt-5.6-luna'), 1);
    assert.deepEqual(policy.getCapabilityRank('openai-codex/gpt-5.6-sol'), 5);

    const building = policy.getRoleConfig('building');
    assert.ok(building);
    assert.equal(building!.primary, 'moonshot/kimi-k2.7-code');
    assert.deepEqual(building!.fallback, ['openai-codex/gpt-5.6-terra']);

    assert.equal(policy.getRule('builderEvaluatorMustDiffer'), true);
    assert.equal(policy.getRule('evaluatorMustNotBeLowerCapability'), true);
    assert.equal(policy.getRule('reserveSolFromNormalBuilding'), true);
    assert.equal(policy.getRule('failClosedOnUnavailableExplicitModel'), true);
  });

  it('requires all worker roles and rejects decomposition in worker bootstrap', () => {
    const policy = loadWorkerBootstrapPolicy(workerFixture);
    const requiredWorkerRoles = [
      'node_conductor',
      'planning',
      'building',
      'assessing',
      'tightening',
      'sharpening',
      'failure_diagnosis',
    ];
    for (const role of requiredWorkerRoles) {
      assert.ok(policy.getRoleConfig(role), `missing worker role ${role}`);
    }
    assert.equal(policy.getRoleConfig('decomposition'), undefined);
  });

  it('loads the orchestrator bootstrap with actor and decomposition only', () => {
    const policy = loadOrchestratorBootstrapPolicy(orchestratorFixture);
    assert.equal(policy.version, 1);
    assert.equal(policy.status, 'bootstrap-until-eval-derived');
    assert.equal(policy.actor, 'orchestrator-control-plane');
    const decomposition = policy.getRoleConfig('decomposition');
    assert.ok(decomposition);
    assert.equal(decomposition!.primary, 'moonshot/kimi-k3');
    assert.deepEqual(decomposition!.fallback, ['openai-codex/gpt-5.6-sol']);
    assert.equal(policy.getRoleConfig('building'), undefined);
    assert.equal(policy.getRoleConfig('planning'), undefined);
  });

  it('rejects unknown fields in worker bootstrap', () => {
    const tampered = {
      ...workerFixture,
      extraField: 'should-fail',
    };
    assert.throws(() => loadWorkerBootstrapPolicy(tampered), /unknown/i);
  });

  it('rejects unknown fields in orchestrator bootstrap', () => {
    const tampered = {
      ...orchestratorFixture,
      capability_rank: workerFixture.capability_rank,
    };
    assert.throws(() => loadOrchestratorBootstrapPolicy(tampered), /unknown/i);
  });

  it('rejects worker bootstrap containing decomposition row', () => {
    const tampered = {
      ...workerFixture,
      roles: {
        ...workerFixture.roles,
        decomposition: { primary: 'moonshot/kimi-k3', fallback: [] },
      },
    };
    assert.throws(() => loadWorkerBootstrapPolicy(tampered), /decomposition/i);
  });

  it('rejects orchestrator bootstrap containing worker roles', () => {
    const tampered = {
      ...orchestratorFixture,
      roles: {
        ...orchestratorFixture.roles,
        building: { primary: 'moonshot/kimi-k2.7-code', fallback: [] },
      },
    };
    assert.throws(() => loadOrchestratorBootstrapPolicy(tampered), /worker/i);
  });

  it('rejects malformed version and status in worker bootstrap', () => {
    assert.throws(() => loadWorkerBootstrapPolicy({ ...workerFixture, version: '1' }), /version/i);
    assert.throws(() => loadWorkerBootstrapPolicy({ ...workerFixture, status: 'eval-derived' }), /status/i);
  });

  it('rejects non-unique capability ranks in worker bootstrap', () => {
    const tampered = {
      ...workerFixture,
      capability_rank: {
        ...workerFixture.capability_rank,
        'openai-codex/gpt-5.6-luna': 2,
      },
    };
    assert.throws(() => loadWorkerBootstrapPolicy(tampered), /rank/i);
  });

  it('rejects malformed capability rank values', () => {
    const base = workerFixture.capability_rank;
    assert.throws(() => loadWorkerBootstrapPolicy({ ...workerFixture, capability_rank: { ...base, 'openai-codex/gpt-5.6-luna': 1.5 } }), /rank/i);
    assert.throws(() => loadWorkerBootstrapPolicy({ ...workerFixture, capability_rank: { ...base, 'openai-codex/gpt-5.6-luna': -1 } }), /rank/i);
    assert.throws(() => loadWorkerBootstrapPolicy({ ...workerFixture, capability_rank: { ...base, 'openai-codex/gpt-5.6-luna': 0 } }), /rank/i);
    assert.throws(() => loadWorkerBootstrapPolicy({ ...workerFixture, capability_rank: { ...base, 'openai-codex/gpt-5.6-luna': Number.POSITIVE_INFINITY } }), /rank/i);
    assert.throws(() => loadWorkerBootstrapPolicy({ ...workerFixture, capability_rank: { ...base, 'openai-codex/gpt-5.6-luna': Number.NaN } }), /rank/i);
    assert.throws(
      () => loadWorkerBootstrapPolicy({ ...workerFixture, capability_rank: { ...base, 'anthropic/claude-sonnet': 6 } }),
      /approved|rank/i,
    );
  });

  it('rejects primary or fallback models outside the approved registry', () => {
    const tampered = {
      ...workerFixture,
      roles: {
        ...workerFixture.roles,
        planning: { primary: 'anthropic/claude_sonnet', fallback: [] },
      },
    };
    assert.throws(() => loadWorkerBootstrapPolicy(tampered), /approved/i);
  });

  it('requires capability rank for every approved model', () => {
    const tampered = {
      ...workerFixture,
      capability_rank: {
        'openai-codex/gpt-5.6-luna': 1,
        'moonshot/kimi-k2.7-code': 2,
        'openai-codex/gpt-5.6-terra': 3,
        'moonshot/kimi-k3': 4,
      },
    };
    assert.throws(() => loadWorkerBootstrapPolicy(tampered), /capability/i);
  });

  it('requires fallback lists to contain only approved models', () => {
    const tampered = {
      ...workerFixture,
      roles: {
        ...workerFixture.roles,
        assessing: { primary: 'openai-codex/gpt-5.6-sol', fallback: ['anthropic/claude-sonnet'] },
      },
    };
    assert.throws(() => loadWorkerBootstrapPolicy(tampered), /approved/i);
  });

  it('rejects role configs with unknown fields', () => {
    const tampered = {
      ...workerFixture,
      roles: {
        ...workerFixture.roles,
        planning: { primary: 'openai-codex/gpt-5.6-terra', fallback: [], extra: 'x' },
      },
    };
    assert.throws(() => loadWorkerBootstrapPolicy(tampered), /unknown/i);
  });

  it('rejects duplicate candidates in a role config', () => {
    const duplicateFallback = {
      ...workerFixture,
      roles: {
        ...workerFixture.roles,
        planning: { primary: 'openai-codex/gpt-5.6-terra', fallback: ['openai-codex/gpt-5.6-terra'] },
      },
    };
    assert.throws(() => loadWorkerBootstrapPolicy(duplicateFallback), /duplicate/i);

    const primaryInFallback = {
      ...workerFixture,
      roles: {
        ...workerFixture.roles,
        planning: { primary: 'openai-codex/gpt-5.6-terra', fallback: ['openai-codex/gpt-5.6-terra', 'moonshot/kimi-k3'] },
      },
    };
    assert.throws(() => loadWorkerBootstrapPolicy(primaryInFallback), /duplicate/i);
  });

  it('rejects bootstrap policies that disable builder/evaluator diversity', () => {
    const tampered = {
      ...workerFixture,
      rules: { ...workerFixture.rules, builderEvaluatorMustDiffer: false },
    };
    assert.throws(() => loadWorkerBootstrapPolicy(tampered), /builder.*evaluator|diversity/i);
  });

  it('rejects bootstrap policies that omit builder/evaluator diversity', () => {
    const { builderEvaluatorMustDiffer: _, ...remainingRules } = workerFixture.rules;
    const tampered = { ...workerFixture, rules: remainingRules };
    assert.throws(() => loadWorkerBootstrapPolicy(tampered), /builder.*evaluator|diversity/i);
  });

  it('rejects bootstrap policies that disable evaluator capability invariant', () => {
    const tampered = {
      ...workerFixture,
      rules: { ...workerFixture.rules, evaluatorMustNotBeLowerCapability: false },
    };
    assert.throws(() => loadWorkerBootstrapPolicy(tampered), /evaluator|capability/i);
  });

  it('rejects bootstrap policies that omit evaluator capability invariant', () => {
    const { evaluatorMustNotBeLowerCapability: _, ...remainingRules } = workerFixture.rules;
    const tampered = { ...workerFixture, rules: remainingRules };
    assert.throws(() => loadWorkerBootstrapPolicy(tampered), /evaluator|capability/i);
  });

  it('cross-checks bootstrap fixtures against the canonical approved scope', () => {
    const workerPolicy = loadWorkerBootstrapPolicy(workerFixture);
    const orchestratorPolicy = loadOrchestratorBootstrapPolicy(orchestratorFixture);
    const referencedModels = new Set<string>();
    for (const role of ['node_conductor', 'planning', 'building', 'assessing', 'tightening', 'sharpening', 'failure_diagnosis']) {
      const config = workerPolicy.getRoleConfig(role)!;
      referencedModels.add(config.primary);
      for (const fallback of config.fallback) referencedModels.add(fallback);
    }
    const decomposition = orchestratorPolicy.getRoleConfig('decomposition')!;
    referencedModels.add(decomposition.primary);
    for (const fallback of decomposition.fallback) referencedModels.add(fallback);
    assert.deepEqual([...referencedModels].sort(), [...APPROVED_MODELS].sort());
  });

  it('exposes trusted source-bound worker and orchestrator bootstrap loaders', () => {
    assert.equal(typeof bp.loadWorkerBootstrapPolicyFromSource, 'function');
    assert.equal(typeof bp.loadOrchestratorBootstrapPolicyFromSource, 'function');
    assert.equal(bp.loadWorkerBootstrapPolicyFromSource.length, 0);
    assert.equal(bp.loadOrchestratorBootstrapPolicyFromSource.length, 0);
  });

  it('source-bound worker loader reads only the worker-harness fixture', () => {
    const fromSource = bp.loadWorkerBootstrapPolicyFromSource();
    const fromFixture = loadWorkerBootstrapPolicy(workerFixture);
    assert.equal(fromSource.version, fromFixture.version);
    assert.equal(fromSource.actor, 'pool-worker');
    assert.deepEqual(fromSource.getRoleConfig('building'), fromFixture.getRoleConfig('building'));
  });

  it('source-bound orchestrator loader reads only the orchestrator-harness fixture', () => {
    const fromSource = bp.loadOrchestratorBootstrapPolicyFromSource();
    const fromFixture = loadOrchestratorBootstrapPolicy(orchestratorFixture);
    assert.equal(fromSource.version, fromFixture.version);
    assert.equal(fromSource.actor, 'orchestrator-control-plane');
    assert.deepEqual(fromSource.getRoleConfig('decomposition'), fromFixture.getRoleConfig('decomposition'));
  });
});

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
