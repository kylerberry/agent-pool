import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVED_MODELS,
  CANONICAL_CAPABILITY_ORDER,
  CAPABILITY_RANK,
  parseModelId,
  isApprovedModelId,
  getCapabilityRank,
  compareCapability,
  getProvider,
  getModelName,
  type ApprovedModelId,
} from '../../src/domains/model-routing-and-evaluation/approved-models.ts';

describe('approved-models registry', () => {
  it('contains exactly the five approved provider-qualified models', () => {
    assert.deepEqual(APPROVED_MODELS, [
      'openai-codex/gpt-5.6-luna',
      'moonshot/kimi-k2.7-code',
      'openai-codex/gpt-5.6-terra',
      'moonshot/kimi-k3',
      'openai-codex/gpt-5.6-sol',
    ]);
  });

  it('matches capability ranks 1 through 5 in canonical order', () => {
    assert.deepEqual(CANONICAL_CAPABILITY_ORDER, [
      'openai-codex/gpt-5.6-luna',
      'moonshot/kimi-k2.7-code',
      'openai-codex/gpt-5.6-terra',
      'moonshot/kimi-k3',
      'openai-codex/gpt-5.6-sol',
    ]);
    for (let i = 0; i < CANONICAL_CAPABILITY_ORDER.length; i += 1) {
      const id: ApprovedModelId = CANONICAL_CAPABILITY_ORDER[i];
      assert.equal(CAPABILITY_RANK[id], i + 1);
      assert.equal(getCapabilityRank(id), i + 1);
    }
  });

  it('rejects unqualified IDs', () => {
    assert.equal(isApprovedModelId('gpt-5.6-luna'), false);
    assert.equal(isApprovedModelId('luna'), false);
    assert.throws(() => parseModelId('gpt-5.6-luna'));
  });

  it('rejects aliases and casing variants', () => {
    assert.equal(isApprovedModelId('openai-codex/gpt-5.6-Luna'), false);
    assert.equal(isApprovedModelId('OpenAI/gpt-5.6-luna'), false);
    assert.equal(isApprovedModelId('moonshot/kimi-k2.7'), false);
    assert.equal(isApprovedModelId('kimi-k2.7-code'), false);
    assert.throws(() => parseModelId('moonshot/kimi-k2.7'));
  });

  it('rejects unknown providers and models', () => {
    assert.equal(isApprovedModelId('anthropic/claude-sonnet-4'), false);
    assert.equal(isApprovedModelId('openai-codex/gpt-5.6-nova'), false);
    assert.equal(isApprovedModelId('moonshot/kimi-k4'), false);
    assert.throws(() => parseModelId('anthropic/claude-sonnet'));
  });

  it('rejects non-string and empty inputs', () => {
    assert.equal(isApprovedModelId(null), false);
    assert.equal(isApprovedModelId(undefined), false);
    assert.equal(isApprovedModelId(123), false);
    assert.equal(isApprovedModelId({}), false);
    assert.equal(isApprovedModelId(''), false);
    assert.throws(() => parseModelId(null));
    assert.throws(() => parseModelId(''));
  });

  it('parses and decomposes approved IDs', () => {
    const id = parseModelId('openai-codex/gpt-5.6-luna');
    assert.equal(id, 'openai-codex/gpt-5.6-luna');
    assert.equal(getProvider(id), 'openai-codex');
    assert.equal(getModelName(id), 'gpt-5.6-luna');
  });

  it('compares capability monotonically', () => {
    const luna = parseModelId('openai-codex/gpt-5.6-luna');
    const terra = parseModelId('openai-codex/gpt-5.6-terra');
    const sol = parseModelId('openai-codex/gpt-5.6-sol');
    assert.ok(compareCapability(terra, luna) > 0);
    assert.ok(compareCapability(luna, terra) < 0);
    assert.equal(compareCapability(terra, terra), 0);
    assert.ok(compareCapability(sol, luna) > 0);
  });

  it('requires unique ranks and complete coverage', () => {
    const ranks = APPROVED_MODELS.map((id) => CAPABILITY_RANK[id]);
    const uniqueRanks = new Set(ranks);
    assert.equal(uniqueRanks.size, APPROVED_MODELS.length);
    assert.deepEqual([...uniqueRanks].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  });

  it('rejects extra models outside the tuple', () => {
    assert.equal(isApprovedModelId('openai-codex/gpt-5.6-sol-extra'), false);
    assert.throws(() => parseModelId('openai-codex/gpt-5.6-sol-extra'));
  });

  it('runtime-freezes the registry and canonical ordering', () => {
    assert.equal(Object.isFrozen(APPROVED_MODELS), true);
    assert.equal(Object.isFrozen(CANONICAL_CAPABILITY_ORDER), true);
    assert.equal(Object.isFrozen(CAPABILITY_RANK), true);
    assert.throws(() => (APPROVED_MODELS as unknown as string[]).push('x'));
    assert.throws(() => (CANONICAL_CAPABILITY_ORDER as unknown as string[]).push('x'));
  });
});
