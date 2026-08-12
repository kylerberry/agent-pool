import { createHash } from 'node:crypto';

export const ISOLATION_VERSION = 'stage-2-isolation/v1';

/** Strict canonical bytes for all Stage 2 commitments. */
export function canonicalize(value: unknown): string {
  const visit = (item: unknown): string => {
    if (item === null) return 'null';
    switch (typeof item) {
      case 'string': return JSON.stringify(item);
      case 'boolean': return item ? 'true' : 'false';
      case 'number':
        if (!Number.isFinite(item)) throw new TypeError('canonicalization rejects non-finite numbers');
        return JSON.stringify(item);
      case 'object': {
        if (Array.isArray(item)) return `[${item.map(visit).join(',')}]`;
        if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
          throw new TypeError('canonicalization rejects non-plain objects');
        }
        return `{${Object.keys(item as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${visit((item as Record<string, unknown>)[key])}`).join(',')}}`;
      }
      default: throw new TypeError(`canonicalization rejects ${typeof item}`);
    }
  };
  return visit(value);
}

/** Unsalted, versioned, domain-separated SHA-256 commitment. */
export function identityCommitment(domain: string, rawIdentity: unknown): string {
  if (!/^[a-z][a-z0-9-]*$/.test(domain)) throw new TypeError('commitment domain is invalid');
  return createHash('sha256').update(`${ISOLATION_VERSION}\u0000${domain}\u0000${canonicalize(rawIdentity)}`).digest('hex');
}

export type RawStage2Observation = {
  readonly attemptId: string;
  readonly nodeId: string;
  /** Runner-owned verifier verdict, captured before persistence. */
  readonly verifier: {
    readonly status: 'passed' | 'failed';
    readonly commitSha: string | null;
    readonly failureCode: string | null;
    readonly checks: readonly { readonly name: string; readonly passed: boolean }[];
  };
  /** Independently re-read durable result after persistence. */
  readonly persisted: {
    readonly resultId: string;
    readonly status: 'passed' | 'failed';
    readonly commitSha: string | null;
    readonly failureCode: string | null;
    readonly checks: readonly { readonly name: string; readonly passed: boolean }[];
  };
  readonly workspace: string;
  readonly piSession: string;
  readonly nonce: string;
  readonly resultId: string;
  readonly repositoryInstance: string;
  readonly privateRuntime: string;
  readonly broker: string;
  readonly inventory: unknown;
  readonly executionContext: Record<string, unknown>;
  readonly actorIdentity: Record<string, unknown>;
  readonly attemptContract: Record<string, unknown>;
  readonly resourceAttemptId: string;
  readonly expected: {
    readonly workspace: string;
    readonly targetRepo: string;
    readonly targetBranch: string;
    readonly nodeId: string;
    readonly attemptId: string;
  };
};

export const COMMITMENT_FIELDS = [
  'workspace_commitment', 'pi_session_commitment', 'nonce_commitment', 'result_id_commitment',
  'repository_instance_commitment', 'private_runtime_commitment', 'broker_commitment',
  'resource_inventory_commitment', 'execution_context_commitment', 'actor_identity_commitment',
  'attempt_contract_commitment',
] as const;
export type CommitmentField = typeof COMMITMENT_FIELDS[number];
export type IsolationCommitments = Readonly<Record<CommitmentField, string>>;

function fail(message: string): never { throw new Error(`STAGE2_ISOLATION_INVALID: ${message}`); }
function same(left: unknown, right: unknown): boolean { return canonicalize(left) === canonicalize(right); }
function sameChecks(left: readonly { readonly name: string; readonly passed: boolean }[], right: readonly { readonly name: string; readonly passed: boolean }[]): boolean {
  const ordered = (checks: readonly { readonly name: string; readonly passed: boolean }[]) => [...checks].sort((a, b) => a.name.localeCompare(b.name));
  return same(ordered(left), ordered(right));
}

/** Validate owner and cross-boundary bindings before any commitment is derived. */
export function validateRawObservations(observations: readonly RawStage2Observation[]): void {
  if (observations.length !== 3) fail('requires exactly three observations');
  const seenAttempts = new Set<string>();
  const freshness: Array<[string, (o: RawStage2Observation) => unknown]> = [
    ['workspace', (o) => o.workspace], ['pi session', (o) => o.piSession], ['nonce', (o) => o.nonce],
    ['result', (o) => o.resultId], ['repository instance', (o) => o.repositoryInstance],
    ['private runtime', (o) => o.privateRuntime], ['broker', (o) => o.broker], ['inventory', (o) => o.inventory],
    ['execution context', (o) => o.executionContext], ['actor identity', (o) => o.actorIdentity],
    ['attempt contract', (o) => o.attemptContract],
  ];
  const commits = new Set<string>();
  for (const o of observations) {
    if (seenAttempts.has(o.attemptId)) fail(`duplicate attempt ${o.attemptId}`);
    seenAttempts.add(o.attemptId);
    if (o.resourceAttemptId !== o.attemptId || o.expected.attemptId !== o.attemptId || o.expected.nodeId !== o.nodeId) fail(`resource owner mismatch for ${o.attemptId}`);
    if (o.workspace !== o.expected.workspace || o.repositoryInstance !== o.expected.workspace) fail(`workspace/repository binding mismatch for ${o.attemptId}`);
    // Allocator-owned result identity is independently compared with the
    // persisted terminal row; launcher context and inventory bindings follow.
    if (o.persisted.resultId !== o.resultId) fail(`allocator/persisted result id mismatch for ${o.attemptId}`);
    if (o.verifier.status !== o.persisted.status || o.verifier.commitSha !== o.persisted.commitSha || o.verifier.failureCode !== o.persisted.failureCode || !sameChecks(o.verifier.checks, o.persisted.checks)) fail(`verifier/persisted verdict mismatch for ${o.attemptId}`);
    if (!same(o.inventory, { workspace: o.workspace, privateRuntime: o.privateRuntime, session: o.piSession, broker: o.broker, resultId: o.resultId })) fail(`inventory binding mismatch for ${o.attemptId}`);
    const c = o.executionContext;
    if (c.node_id !== o.nodeId || c.attempt_id !== o.attemptId || c.workspace_path !== o.workspace || c.pi_session_dir !== o.piSession || c.pi_runtime_parent !== o.privateRuntime || c.attempt_nonce !== o.nonce || !same(c.result_destination, { kind: 'sqlite', id: o.resultId })) fail(`execution context binding mismatch for ${o.attemptId}`);
    const actor = o.actorIdentity;
    if (actor.actor !== 'pool-worker' || actor.authority !== 'single-attempt-execution' || actor.node_id !== o.nodeId || actor.attempt_id !== o.attemptId || actor.target_repo !== o.expected.targetRepo || actor.target_branch !== o.expected.targetBranch || actor.context_source !== 'launcher-verified' || actor.can_modify_pool_policy !== false) fail(`actor binding mismatch for ${o.attemptId}`);
    const contract = o.attemptContract;
    if (contract.node_id !== o.nodeId || contract.attempt_id !== o.attemptId || contract.target_repo !== o.expected.targetRepo || contract.target_branch !== o.expected.targetBranch) fail(`attempt contract binding mismatch for ${o.attemptId}`);
    if (o.verifier.status === 'passed') {
      if (!o.verifier.commitSha || o.verifier.failureCode !== null || commits.has(o.verifier.commitSha) || !o.verifier.checks.every((check) => check.passed)) fail(`successful verifier binding mismatch for ${o.attemptId}`);
      commits.add(o.verifier.commitSha);
    } else if (o.verifier.commitSha !== null || o.verifier.failureCode !== 'INJECTED_WORKER_FAILURE' || o.verifier.checks.every((check) => check.passed)) fail(`failed verifier algebra mismatch for ${o.attemptId}`);
  }
  for (const [name, pick] of freshness) {
    const values: string[] = [];
    for (const o of observations) {
      const value = canonicalize(pick(o));
      if (values.includes(value)) fail(`raw ${name} reuse`);
      values.push(value);
    }
  }
}

export function deriveCommitments(raw: RawStage2Observation): IsolationCommitments {
  return Object.freeze({
    workspace_commitment: identityCommitment('workspace', raw.workspace),
    pi_session_commitment: identityCommitment('pi-session', raw.piSession),
    nonce_commitment: identityCommitment('nonce', raw.nonce),
    result_id_commitment: identityCommitment('result-id', raw.resultId),
    repository_instance_commitment: identityCommitment('repository-instance', raw.repositoryInstance),
    private_runtime_commitment: identityCommitment('private-runtime', raw.privateRuntime),
    broker_commitment: identityCommitment('broker', raw.broker),
    resource_inventory_commitment: identityCommitment('resource-inventory', raw.inventory),
    execution_context_commitment: identityCommitment('execution-context', raw.executionContext),
    actor_identity_commitment: identityCommitment('actor-identity', raw.actorIdentity),
    attempt_contract_commitment: identityCommitment('attempt-contract', raw.attemptContract),
  });
}

export function attemptBindingHash(input: { readonly attemptId: string; readonly nodeId: string; readonly status: string; readonly commitSha: string | null; readonly commitments: IsolationCommitments }): string {
  return createHash('sha256').update(`${ISOLATION_VERSION}\u0000attempt-binding\u0000${canonicalize(input)}`).digest('hex');
}
