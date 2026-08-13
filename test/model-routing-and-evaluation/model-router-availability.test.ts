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

describe('availability snapshot validation', () => {
  it('accepts a clean snapshot of approved models', () => {
    const result = allAvailable();
    assert.equal(isRoutingFailure(result), false);
    const available = result as Extract<typeof result, { has(_: string): boolean }>;
    assert.equal(available.has('openai-codex/gpt-5.6-sol'), true);
    assert.equal(available.values().length, 5);
  });

  it('rejects a malformed container', () => {
    assert.equal(isRoutingFailure(validateAvailability(null)), true);
    assert.equal(isRoutingFailure(validateAvailability('not-an-array')), true);
    assert.equal(isRoutingFailure(validateAvailability({})), true);
    assert.equal(isRoutingFailure(validateAvailability([{ provider: 'openai-codex' }])), true);
  });

  it('rejects unqualified IDs in availability entries', () => {
    const result = validateAvailability([{ fullId: 'gpt-5.6-luna' }]);
    assert.equal(isRoutingFailure(result), true);
  });

  it('rejects aliases and unknown provider/model IDs', () => {
    assert.equal(isRoutingFailure(validateAvailability([{ fullId: 'moonshot/kimi-k2.7' }])), true);
    assert.equal(isRoutingFailure(validateAvailability([{ fullId: 'anthropic/claude-sonnet' }])), true);
  });

  it('rejects duplicate entries', () => {
    const result = validateAvailability([
      { fullId: 'openai-codex/gpt-5.6-luna' },
      { fullId: 'openai-codex/gpt-5.6-luna' },
    ]);
    assert.equal(isRoutingFailure(result), true);
  });

  it('rejects entries with inconsistent provider/model fields', () => {
    assert.equal(
      isRoutingFailure(
        validateAvailability([{ fullId: 'openai-codex/gpt-5.6-luna', provider: 'moonshot' }]),
      ),
      true,
    );
    assert.equal(
      isRoutingFailure(
        validateAvailability([{ fullId: 'openai-codex/gpt-5.6-luna', model: 'kimi-k3' }]),
      ),
      true,
    );
  });

  it('treats absent models as unavailable but does not fail the snapshot', () => {
    const available = validateAvailability([
      { fullId: 'openai-codex/gpt-5.6-luna' },
      { fullId: 'openai-codex/gpt-5.6-sol' },
    ]) as Extract<ReturnType<typeof validateAvailability>, { has(_: string): boolean }>;
    assert.equal(available.has('openai-codex/gpt-5.6-luna'), true);
    assert.equal(available.has('moonshot/kimi-k3'), false);
  });
});
