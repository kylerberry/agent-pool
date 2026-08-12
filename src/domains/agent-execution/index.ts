/**
 * Narrow public interface for the Agent Execution domain.
 *
 * Nothing DAG-shaped is exported, because nothing DAG-shaped exists here: the
 * worker executes one attempt contract and never sees topology (ADR-010).
 */

export type {
  AcceptanceCriterion,
  AttemptContractShape,
  CleanupState,
  CraftsPhase,
  CriteriaOrigin,
  ExecutionContextShape,
  ExecutionFailure,
  LaunchExpectations,
  PoolProofLaunchExpectations,
  PriorFailureContext,
  TranscriptRetentionStep,
} from './contracts.ts';
export { isExecutionFailure } from './contracts.ts';

export type {
  ActorIdentity,
} from './actor-context.ts';
export { buildActorIdentity, createActorIdentityAccessor, renderIdentityCapsule } from './actor-context.ts';

export { DAG_TOPOLOGY_KEYS, findDagTopology } from './dag-exclusion.ts';

export type {
  ConsumedNonceStore,
  ValidatedExecutionContext,
  ValidateExecutionContextOptions,
} from './execution-context.ts';
export {
  CLOCK_SKEW_TOLERANCE_MS,
  FRESHNESS_CEILING_SECONDS,
  SUPPORTED_CONTEXT_SCHEMA_VERSION,
  createInMemoryNonceStore,
  validateExecutionContext,
} from './execution-context.ts';

export type { AttemptContractExpectations, ValidatedAttemptContract } from './attempt-contract.ts';
export { SUPPORTED_CONTRACT_SCHEMA_VERSION, validateAttemptContracts } from './attempt-contract.ts';

export type { BuildRepositoryCommandEnvOptions, EnvRecord, TrustedOperation } from './credential-isolation.ts';
export {
  REPOSITORY_COMMAND_ALLOWLIST,
  assertNoCredentials,
  buildRepositoryCommandEnv,
  buildTrustedOperationEnv,
  isCredentialVariableName,
} from './credential-isolation.ts';

export type { Capability, PhaseGrant, WriteAuthorization } from './phase-capabilities.ts';
export { authorizeWrite, getPhaseGrant, phaseHasCapability } from './phase-capabilities.ts';

export type {
  BackendConsumption,
  BackendFallbackLedger,
  BackendOutcome,
  ConsumedCost,
  FallbackLedgerSnapshot,
} from './backend-fallback.ts';
export { MAX_BACKENDS_PER_ATTEMPT, createBackendFallbackLedger } from './backend-fallback.ts';

export type {
  RedactionResult,
  RetainTranscriptInput,
  TranscriptAuditIndex,
  TranscriptAuditRecord,
  TranscriptObjectStore,
  TranscriptRedactor,
  TranscriptRetentionIncomplete,
  TranscriptRetentionOutcome,
  TranscriptRetentionSuccess,
  TranscriptSource,
} from './transcript-retention.ts';
export {
  TRANSCRIPT_RETENTION_ORDER,
  isWorkspaceRelativeLocator,
  retainTranscript,
} from './transcript-retention.ts';

export type { AttemptWorkspaceLifecycle, CleanupDecision } from './workspace-lifecycle.ts';
export {
  DEFAULT_QUARANTINE_MS,
  MAX_QUARANTINE_MS,
  createAttemptWorkspaceLifecycle,
} from './workspace-lifecycle.ts';

export type {
  AttemptResources,
  ResourceFactory,
  ResourceFactoryOptions,
} from './attempt-resources.ts';
export { createAttemptResourceFactory } from './attempt-resources.ts';

export type {
  BrokerSocketAllocation,
  BrokerSocketAllocationOptions,
} from './broker-socket.ts';
export {
  AF_UNIX_PATH_LIMIT,
  DEFAULT_SOCKET_BYTE_BUDGET,
  allocateBrokerSocket,
  resolveShortSocketRoot,
} from './broker-socket.ts';

export type {
  RepositorySandbox,
  RepositorySandboxOptions,
  SandboxProcess,
  BrokerResponse,
} from './repository-sandbox.ts';
export { createRepositorySandbox } from './repository-sandbox.ts';

export type {
  SandboxIdentity,
} from './sandbox-identity.ts';
export {
  SANDBOX_PINNED_GID,
  SANDBOX_PINNED_UID,
  prepareWorkspaceForSandbox,
  requireNonRootSandboxIdentity,
  resolveSandboxIdentity,
} from './sandbox-identity.ts';

export type {
  SandboxBroker,
  SandboxBrokerOptions,
} from './sandbox-broker.ts';
export { createSandboxBroker } from './sandbox-broker.ts';

export type {
  RepositoryToolAdapters,
  ToolCommandResult,
  ToolReadResult,
  ToolWriteResult,
} from './repository-tool-adapters.ts';
export { createRepositoryToolAdapters } from './repository-tool-adapters.ts';

export type {
  FaultDirective,
} from './pool-proof-fault-directive.ts';
export {
  createFaultDirectiveState,
  deriveInjectedFailureCode,
} from './pool-proof-fault-directive.ts';

export type {
  PackageProfileVerifier,
  PiLauncher,
  PiLauncherOptions,
  PiProcess,
} from './pool-proof-pi-launcher.ts';
export { createPoolProofPiLauncher } from './pool-proof-pi-launcher.ts';

export type {
  MinimalPoolRuntime,
  MinimalPoolRuntimeOptions,
  ProofJob,
  SubmitResult,
} from './minimal-pool-runtime.ts';
export { createMinimalPoolRuntime } from './minimal-pool-runtime.ts';
