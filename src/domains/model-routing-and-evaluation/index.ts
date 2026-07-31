/**
 * Narrow public interface for the Model Routing and Evaluation domain.
 */

export type {
  RoutingPolicy,
  RoutingPolicyPublication,
} from './routing-policy.ts';

export type {
  RoutingDecision,
  RoutingFailure,
  ValidatedAvailability,
} from './model-router.ts';

export {
  validateAvailability,
  selectForRole,
  selectBuilderEvaluatorPair,
  isRoutingFailure,
  isRoutingDecision,
  PROJECTED_DECISION_FIELDS,
  PROJECTED_FAILURE_FIELDS,
} from './model-router.ts';

export {
  loadWorkerBootstrapPolicy,
  loadOrchestratorBootstrapPolicy,
  loadWorkerBootstrapPolicyFromSource,
  loadOrchestratorBootstrapPolicyFromSource,
  loadWorkerEvalPublication,
  loadOrchestratorEvalPublication,
} from './bootstrap-policy.ts';

export type { AdapterRegistry, ProviderAdapter, NormalizedRequest, NormalizedResponse } from './provider-adapters.ts';
export { InjectedAdapterRegistry, createFakeOpenAICodexAdapter, createFakeMoonshotAdapter, isAdapterError } from './provider-adapters.ts';

export {
  APPROVED_MODELS,
  CANONICAL_CAPABILITY_ORDER,
  CAPABILITY_RANK,
  isApprovedModelId,
  parseModelId,
  getCapabilityRank,
  compareCapability,
  getProvider,
  getModelName,
} from './approved-models.ts';
