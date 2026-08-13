import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InjectedAdapterRegistry,
  createFakeOpenAICodexAdapter,
  createFakeMoonshotAdapter,
  isAdapterError,
} from '../../src/domains/model-routing-and-evaluation/provider-adapters.ts';
import { parseModelId } from '../../src/domains/model-routing-and-evaluation/approved-models.ts';
import type { NormalizedRequest, ProviderAdapter } from '../../src/domains/model-routing-and-evaluation/provider-adapters.ts';

describe('provider adapter registry', () => {
  it('dispatches to the correct provider adapter from the selected model ID', async () => {
    const openai = createFakeOpenAICodexAdapter();
    const moonshot = createFakeMoonshotAdapter();
    const registry = new InjectedAdapterRegistry([openai, moonshot]);

    const luna = parseModelId('openai-codex/gpt-5.6-luna');
    const k3 = parseModelId('moonshot/kimi-k3');

    const request: NormalizedRequest = { prompt: 'hello', temperature: 0.5, maxTokens: 100 };
    const openaiResult = await registry.invokeForModel(luna, request);
    assert.equal(isAdapterError(openaiResult), false);
    assert.equal((openaiResult as { provider: string }).provider, 'openai-codex');

    const moonshotResult = await registry.invokeForModel(k3, request);
    assert.equal(isAdapterError(moonshotResult), false);
    assert.equal((moonshotResult as { provider: string }).provider, 'moonshot');
  });

  it('rejects unregistered providers', async () => {
    const registry = new InjectedAdapterRegistry([]);
    const luna = parseModelId('openai-codex/gpt-5.6-luna');
    const result = await registry.invokeForModel(luna, { prompt: 'hello' });
    assert.equal(isAdapterError(result), true);
    assert.equal((result as { code: string }).code, 'ADAPTER_NOT_FOUND');
  });

  it('normalizes request and response shapes', async () => {
    const openai = createFakeOpenAICodexAdapter();
    const registry = new InjectedAdapterRegistry([openai]);
    const luna = parseModelId('openai-codex/gpt-5.6-luna');
    const result = await registry.invokeForModel(luna, { prompt: 'hello', temperature: 0.7 });
    assert.equal(isAdapterError(result), false);
    const response = result as { provider: string; model: string; output: string; raw?: unknown };
    assert.equal(response.provider, 'openai-codex');
    assert.equal(response.model, 'gpt-5.6-luna');
    assert.equal(response.output, 'fake-openai-response');
    assert.equal(response.raw, undefined);
  });

  it('does not allow adapters to alter selected routing', async () => {
    let invocations = 0;
    const rogueAdapter: ProviderAdapter = {
      provider: 'openai-codex',
      invoke: async () => {
        invocations += 1;
        return {
          provider: 'moonshot',
          model: 'kimi-k3',
          output: 'rogue',
          policyOverride: { primary: 'moonshot/kimi-k3' },
        } as never;
      },
    };
    const registry = new InjectedAdapterRegistry([rogueAdapter]);
    const selected = parseModelId('openai-codex/gpt-5.6-luna');

    const result = await registry.invokeForModel(selected, { prompt: 'hello' });

    assert.equal(invocations, 1);
    assert.equal(isAdapterError(result), false);
    assert.deepEqual(result, {
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
      output: 'rogue',
    });
  });

  it('uses allowlist-coded adapter errors and strips raw exception text', async () => {
    const credential = 'sk-deadbeef-credential-leak';
    const payload = JSON.stringify({ apiKey: credential });
    const leakyAdapter: ProviderAdapter = {
      provider: 'openai-codex',
      invoke: () => {
        throw new Error(`Provider request failed with key ${credential} and payload ${payload}`);
      },
    };
    const registry = new InjectedAdapterRegistry([leakyAdapter]);
    const luna = parseModelId('openai-codex/gpt-5.6-luna');
    const result = await registry.invokeForModel(luna, { prompt: 'hello' });
    assert.equal(isAdapterError(result), true);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.indexOf(credential), -1);
    assert.equal(serialized.indexOf(payload), -1);
    assert.equal(serialized.indexOf('apiKey'), -1);
    assert.equal(serialized.indexOf('sk-'), -1);
    assert.equal(serialized.indexOf('Provider request failed'), -1);
    assert.equal((result as { reason: string }).reason, 'Adapter invocation failed');
  });

  it('does not echo arbitrary adapter exception text', async () => {
    const arbitrary = 'arbitrary-secret-phrase-from-provider';
    const leakyAdapter: ProviderAdapter = {
      provider: 'moonshot',
      invoke: () => {
        throw new Error(arbitrary);
      },
    };
    const registry = new InjectedAdapterRegistry([leakyAdapter]);
    const k3 = parseModelId('moonshot/kimi-k3');
    const result = await registry.invokeForModel(k3, { prompt: 'hello' });
    assert.equal(isAdapterError(result), true);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.indexOf(arbitrary), -1);
    assert.equal((result as { reason: string }).reason, 'Adapter invocation failed');
  });

  it('returns only allowlisted adapter error fields', async () => {
    const leakyAdapter: ProviderAdapter = {
      provider: 'moonshot',
      invoke: () => {
        throw new Error('secret');
      },
    };
    const registry = new InjectedAdapterRegistry([leakyAdapter]);
    const k3 = parseModelId('moonshot/kimi-k3');
    const result = await registry.invokeForModel(k3, { prompt: 'hello' });
    assert.equal(isAdapterError(result), true);
    const keys = Object.keys(result as object).sort();
    assert.deepEqual(keys, ['code', 'model', 'provider', 'reason']);
  });
});
