/**
 * Canonical approved-model registry.
 *
 * The approved scope is immutable and exact. No runtime code may expand it.
 */

export const PROVIDER_OPENAI_CODEX = 'openai-codex' as const;
export const PROVIDER_MOONSHOT = 'moonshot' as const;

const _APPROVED_MODELS = [
  'openai-codex/gpt-5.6-luna',
  'moonshot/kimi-k2.7-code',
  'openai-codex/gpt-5.6-terra',
  'moonshot/kimi-k3',
  'openai-codex/gpt-5.6-sol',
] as const;

export type ApprovedModelId = (typeof _APPROVED_MODELS)[number];
export type ModelId = ApprovedModelId;

export const APPROVED_MODELS: readonly ApprovedModelId[] = Object.freeze([..._APPROVED_MODELS]);

/**
 * Canonical capability ordering, lowest to highest.
 */
export const CANONICAL_CAPABILITY_ORDER: readonly ApprovedModelId[] = Object.freeze([..._APPROVED_MODELS]);

export const CAPABILITY_RANK: Readonly<Record<ApprovedModelId, number>> = Object.freeze({
  'openai-codex/gpt-5.6-luna': 1,
  'moonshot/kimi-k2.7-code': 2,
  'openai-codex/gpt-5.6-terra': 3,
  'moonshot/kimi-k3': 4,
  'openai-codex/gpt-5.6-sol': 5,
});

const APPROVED_SET: ReadonlySet<string> = new Set(APPROVED_MODELS);

export function isApprovedModelId(input: unknown): input is ApprovedModelId {
  return typeof input === 'string' && APPROVED_SET.has(input);
}

export function parseModelId(input: unknown): ApprovedModelId {
  if (!isApprovedModelId(input)) {
    throw new Error(`Model ID is not in the approved registry: ${String(input)}`);
  }
  return input;
}

export function getCapabilityRank(modelId: ApprovedModelId): number {
  return CAPABILITY_RANK[modelId];
}

export function compareCapability(a: ApprovedModelId, b: ApprovedModelId): number {
  return getCapabilityRank(a) - getCapabilityRank(b);
}

export function getProvider(modelId: ApprovedModelId): string {
  return modelId.split('/')[0];
}

export function getModelName(modelId: ApprovedModelId): string {
  return modelId.split('/')[1];
}
