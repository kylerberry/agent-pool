import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAvailability,
  selectForRole,
  selectBuilderEvaluatorPair,
  isRoutingFailure,
  isRoutingDecision,
  PROJECTED_DECISION_FIELDS,
  PROJECTED_FAILURE_FIELDS,
} from '../../src/domains/model-routing-and-evaluation/model-router.ts';
import type { RoutingPolicy } from '../../src/domains/model-routing-and-evaluation/routing-policy.ts';
import type { ApprovedModelId } from '../../src/domains/model-routing-and-evaluation/approved-models.ts';
import { allAvailable, workerPolicy } from './model-router.fixtures.ts';

describe('builder/evaluator pair routing', () => {
  it('selects distinct builder and evaluator models', () => {
    const available = allAvailable() as Extract<ReturnType<typeof allAvailable>, { has(_: string): boolean }>;
    const result = selectBuilderEvaluatorPair(workerPolicy, available);
    assert.equal(isRoutingFailure(result), false);
    const pair = result as { builder: { selectedModel: ApprovedModelId }; evaluator: { selectedModel: ApprovedModelId } };
    assert.notEqual(pair.builder.selectedModel, pair.evaluator.selectedModel);
  });

  it('ensures evaluator capability is never lower than builder capability', () => {
    const available = allAvailable() as Extract<ReturnType<typeof allAvailable>, { has(_: string): boolean }>;
    const result = selectBuilderEvaluatorPair(workerPolicy, available);
    const pair = result as { builder: { selectedModel: ApprovedModelId }; evaluator: { selectedModel: ApprovedModelId } };
    const builderRank = workerPolicy.getCapabilityRank(pair.builder.selectedModel);
    const evaluatorRank = workerPolicy.getCapabilityRank(pair.evaluator.selectedModel);
    assert.ok(evaluatorRank >= builderRank);
  });

  it('fails closed when no valid pair exists', () => {
    const available = validateAvailability([{ fullId: 'openai-codex/gpt-5.6-sol' }]) as Extract<
      ReturnType<typeof validateAvailability>,
      { has(_: string): boolean }
    >;
    const result = selectBuilderEvaluatorPair(workerPolicy, available);
    assert.equal(isRoutingFailure(result), true);
  });

  it('respects explicit builder and evaluator constraints', () => {
    const available = allAvailable() as Extract<ReturnType<typeof allAvailable>, { has(_: string): boolean }>;
    const result = selectBuilderEvaluatorPair(workerPolicy, available, {
      explicitBuilder: 'moonshot/kimi-k2.7-code',
      explicitEvaluator: 'openai-codex/gpt-5.6-sol',
    });
    const pair = result as { builder: { selectedModel: ApprovedModelId }; evaluator: { selectedModel: ApprovedModelId } };
    assert.equal(pair.builder.selectedModel, 'moonshot/kimi-k2.7-code');
    assert.equal(pair.evaluator.selectedModel, 'openai-codex/gpt-5.6-sol');
  });

  it('fails closed when explicit pair violates the capability invariant', () => {
    const available = allAvailable() as Extract<ReturnType<typeof allAvailable>, { has(_: string): boolean }>;
    const result = selectBuilderEvaluatorPair(workerPolicy, available, {
      explicitBuilder: 'openai-codex/gpt-5.6-sol',
      explicitEvaluator: 'moonshot/kimi-k2.7-code',
    });
    assert.equal(isRoutingFailure(result), true);
  });

  it('enforces builder/evaluator invariants unconditionally even if policy rules disable them', () => {
    const hostilePolicy: RoutingPolicy = {
      version: 99,
      status: 'hostile',
      actor: 'test',
      getCapabilityRank: workerPolicy.getCapabilityRank.bind(workerPolicy),
      getRoleConfig(role: string) {
        if (role === 'building') {
          return { primary: 'openai-codex/gpt-5.6-luna', fallback: ['openai-codex/gpt-5.6-terra'] };
        }
        if (role === 'assessing') {
          return {
            primary: 'openai-codex/gpt-5.6-luna',
            fallback: ['openai-codex/gpt-5.6-terra', 'moonshot/kimi-k3', 'openai-codex/gpt-5.6-sol'],
          };
        }
        return undefined;
      },
      hasRule() {
        return false;
      },
      getRule() {
        return false;
      },
    };
    const available = allAvailable() as Extract<ReturnType<typeof allAvailable>, { has(_: string): boolean }>;
    const result = selectBuilderEvaluatorPair(hostilePolicy, available);
    assert.equal(isRoutingFailure(result), false);
    const pair = result as { builder: { selectedModel: ApprovedModelId }; evaluator: { selectedModel: ApprovedModelId } };
    assert.notEqual(pair.builder.selectedModel, pair.evaluator.selectedModel);
    assert.ok(
      hostilePolicy.getCapabilityRank(pair.evaluator.selectedModel) >= hostilePolicy.getCapabilityRank(pair.builder.selectedModel),
    );
  });

  it('exhaustively validates builder/evaluator pairs over availability subsets', () => {
    const models: ApprovedModelId[] = [
      'openai-codex/gpt-5.6-luna',
      'moonshot/kimi-k2.7-code',
      'openai-codex/gpt-5.6-terra',
      'moonshot/kimi-k3',
      'openai-codex/gpt-5.6-sol',
    ];
    for (let mask = 0; mask < 1 << models.length; mask += 1) {
      const subset = models.filter((_, i) => (mask & (1 << i)) !== 0);
      const available = validateAvailability(subset.map((fullId) => ({ fullId }))) as Extract<
        ReturnType<typeof validateAvailability>,
        { has(_: string): boolean }
      >;
      const result = selectBuilderEvaluatorPair(workerPolicy, available);
      if (isRoutingFailure(result)) continue;
      const pair = result as { builder: { selectedModel: ApprovedModelId }; evaluator: { selectedModel: ApprovedModelId } };
      assert.notEqual(pair.builder.selectedModel, pair.evaluator.selectedModel);
      assert.ok(workerPolicy.getCapabilityRank(pair.evaluator.selectedModel) >= workerPolicy.getCapabilityRank(pair.builder.selectedModel));
    }
  });
});
