/**
 * Provider-neutral adapter ports and injected registry.
 *
 * Adapters receive only the already-selected provider/model and a normalized
 * request. They cannot alter routing policy. Raw provider causes remain
 * outside public routing evidence.
 */

import { getModelName, getProvider, type ApprovedModelId, type ModelId } from './approved-models.ts';

export type NormalizedRequest = {
  readonly prompt: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
};

export type NormalizedResponse = {
  readonly provider: string;
  readonly model: string;
  readonly output: string;
};

export type AdapterError = {
  readonly code: string;
  readonly provider: string;
  readonly model: string;
  readonly reason: string;
};

export type ProviderAdapter = {
  readonly provider: string;
  readonly invoke: (request: NormalizedRequest) => Promise<NormalizedResponse>;
};

export type AdapterRegistry = {
  readonly register: (adapter: ProviderAdapter) => void;
  readonly get: (provider: string) => ProviderAdapter | undefined;
  readonly invokeForModel: (modelId: ModelId, request: NormalizedRequest) => Promise<NormalizedResponse | AdapterError>;
};

const ADAPTER_REASONS: Readonly<Record<string, string>> = Object.freeze({
  ADAPTER_NOT_FOUND: 'No adapter registered for provider',
  ADAPTER_INVOCATION_FAILED: 'Adapter invocation failed',
});

function createAdapterError(code: string, provider: string, model: string): AdapterError {
  return Object.freeze({
    code,
    provider,
    model,
    reason: ADAPTER_REASONS[code] ?? 'Adapter error',
  });
}

export class InjectedAdapterRegistry implements AdapterRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  constructor(adapters: readonly ProviderAdapter[] = []) {
    for (const adapter of adapters) {
      this.register(adapter);
    }
  }

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.provider, adapter);
  }

  get(provider: string): ProviderAdapter | undefined {
    return this.adapters.get(provider);
  }

  async invokeForModel(modelId: ModelId, request: NormalizedRequest): Promise<NormalizedResponse | AdapterError> {
    const provider = getProvider(modelId);
    const model = getModelName(modelId);
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      return createAdapterError('ADAPTER_NOT_FOUND', provider, model);
    }
    try {
      const response = await adapter.invoke(request);
      return Object.freeze({
        provider,
        model,
        output: response.output,
      });
    } catch (_cause) {
      return createAdapterError('ADAPTER_INVOCATION_FAILED', provider, model);
    }
  }
}

export function createFakeOpenAICodexAdapter(): ProviderAdapter {
  return Object.freeze({
    provider: 'openai-codex',
    async invoke(_request: NormalizedRequest): Promise<NormalizedResponse> {
      return Object.freeze({ provider: 'openai-codex', model: 'gpt-5.6-luna', output: 'fake-openai-response' });
    },
  });
}

export function createFakeMoonshotAdapter(): ProviderAdapter {
  return Object.freeze({
    provider: 'moonshot',
    async invoke(_request: NormalizedRequest): Promise<NormalizedResponse> {
      return Object.freeze({ provider: 'moonshot', model: 'kimi-k3', output: 'fake-moonshot-response' });
    },
  });
}

export function isAdapterError(value: unknown): value is AdapterError {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as AdapterError).code === 'string' &&
    typeof (value as AdapterError).provider === 'string' &&
    typeof (value as AdapterError).model === 'string' &&
    typeof (value as AdapterError).reason === 'string'
  );
}
