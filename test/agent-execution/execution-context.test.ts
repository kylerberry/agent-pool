import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOCK_SKEW_TOLERANCE_MS,
  FRESHNESS_CEILING_SECONDS,
  createInMemoryNonceStore,
  isExecutionFailure,
  validateExecutionContext,
  type LaunchExpectations,
} from '../../src/domains/agent-execution/index.ts';

const NOW = Date.parse('2026-07-31T12:00:00Z');
const NONCE = 'a'.repeat(64);
const WORKSPACE = '/tmp/agent-pool/attempt-1';

const expectations: LaunchExpectations = {
  nodeId: 'node-1',
  attemptId: 'attempt-1',
  targetRepo: 'owner/repo',
  targetBranch: 'main',
  workspacePath: WORKSPACE,
};

function marker(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 3,
    actor: 'pool-worker',
    node_id: 'node-1',
    attempt_id: 'attempt-1',
    attempt_nonce: NONCE,
    issued_by: 'agent-pool-supervisor',
    issued_at: '2026-07-31T11:59:00Z',
    expires_at: '2026-07-31T12:02:00Z',
    max_age_seconds: 180,
    target_repo: 'owner/repo',
    target_branch: 'main',
    workspace_path: WORKSPACE,
    pi_runtime_parent: '/tmp/agent-pool/pi-runtime',
    pi_session_dir: '/tmp/agent-pool/pi-runtime/session-1',
    pi_executable_identity: { path: '/opt/pi/pi', version: '0.81.1', digest: 'd1' },
    package_identity: { path: '/opt/agent-pool-worker-harness', profile: 'pool-proof-builder', digest: 'd2' },
    profile_identity: { name: 'pool-proof-builder', path: '/opt/agent-pool-worker-harness/profile', digest: 'd3' },
    selected_model: 'moonshot/kimi-k2.7-code',
    tool_grants: ['read', 'edit', 'write', 'bash'],
    result_destination: { kind: 'sqlite', id: 'result-1' },
    ...overrides,
  };
}

function codeOf(result: unknown): string {
  assert.ok(isExecutionFailure(result), `expected a failure, got ${JSON.stringify(result)}`);
  return result.code;
}

