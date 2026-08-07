import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildActorIdentity,
  createActorIdentityAccessor,
  renderIdentityCapsule,
  validateExecutionContext,
  createInMemoryNonceStore,
  SUPPORTED_CONTEXT_SCHEMA_VERSION,
  type ExecutionContextShape,
} from '../../src/domains/agent-execution/index.ts';

const baseContext: ExecutionContextShape = {
  schema_version: 3,
  actor: 'pool-worker',
  node_id: 'node-1',
  attempt_id: 'attempt-1',
  attempt_nonce: 'a'.repeat(64),
  issued_by: 'agent-pool-supervisor',
  issued_at: '2026-08-05T00:00:00Z',
  expires_at: '2026-08-05T00:03:00Z',
  max_age_seconds: 180,
  target_repo: 'owner/repo',
  target_branch: 'main',
  workspace_path: '/workspace/attempt-1',
  pi_runtime_parent: '/pi/runtime',
  pi_session_dir: '/pi/runtime/session-1',
  pi_executable_identity: { path: '/opt/pi/pi', version: '0.81.1', digest: 'd1' },
  package_identity: { path: '/opt/harness', profile: 'pool-proof-builder', digest: 'd2' },
  profile_identity: { name: 'pool-proof-builder', path: '/opt/harness/profile', digest: 'd3' },
  selected_model: 'moonshot/kimi-k2.7-code',
  tool_grants: ['read', 'edit'],
  result_destination: { kind: 'sqlite', id: 'result-1' },
};

const expectations = {
  nodeId: 'node-1',
  attemptId: 'attempt-1',
  targetRepo: 'owner/repo',
  targetBranch: 'main',
  workspacePath: '/workspace/attempt-1',
  piRuntimeParent: '/pi/runtime',
  piSessionDir: '/pi/runtime/session-1',
  piExecutablePath: '/opt/pi/pi',
  piExecutableVersion: '0.81.1',
  piExecutableDigest: 'd1',
  packagePath: '/opt/harness',
  packageProfile: 'pool-proof-builder',
  packageDigest: 'd2',
  profileName: 'pool-proof-builder',
  profilePath: '/opt/harness/profile',
  profileDigest: 'd3',
  selectedModel: 'moonshot/kimi-k2.7-code',
  toolGrants: ['read', 'edit'],
  resultDestinationId: 'result-1',
};

describe('actor_identity', () => {
  it('returns launcher-captured sanitized identity', () => {
    const id = buildActorIdentity(baseContext);
    assert.equal(id.actor, 'pool-worker');
    assert.equal(id.authority, 'single-attempt-execution');
    assert.equal(id.node_id, 'node-1');
    assert.equal(id.attempt_id, 'attempt-1');
    assert.equal(id.can_modify_pool_policy, false);
    assert.equal(id.context_source, 'launcher-verified');
  });

  it('accessor is parameterless and returns the same identity', () => {
    const accessor = createActorIdentityAccessor(baseContext);
    const a = accessor.actor_identity();
    const b = accessor.actor_identity();
    assert.deepEqual(a, b);
    assert.equal(a.can_modify_pool_policy, false);
  });

  it('renders the launcher-verified identity capsule for the system prompt', () => {
    const capsule = renderIdentityCapsule(baseContext);
    assert.ok(capsule.includes('ACTOR: Pool Worker'));
    assert.ok(capsule.includes('AUTHORITY: Execute exactly one supplied attempt contract'));
    assert.ok(capsule.includes('ATTEMPT: attempt-1'));
    assert.ok(capsule.includes('TARGET: owner/repo@main'));
    assert.ok(capsule.includes('NOT AUTHORIZED:'));
  });
});

const VALID_NOW = Date.parse('2026-08-05T00:01:00Z');

describe('execution context v3', () => {
  it('accepts a valid Pool Proof context', () => {
    const result = validateExecutionContext(baseContext, expectations, { poolProofExpectations: expectations, now: VALID_NOW });
    assert.ok(!('code' in result), 'expected success');
  });

  it('rejects v2 context missing Pool Proof fields', () => {
    const v2 = { ...baseContext, schema_version: 2 } as unknown as Record<string, unknown>;
    delete v2.pi_runtime_parent;
    const result = validateExecutionContext(v2, expectations, { poolProofExpectations: expectations, now: VALID_NOW });
    assert.ok('code' in result);
    assert.equal(result.code, 'CONTEXT_VERSION_UNSUPPORTED');
  });

  it('rejects unapproved selected model', () => {
    const ctx = { ...baseContext, selected_model: 'anthropic/hostile' };
    const result = validateExecutionContext(ctx, expectations, { poolProofExpectations: { ...expectations, selectedModel: 'anthropic/hostile' }, now: VALID_NOW });
    assert.ok('code' in result);
    assert.equal(result.code, 'POOL_PROOF_MODEL_UNAPPROVED');
  });

  it('replays are rejected', () => {
    const store = createInMemoryNonceStore();
    const r1 = validateExecutionContext(baseContext, expectations, { poolProofExpectations: expectations, nonceStore: store, now: VALID_NOW });
    assert.ok(!('code' in r1));
    const r2 = validateExecutionContext(baseContext, expectations, { poolProofExpectations: expectations, nonceStore: store, now: VALID_NOW });
    assert.ok('code' in r2);
    assert.equal(r2.code, 'CONTEXT_REPLAYED');
  });
});
