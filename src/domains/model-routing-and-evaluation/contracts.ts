/**
 * Dependency-free shared contracts for the Model Routing and Evaluation domain.
 */

export type WorkerRole =
  | 'node_conductor'
  | 'planning'
  | 'building'
  | 'assessing'
  | 'tightening'
  | 'sharpening'
  | 'failure_diagnosis';

export type OrchestratorRole = 'decomposition';

export type Role = WorkerRole | OrchestratorRole;

export type RoleConfig = {
  readonly primary: string;
  readonly fallback: readonly string[];
};

export type BootstrapWorkerPolicyShape = {
  readonly version: number;
  readonly status: 'bootstrap-until-eval-derived';
  readonly capability_rank: Readonly<Record<string, number>>;
  readonly roles: Readonly<Record<string, RoleConfig>>;
  readonly rules: {
    readonly builderEvaluatorMustDiffer: boolean;
    readonly evaluatorMustNotBeLowerCapability: boolean;
    readonly reserveSolFromNormalBuilding: boolean;
    readonly failClosedOnUnavailableExplicitModel: boolean;
  };
};

export type BootstrapOrchestratorPolicyShape = {
  readonly version: number;
  readonly status: 'bootstrap-until-eval-derived';
  readonly actor: 'orchestrator-control-plane';
  readonly roles: Readonly<Record<string, RoleConfig>>;
  readonly rules: {
    readonly failClosedOnUnavailableExplicitModel: boolean;
  };
};

export type AvailabilityEntryShape = {
  readonly fullId: string;
  readonly provider?: string;
  readonly model?: string;
};

export type RoutingFailureShape = {
  readonly code: string;
  readonly role?: string;
  readonly requestedModel?: string;
  readonly reason: string;
};
