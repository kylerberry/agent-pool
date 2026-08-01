import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BACKENDS_PER_ATTEMPT,
  createBackendFallbackLedger,
  isExecutionFailure,
  type BackendFallbackLedger,
  type ConsumedCost,
} from '../../src/domains/agent-execution/index.ts';

const PRIMARY = 'moonshot/kimi-k2.7-code';
const FALLBACK = 'openai-codex/gpt-5.6-terra';
const THIRD = 'moonshot/kimi-k3';

function cost(input: number, output: number, amount: number | null = null): ConsumedCost {
  return { input_tokens: input, output_tokens: output, amount, currency: amount === null ? null : 'USD' };
}

function ledger(): BackendFallbackLedger {
  const created = createBackendFallbackLedger({ attemptId: 'attempt-1', nodeId: 'node-1', role: 'building' });
  assert.ok(!isExecutionFailure(created));
  return created;
}

describe('same-attempt backend fallback', () => {
  it('keeps every fallback inside the same attempt', () => {
    const chain = ledger();
    chain.record({ attemptId: 'attempt-1', model: PRIMARY, outcome: 'failed', cost: cost(10, 5), evidence: ['timeout'] });
    const drifted = chain.record({
      attemptId: 'attempt-2',
      model: FALLBACK,
      outcome: 'succeeded',
      cost: cost(1, 1),
      evidence: [],
    });
    assert.ok(isExecutionFailure(drifted));
    assert.equal(drifted.code, 'FALLBACK_ATTEMPT_MISMATCH');
    assert.equal(chain.snapshot().attemptId, 'attempt-1');
    assert.equal(chain.snapshot().consumptions.length, 1);
  });

  it('accumulates cost consumed by failed backends, not just the winner', () => {
    const chain = ledger();
    chain.record({ attemptId: 'attempt-1', model: PRIMARY, outcome: 'failed', cost: cost(1000, 200, 0.5), evidence: ['exit 1'] });
    chain.record({ attemptId: 'attempt-1', model: FALLBACK, outcome: 'succeeded', cost: cost(800, 150, 0.4), evidence: ['exit 0'] });

    const snapshot = chain.snapshot();
    assert.equal(snapshot.totalCost.input_tokens, 1800);
    assert.equal(snapshot.totalCost.output_tokens, 350);
    assert.ok(Math.abs((snapshot.totalCost.amount ?? 0) - 0.9) < 1e-9);
    assert.equal(snapshot.totalCost.currency, 'USD');
  });

  it('retains evidence for every consumed backend', () => {
    const chain = ledger();
    chain.record({ attemptId: 'attempt-1', model: PRIMARY, outcome: 'failed', cost: cost(1, 1), evidence: ['provider 503'] });
    chain.record({ attemptId: 'attempt-1', model: FALLBACK, outcome: 'succeeded', cost: cost(1, 1), evidence: ['suite green'] });

    const snapshot = chain.snapshot();
    assert.deepEqual(snapshot.consumptions.map((entry) => entry.model), [PRIMARY, FALLBACK]);
    assert.deepEqual(snapshot.consumptions.map((entry) => entry.sequence), [1, 2]);
    assert.deepEqual([...snapshot.consumptions[0].evidence], ['provider 503']);
    assert.deepEqual([...snapshot.consumptions[1].evidence], ['suite green']);
  });

  it('does not sum a misleading total across mixed currencies', () => {
    const chain = ledger();
    chain.record({
      attemptId: 'attempt-1',
      model: PRIMARY,
      outcome: 'failed',
      cost: { input_tokens: 10, output_tokens: 1, amount: 0.5, currency: 'USD' },
      evidence: [],
    });
    chain.record({
      attemptId: 'attempt-1',
      model: FALLBACK,
      outcome: 'failed',
      cost: { input_tokens: 10, output_tokens: 1, amount: 0.5, currency: 'CNY' },
      evidence: [],
    });
    const snapshot = chain.snapshot();
    assert.equal(snapshot.totalCost.amount, null);
    assert.equal(snapshot.totalCost.input_tokens, 20);
  });

  it('does not let a third backend re-establish a total after a currency collision', () => {
    const chain = ledger();
    for (const [model, currency] of [[PRIMARY, 'USD'], [FALLBACK, 'CNY'], [THIRD, 'USD']] as const) {
      chain.record({
        attemptId: 'attempt-1',
        model,
        outcome: 'failed',
        cost: { input_tokens: 10, output_tokens: 1, amount: 1, currency },
        evidence: [],
      });
    }
    const snapshot = chain.snapshot();
    assert.equal(snapshot.totalCost.amount, null, 'a partial sum would read as the full attempt spend');
    assert.equal(snapshot.totalCost.currency, null);
    assert.equal(snapshot.totalCost.input_tokens, 30);
  });

  it('bounds the chain at three backends per attempt', () => {
    const chain = ledger();
    for (const model of [PRIMARY, FALLBACK, THIRD]) {
      const recorded = chain.record({ attemptId: 'attempt-1', model, outcome: 'failed', cost: cost(1, 1), evidence: [] });
      assert.ok(!isExecutionFailure(recorded));
    }
    assert.equal(chain.canFallback(), false);
    const exhausted = chain.record({ attemptId: 'attempt-1', model: PRIMARY, outcome: 'failed', cost: cost(1, 1), evidence: [] });
    assert.ok(isExecutionFailure(exhausted));
    assert.equal(exhausted.code, 'FALLBACK_CHAIN_EXHAUSTED');
    assert.equal(chain.snapshot().consumptions.length, MAX_BACKENDS_PER_ATTEMPT);
  });

  it('seals the ledger once a backend succeeds', () => {
    const chain = ledger();
    chain.record({ attemptId: 'attempt-1', model: PRIMARY, outcome: 'succeeded', cost: cost(1, 1), evidence: [] });
    assert.equal(chain.canFallback(), false);
    const afterSuccess = chain.record({ attemptId: 'attempt-1', model: FALLBACK, outcome: 'failed', cost: cost(1, 1), evidence: [] });
    assert.ok(isExecutionFailure(afterSuccess));
    assert.equal(afterSuccess.code, 'FALLBACK_LEDGER_SEALED');
    assert.equal(chain.snapshot().sealed, true);
  });

  it('refuses a backend outside the approved model scope', () => {
    const chain = ledger();
    for (const model of ['anthropic/claude-opus-5', 'moonshot/kimi-k2.7', 'kimi-k3', '']) {
      const rejected = chain.record({ attemptId: 'attempt-1', model, outcome: 'failed', cost: cost(1, 1), evidence: [] });
      assert.ok(isExecutionFailure(rejected), `${model} must be rejected`);
      assert.equal(rejected.code, 'FALLBACK_MODEL_UNAPPROVED');
    }
    assert.equal(chain.snapshot().consumptions.length, 0);
  });

  it('rejects malformed cost rather than recording an unaccountable spend', () => {
    const chain = ledger();
    const malformed: unknown[] = [
      { input_tokens: -1, output_tokens: 0, amount: null, currency: null },
      { input_tokens: 1.5, output_tokens: 0, amount: null, currency: null },
      { input_tokens: 1, output_tokens: 1, amount: Number.NaN, currency: 'USD' },
      { input_tokens: 1, output_tokens: 1, amount: -0.5, currency: 'USD' },
      { input_tokens: 1, output_tokens: 1 },
      { input_tokens: 1, output_tokens: 1, amount: null, currency: null, extra: true },
      null,
    ];
    for (const cost_ of malformed) {
      const rejected = chain.record({
        attemptId: 'attempt-1',
        model: PRIMARY,
        outcome: 'failed',
        cost: cost_ as ConsumedCost,
        evidence: [],
      });
      assert.ok(isExecutionFailure(rejected), `${JSON.stringify(cost_)} must be rejected`);
      assert.equal(rejected.code, 'FALLBACK_COST_INVALID');
    }
    assert.equal(chain.snapshot().consumptions.length, 0);
  });

  it('rejects a chain limit above the per-attempt ceiling', () => {
    const rejected = createBackendFallbackLedger({
      attemptId: 'attempt-1',
      nodeId: 'node-1',
      role: 'building',
      maxBackends: MAX_BACKENDS_PER_ATTEMPT + 1,
    });
    assert.ok(isExecutionFailure(rejected));
    assert.equal(rejected.code, 'FALLBACK_CHAIN_LIMIT');
  });

  it('returns immutable consumption evidence', () => {
    const chain = ledger();
    const recorded = chain.record({ attemptId: 'attempt-1', model: PRIMARY, outcome: 'failed', cost: cost(1, 1), evidence: ['a'] });
    assert.ok(!isExecutionFailure(recorded));
    assert.equal(Object.isFrozen(recorded), true);
    assert.throws(() => {
      (recorded.evidence as string[]).push('b');
    });
  });
});
