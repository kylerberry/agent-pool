/**
 * Work Intake — decomposition harness contracts.
 *
 * Narrow, dependency-injected interfaces for turning an untrusted decomposition
 * job into a validated candidate DAG and immutable invocation provenance.
 * No persistence, approval, queue, Gate 1, dispatch, shell, write, or worker
 * harness concepts appear here.
 */

import type { IndexRevision, BreadthResult } from "../codebase-knowledge/contracts.ts";
import type { DecompositionLimits } from "./decomposition-limits.ts";

/** Untrusted decomposition job submitted by the deterministic controller. */
export interface DecompositionJob {
  readonly jobId: string;
  readonly spec: {
    readonly intent: string;
    readonly acceptanceCriteria: readonly string[];
    readonly constraints?: readonly string[];
  };
  readonly rawSpec?: string;
  readonly targetRepository: { readonly owner: string; readonly name: string };
  readonly head: string;
  readonly indexRevision: IndexRevision;
}

/** ADR-018 node emission. */
export interface DecompositionNode {
  readonly id: string;
  readonly intent: string;
  readonly change_spec: string;
  readonly acceptance_criteria: readonly string[];
  readonly depends_on: readonly string[];
}

/** Valid decomposition result handed to downstream deterministic validation. */
export interface DecompositionCandidate {
  readonly nodes: readonly DecompositionNode[];
}

/** Typed failure returned when deterministic controls reject the job or output. */
export interface DecompositionFailure {
  readonly code: string;
  readonly reason: string;
  readonly jobId: string;
}

/** Verified Pi executable identity supplied by the launcher. */
export interface PiExecutableIdentity {
  readonly path: string;
  readonly version: string;
  readonly digest: string;
}

/** Immutable record of one decomposition invocation. */
export interface DecompositionInvocationRecord {
  readonly jobId: string;
  readonly initialPrompt: string;
  readonly repairPrompt?: string;
  readonly selectedModel: string;
  readonly routing: {
    readonly role: string;
    readonly selectedModel: string;
    readonly policyVersion: number;
    readonly rationale: readonly unknown[];
    readonly fallbackBehavior: {
      readonly primaryAvailable: boolean;
      readonly selectedFallbackIndex: number | null;
      readonly skippedCandidates: readonly unknown[];
    };
  };
  readonly breadthTool: {
    readonly name: string;
    readonly version: string;
    readonly limits: { readonly maxUnits: number; readonly maxEdges: number };
  };
  readonly package: {
    readonly name: string;
    readonly version: string;
    readonly path: string;
  };
  readonly launcher: {
    readonly path: string;
    readonly version: string;
    readonly digest: string;
  };
  readonly piExecutable: PiExecutableIdentity;
  readonly limitPolicy: {
    readonly version: number;
    readonly limits: DecompositionLimits;
  };
  readonly sanitizerPolicy: {
    readonly version: number;
  };
  readonly indexRevision: IndexRevision;
}

/** Injected breadth-retrieval port. */
export interface BreadthRetriever {
  readonly retrieve: (
    revision: IndexRevision,
    limits: { readonly maxUnits: number; readonly maxEdges: number },
    abortSignal?: AbortSignal,
  ) => Promise<BreadthResult>;
}

/** Injected model-invocation port. */
export interface ModelInvocation {
  readonly prompt: string;
  readonly model: string;
  readonly deadlineMs: number;
  readonly maxOutputTokens: number;
}

export interface DecompositionModelInvoker {
  readonly invoke: (invocation: ModelInvocation, abortSignal: AbortSignal) => Promise<string>;
}

export function isDecompositionCandidate(value: unknown): value is DecompositionCandidate {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DecompositionCandidate).nodes === "object" &&
    Array.isArray((value as DecompositionCandidate).nodes)
  );
}

export function isDecompositionFailure(value: unknown): value is DecompositionFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DecompositionFailure).code === "string" &&
    typeof (value as DecompositionFailure).reason === "string"
  );
}