describe('execution context binding', () => {
  it('accepts a fresh launcher-owned context bound to node, attempt, repo, branch, and workspace', () => {
    const result = validateExecutionContext(marker(), expectations, { now: NOW });
    assert.equal(isExecutionFailure(result), false);
    assert.ok('context' in result);
    assert.equal(result.context.node_id, 'node-1');
    assert.equal(result.context.workspace_path, WORKSPACE);
  });

  it('rejects a non-object context', () => {
    assert.equal(codeOf(validateExecutionContext('pool-worker', expectations, { now: NOW })), 'CONTEXT_NOT_AN_OBJECT');
    assert.equal(codeOf(validateExecutionContext(null, expectations, { now: NOW })), 'CONTEXT_NOT_AN_OBJECT');
    assert.equal(codeOf(validateExecutionContext([marker()], expectations, { now: NOW })), 'CONTEXT_NOT_AN_OBJECT');
  });

  it('rejects unknown and missing fields', () => {
    assert.equal(
      codeOf(validateExecutionContext(marker({ escalate: true }), expectations, { now: NOW })),
      'CONTEXT_UNKNOWN_FIELD',
    );
    const { workspace_path: _omitted, ...withoutWorkspace } = marker();
    assert.equal(
      codeOf(validateExecutionContext(withoutWorkspace, expectations, { now: NOW })),
      'CONTEXT_MISSING_FIELD',
    );
  });

  it('rejects a version 2 context missing launcher-owned Pool Proof fields', () => {
    const legacy = {
      schema_version: 2,
      actor: 'pool-worker',
      node_id: 'node-1',
      attempt_id: 'attempt-1',
      issued_by: 'agent-pool-supervisor',
      issued_at: '2026-07-31T11:59:00Z',
      target_repo: 'owner/repo',
      target_branch: 'main',
    };
    assert.equal(codeOf(validateExecutionContext(legacy, expectations, { now: NOW })), 'CONTEXT_VERSION_UNSUPPORTED');
  });

  it('rejects an issuer other than the supervisor', () => {
    assert.equal(
      codeOf(validateExecutionContext(marker({ issued_by: 'repository-builder' }), expectations, { now: NOW })),
      'CONTEXT_UNTRUSTED_ISSUER',
    );
  });

  it('accepts both supervisor and runtime issuers in v3', () => {
    const supervisor = validateExecutionContext(marker({ issued_by: 'agent-pool-supervisor' }), expectations, { now: NOW });
    assert.equal(isExecutionFailure(supervisor), false);
    const runtime = validateExecutionContext(marker({ issued_by: 'agent-pool-runtime' }), expectations, { now: NOW });
    assert.equal(isExecutionFailure(runtime), false);
    assert.equal('context' in runtime ? runtime.context.issued_by : null, 'agent-pool-runtime');
  });

  it('rejects identity, target, and workspace mismatches independently', () => {
    assert.equal(
      codeOf(validateExecutionContext(marker({ attempt_id: 'attempt-2' }), expectations, { now: NOW })),
      'CONTEXT_IDENTITY_MISMATCH',
    );
    assert.equal(
      codeOf(validateExecutionContext(marker({ node_id: 'node-9' }), expectations, { now: NOW })),
      'CONTEXT_IDENTITY_MISMATCH',
    );
    assert.equal(
      codeOf(validateExecutionContext(marker({ target_branch: 'attacker' }), expectations, { now: NOW })),
      'CONTEXT_TARGET_MISMATCH',
    );
    assert.equal(
      codeOf(validateExecutionContext(marker({ target_repo: 'attacker/repo' }), expectations, { now: NOW })),
      'CONTEXT_TARGET_MISMATCH',
    );
    assert.equal(
      codeOf(
        validateExecutionContext(marker({ workspace_path: '/tmp/agent-pool/other' }), expectations, { now: NOW }),
      ),
      'CONTEXT_WORKSPACE_MISMATCH',
    );
  });

  it('rejects relative and traversing workspace paths', () => {
    for (const path of ['relative/path', '/tmp/../etc', '/tmp/agent-pool/', '']) {
      assert.equal(
        codeOf(validateExecutionContext(marker({ workspace_path: path }), expectations, { now: NOW })),
        'CONTEXT_INVALID_FIELD',
      );
    }
  });

  it('rejects a stale context', () => {
    const stale = marker({ issued_at: '2026-07-31T11:50:00Z', expires_at: '2026-07-31T11:53:00Z' });
    assert.equal(codeOf(validateExecutionContext(stale, expectations, { now: NOW })), 'CONTEXT_STALE');
  });

  it('rejects a context whose expiry has passed even when max_age has not', () => {
    const expired = marker({
      issued_at: '2026-07-31T11:59:00Z',
      expires_at: '2026-07-31T11:59:30Z',
      max_age_seconds: 300,
    });
    assert.equal(codeOf(validateExecutionContext(expired, expectations, { now: NOW })), 'CONTEXT_STALE');
  });

  it('rejects a context issued beyond the clock-skew tolerance', () => {
    const future = marker({ issued_at: '2026-07-31T12:05:00Z', expires_at: '2026-07-31T12:08:00Z' });
    assert.equal(codeOf(validateExecutionContext(future, expectations, { now: NOW })), 'CONTEXT_NOT_YET_VALID');
  });

  it('tolerates small clock skew within the documented allowance', () => {
    const slightlyAhead = marker({ issued_at: '2026-07-31T12:00:20Z', expires_at: '2026-07-31T12:03:00Z' });
    const result = validateExecutionContext(slightlyAhead, expectations, { now: NOW });
    assert.equal(isExecutionFailure(result), false);
    assert.ok(CLOCK_SKEW_TOLERANCE_MS >= 20_000);
  });

  it('rejects a freshness budget above the specification ceiling', () => {
    const lax = marker({ max_age_seconds: FRESHNESS_CEILING_SECONDS + 1 });
    assert.equal(
      codeOf(validateExecutionContext(lax, expectations, { now: NOW })),
      'CONTEXT_FRESHNESS_CEILING_EXCEEDED',
    );
  });

  it('rejects an expiry that outruns the context own freshness budget', () => {
    const incoherent = marker({
      issued_at: '2026-07-31T11:59:00Z',
      expires_at: '2026-07-31T12:04:00Z',
      max_age_seconds: 60,
    });
    assert.equal(codeOf(validateExecutionContext(incoherent, expectations, { now: NOW })), 'CONTEXT_EXPIRY_INCOHERENT');
  });

  it('rejects an expiry at or before issue time', () => {
    const inverted = marker({ issued_at: '2026-07-31T11:59:00Z', expires_at: '2026-07-31T11:59:00Z' });
    assert.equal(codeOf(validateExecutionContext(inverted, expectations, { now: NOW })), 'CONTEXT_EXPIRY_INCOHERENT');
  });

  it('rejects malformed and impossible timestamps', () => {
    assert.equal(
      codeOf(validateExecutionContext(marker({ issued_at: 'July 31, 2026' }), expectations, { now: NOW })),
      'CONTEXT_INVALID_FIELD',
    );
    assert.equal(
      codeOf(validateExecutionContext(marker({ issued_at: '2026-02-30T11:59:00Z' }), expectations, { now: NOW })),
      'CONTEXT_INVALID_FIELD',
    );
    assert.equal(
      codeOf(validateExecutionContext(marker({ issued_at: '2026-07-31T11:59:00+01:00' }), expectations, { now: NOW })),
      'CONTEXT_INVALID_FIELD',
    );
  });

  it('rejects a malformed nonce', () => {
    for (const nonce of ['short', 'A'.repeat(64), `${'a'.repeat(64)}!`]) {
      assert.equal(
        codeOf(validateExecutionContext(marker({ attempt_nonce: nonce }), expectations, { now: NOW })),
        'CONTEXT_INVALID_FIELD',
      );
    }
  });

  it('bounds field length before running path and timestamp patterns', () => {
    const oversized = marker({ workspace_path: `/tmp/${'a'.repeat(100_000)}` });
    assert.equal(codeOf(validateExecutionContext(oversized, expectations, { now: NOW })), 'CONTEXT_INVALID_FIELD');
  });

  it('rejects a replayed context on second use', () => {
    const nonceStore = createInMemoryNonceStore();
    const first = validateExecutionContext(marker(), expectations, { now: NOW, nonceStore });
    assert.equal(isExecutionFailure(first), false);
    const second = validateExecutionContext(marker(), expectations, { now: NOW, nonceStore });
    assert.equal(codeOf(second), 'CONTEXT_REPLAYED');
  });

  it('does not consume the nonce when validation fails earlier', () => {
    const nonceStore = createInMemoryNonceStore();
    const rejected = validateExecutionContext(marker({ target_branch: 'attacker' }), expectations, {
      now: NOW,
      nonceStore,
    });
    assert.equal(codeOf(rejected), 'CONTEXT_TARGET_MISMATCH');
    const retried = validateExecutionContext(marker(), expectations, { now: NOW, nonceStore });
    assert.equal(isExecutionFailure(retried), false);
  });

  it('rejects DAG topology smuggled into the context', () => {
    const withTopology = { ...marker(), depends_on: ['model-routing-foundation'] };
    // Unknown-field rejection fires first; the topology sweep is the second net.
    assert.equal(codeOf(validateExecutionContext(withTopology, expectations, { now: NOW })), 'CONTEXT_UNKNOWN_FIELD');
  });

  it('returns a deeply frozen credential-free context', () => {
    const result = validateExecutionContext(marker(), expectations, { now: NOW });
    assert.ok('context' in result);
    assert.equal(Object.isFrozen(result.context), true);
    assert.throws(() => {
      (result.context as unknown as Record<string, unknown>).target_branch = 'attacker';
    });
  });
});
