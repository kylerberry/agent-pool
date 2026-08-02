export type {
  DecompositionJob,
  DecompositionNode,
  DecompositionCandidate,
  DecompositionFailure,
  DecompositionInvocationRecord,
  BreadthRetriever,
  ModelInvocation,
  DecompositionModelInvoker,
} from "./decomposition-contracts.ts";

export {
  isDecompositionCandidate,
  isDecompositionFailure,
} from "./decomposition-contracts.ts";

export { runDecomposition } from "./decomposition-harness.ts";

export type { DecompositionLimits } from "./decomposition-limits.ts";
export { validateLimitPolicy, byteLength, loadLimitPolicyFromSource } from "./decomposition-limits.ts";

export {
  sanitizePromptBoundValue,
  sanitizeStringArray,
  sanitizeOptionalString,
  projectProviderError,
  loadSanitizationPolicyFromSource,
} from "./decomposition-sanitization.ts";
