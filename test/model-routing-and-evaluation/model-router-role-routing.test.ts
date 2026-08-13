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

describe('role routing', () => {
  it('selects the configured primary when available', () => {
    const available = allAvailable() as Extract<ReturnType<typeof allAvailable>, { has(_: string): boolean }>;
    const decision = selectForRole(workerPolicy, 'building', available);
    assert.equal(isRoutingDecision(decision), true);
    assert.equal((decision as { selectedModel: string }).selectedModel, 'moonshot/kimi-k2.7-code');
  });

  it('selects the first available ordered fallback when primary is absent', () => {
    const available = validateAvailability([
      { fullId: 'openai-codex/gpt-5.6-terra' },
      { fullId: 'moonshot/kimi-k3' },
    ]) as Extract<ReturnType<typeof validateAvailability>, { has(_: string): boolean }>;
    const decision = selectForRole(workerPolicy, 'building', available);
    assert.equal((decision as { selectedModel: string }).selectedModel, 'openai-codex/gpt-5.6-terra');
    const fallbackBehavior = (decision as { fallbackBehavior: { selectedFallbackIndex: number; primaryAvailable: boolean } }).fallbackBehavior;
    assert.equal(fallbackBehavior.selectedFallbackIndex, 0);
    assert.equal(fallbackBehavior.primaryAvailable, false);
  });

  it('fails closed when no configured candidate is available', () => {
    const available = validateAvailability([{ fullId: 'openai-codex/gpt-5.6-luna' }]) as Extract<
      ReturnType<typeof validateAvailability>,
      { has(_: string): boolean }
    >;
    const result = selectForRole(workerPolicy, 'building', available);
    assert.equal(isRoutingFailure(result), true);
  });

  it('fails closed for unavailable explicit model without consulting fallback', () => {
    const available = validateAvailability([{ fullId: 'openai-codex/gpt-5.6-luna' }]) as Extract<
      ReturnType<typeof validateAvailability>,
      { has(_: string): boolean }
    >;
    const result = selectForRole(workerPolicy, 'building', available, 'moonshot/kimi-k2.7-code');
    assert.equal(isRoutingFailure(result), true);
    const failure = result as { requestedModel?: string };
    assert.equal(failure.requestedModel, 'moonshot/kimi-k2.7-code');
  });

  it('accepts an available explicit approved model', () => {
    const available = allAvailable() as Extract<ReturnType<typeof allAvailable>, { has(_: string): boolean }>;
    const decision = selectForRole(workerPolicy, 'building', available, 'openai-codex/gpt-5.6-sol');
    assert.equal(isRoutingDecision(decision), true);
    assert.equal((decision as { selectedModel: string }).selectedModel, 'openai-codex/gpt-5.6-sol');
  });

  it('rejects an explicit unapproved model', () => {
    const available = allAvailable() as Extract<ReturnType<typeof allAvailable>, { has(_: string): boolean }>;
    const result = selectForRole(workerPolicy, 'building', available, 'anthropic/claude-sonnet');
    assert.equal(isRoutingFailure(result), true);
  });

  it('records rationale and fallback behavior', () => {
    const available = validateAvailability([
      { fullId: 'openai-codex/gpt-5.6-terra' },
    ]) as Extract<ReturnType<typeof validateAvailability>, { has(_: string): boolean }>;
    const decision = selectForRole(workerPolicy, 'building', available) as unknown as {
      role: string;
      selectedModel: string;
      policyVersion: number;
      rationale: unknown[];
      fallbackBehavior: { skippedCandidates: unknown[] };
    };
    assert.equal(decision.role, 'building');
    assert.equal(decision.policyVersion, 1);
    assert.ok(decision.rationale.length > 0);
    assert.ok(decision.fallbackBehavior.skippedCandidates.length > 0);
  });
});
