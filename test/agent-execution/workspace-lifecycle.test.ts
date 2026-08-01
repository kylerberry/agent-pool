import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_QUARANTINE_MS,
  MAX_QUARANTINE_MS,
  createAttemptWorkspaceLifecycle,
  isExecutionFailure,
  type AttemptWorkspaceLifecycle,
} from '../../src/domains/agent-execution/index.ts';

const START = Date.parse('2026-07-31T12:00:00Z');

function lifecycle(quarantineMs?: number): AttemptWorkspaceLifecycle {
  const created = createAttemptWorkspaceLifecycle({ attemptId: 'attempt-1', startedAt: START, quarantineMs });
  assert.ok(!isExecutionFailure(created));
  return created;
}

describe('attempt workspace cleanup states', () => {
  it('starts ready and blocks cleanup until extraction resolves', () => {
    const workspace = lifecycle();
    assert.equal(workspace.state(), 'ready');
    workspace.beginExtraction();
    assert.equal(workspace.state(), 'extracting');

    const decision = workspace.evaluateCleanup(START + 1_000);
    assert.equal(decision.decision, 'wait');
    assert.equal(decision.state, 'extracting');
  });

  it('authorizes destruction once the transcript audit is complete', () => {
    const workspace = lifecycle();
    workspace.beginExtraction();
    workspace.markAuditComplete();

    const decision = workspace.evaluateCleanup(START + 1_000);
    assert.equal(decision.decision, 'destroy');
    assert.equal(decision.state, 'audit_complete');
    assert.equal(decision.auditIncomplete, false);
  });

  it('holds an audit_incomplete workspace only for the bounded quarantine', () => {
    const workspace = lifecycle(60_000);
    workspace.beginExtraction();
    workspace.markAuditIncomplete('TRANSCRIPT_PERSIST_FAILED');

    const during = workspace.evaluateCleanup(START + 30_000);
    assert.equal(during.decision, 'wait');
    assert.equal(during.auditIncomplete, true);

    const after = workspace.evaluateCleanup(START + 60_000);
    assert.equal(after.decision, 'destroy');
    assert.equal(after.state, 'audit_incomplete');
    assert.equal(after.auditIncomplete, true);
  });

  it('destroys an unsafe workspace even when extraction never resolves', () => {
    // ADR-032: a stuck extraction must not buy indefinite retention.
    const workspace = lifecycle(60_000);
    workspace.beginExtraction();

    const decision = workspace.evaluateCleanup(START + 10 * 60_000);
    assert.equal(decision.decision, 'destroy');
    assert.equal(decision.state, 'extracting');
    assert.equal(decision.auditIncomplete, true);
  });

  it('never returns a decision that retains the workspace indefinitely', () => {
    const workspace = lifecycle();
    workspace.beginExtraction();
    workspace.markAuditIncomplete('TRANSCRIPT_VERIFY_FAILED');

    for (const offset of [0, DEFAULT_QUARANTINE_MS - 1, DEFAULT_QUARANTINE_MS, MAX_QUARANTINE_MS * 10]) {
      const decision = workspace.evaluateCleanup(START + offset);
      assert.ok(['destroy', 'wait'].includes(decision.decision));
    }
    assert.equal(workspace.evaluateCleanup(START + MAX_QUARANTINE_MS * 10).decision, 'destroy');
  });

  it('preserves the extraction failure reason across destruction', () => {
    const workspace = lifecycle(1_000);
    workspace.beginExtraction();
    workspace.markAuditIncomplete('TRANSCRIPT_INDEX_FAILED');

    assert.equal(workspace.evaluateCleanup(START + 2_000).decision, 'destroy');
    assert.equal(workspace.failureReason(), 'TRANSCRIPT_INDEX_FAILED');
  });

  it('rejects out-of-order state transitions', () => {
    const workspace = lifecycle();
    assert.ok(isExecutionFailure(workspace.markAuditComplete()));
    assert.ok(isExecutionFailure(workspace.markAuditIncomplete('x')));

    workspace.beginExtraction();
    assert.ok(isExecutionFailure(workspace.beginExtraction()));

    workspace.markAuditComplete();
    assert.ok(isExecutionFailure(workspace.markAuditIncomplete('x')));
    assert.equal(workspace.state(), 'audit_complete');
  });

  it('rejects a quarantine bound that would allow effectively indefinite retention', () => {
    const rejected = createAttemptWorkspaceLifecycle({
      attemptId: 'attempt-1',
      startedAt: START,
      quarantineMs: MAX_QUARANTINE_MS + 1,
    });
    assert.ok(isExecutionFailure(rejected));

    const infinite = createAttemptWorkspaceLifecycle({
      attemptId: 'attempt-1',
      startedAt: START,
      quarantineMs: Number.POSITIVE_INFINITY,
    });
    assert.ok(isExecutionFailure(infinite));
  });

  it('supports a zero-length quarantine for immediate destruction', () => {
    const workspace = lifecycle(0);
    workspace.beginExtraction();
    workspace.markAuditIncomplete('TRANSCRIPT_PERSIST_FAILED');
    assert.equal(workspace.evaluateCleanup(START).decision, 'destroy');
  });
});
