import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, validateReport } from '../src/report.ts';

const baseCommit = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const resultCommit = 'cafebabecafebabecafebabecafebabecafebabe';
const redEvidence = { command: ['node', '--test', 'test/message.test.js'] as const, exitCode: 1, outputArtifact: 'red output' };
const greenEvidence = { command: ['node', '--test', 'test/message.test.js'] as const, exitCode: 0, outputArtifact: 'green output' };

describe('Stage 1 proof report', () => {
  it('builds a schema-valid real-model report', () => {
    const report = buildReport({
      nodeId: 'single-worker-pool-proof',
      attemptId: 'att://proof/single-worker-pool-proof/1',
      model: 'moonshot/kimi-k2.7-code',
      baseCommit,
      resultCommit,
      status: 'passed',
      fakeAdapter: false,
      checks: [{ name: 'fixture_test_passes', passed: true }],
      startedAt: new Date('2026-08-05T00:00:00Z'),
      finishedAt: new Date('2026-08-05T00:01:00Z'),
      failureCode: null,
      cleanupDisposition: { workspaceRemoved: true, sessionRemoved: true },
      redEvidence,
      greenEvidence,
    });
    assert.equal(report.fake_adapter, false);
    assert.equal(report.residual_warning.includes('not production authorization'), true);
    assert.equal(report.red_evidence.exit_code, 1);
    assert.equal(report.green_evidence.exit_code, 0);
    const validated = validateReport(report);
    assert.equal(validated.ok, true);
  });

  it('rejects a report claiming fake adapters', () => {
    const report = buildReport({
      nodeId: 'n',
      attemptId: 'a',
      model: 'm',
      baseCommit,
      resultCommit: 'cafebabecafebabecafebabecafebabecafe0001',
      status: 'passed',
      fakeAdapter: false,
      checks: [],
      startedAt: new Date(),
      finishedAt: new Date(),
      failureCode: null,
      cleanupDisposition: { workspaceRemoved: true, sessionRemoved: true },
      redEvidence,
      greenEvidence,
    });
    const tampered = { ...report, fake_adapter: true };
    const validated = validateReport(tampered);
    assert.equal(validated.ok, false);
  });

  it('rejects passed report with a check failure', () => {
    const report = buildReport({
      nodeId: 'n',
      attemptId: 'a',
      model: 'm',
      baseCommit,
      resultCommit: 'cafebabecafebabecafebabecafebabecafe0001',
      status: 'passed',
      fakeAdapter: false,
      checks: [{ name: 'ok', passed: false }],
      startedAt: new Date(),
      finishedAt: new Date(),
      failureCode: null,
      cleanupDisposition: { workspaceRemoved: true, sessionRemoved: true },
      redEvidence,
      greenEvidence,
    });
    assert.equal(validateReport(report).ok, false);
  });

  it('rejects passed report with incomplete cleanup', () => {
    const report = buildReport({
      nodeId: 'n',
      attemptId: 'a',
      model: 'm',
      baseCommit,
      resultCommit: 'cafebabecafebabecafebabecafebabecafe0001',
      status: 'passed',
      fakeAdapter: false,
      checks: [{ name: 'ok', passed: true }],
      startedAt: new Date(),
      finishedAt: new Date(),
      failureCode: null,
      cleanupDisposition: { workspaceRemoved: false, sessionRemoved: true },
      redEvidence,
      greenEvidence,
    });
    assert.equal(validateReport(report).ok, false);
  });

  it('rejects non-distinct base and result commits', () => {
    const report = buildReport({
      nodeId: 'n',
      attemptId: 'a',
      model: 'm',
      baseCommit,
      resultCommit: baseCommit,
      status: 'passed',
      fakeAdapter: false,
      checks: [{ name: 'ok', passed: true }],
      startedAt: new Date(),
      finishedAt: new Date(),
      failureCode: null,
      cleanupDisposition: { workspaceRemoved: true, sessionRemoved: true },
      redEvidence,
      greenEvidence,
    });
    assert.equal(validateReport(report).ok, false);
  });

  it('rejects failed report without a failure_code', () => {
    const report = buildReport({
      nodeId: 'n',
      attemptId: 'a',
      model: 'm',
      baseCommit,
      resultCommit: 'cafebabecafebabecafebabecafebabecafe0001',
      status: 'failed',
      fakeAdapter: false,
      checks: [{ name: 'ok', passed: false }],
      startedAt: new Date(),
      finishedAt: new Date(),
      failureCode: null,
      cleanupDisposition: { workspaceRemoved: false, sessionRemoved: false },
      redEvidence,
      greenEvidence: { ...greenEvidence, exitCode: 1 },
    });
    assert.equal(validateReport(report).ok, false);
  });

  it('rejects failed report claiming green evidence exit code 0', () => {
    const report = buildReport({
      nodeId: 'n',
      attemptId: 'a',
      model: 'm',
      baseCommit,
      resultCommit: 'cafebabecafebabecafebabecafebabecafe0001',
      status: 'failed',
      fakeAdapter: false,
      checks: [{ name: 'ok', passed: false }],
      startedAt: new Date(),
      finishedAt: new Date(),
      failureCode: 'RUNTIME_FAILURE',
      cleanupDisposition: { workspaceRemoved: false, sessionRemoved: false },
      redEvidence,
      greenEvidence,
    });
    assert.equal(validateReport(report).ok, false);
  });

  it('rejects failed report claiming all checks passed', () => {
    const report = buildReport({
      nodeId: 'n',
      attemptId: 'a',
      model: 'm',
      baseCommit,
      resultCommit: 'cafebabecafebabecafebabecafebabecafe0001',
      status: 'failed',
      fakeAdapter: false,
      checks: [{ name: 'ok', passed: true }],
      startedAt: new Date(),
      finishedAt: new Date(),
      failureCode: 'RUNTIME_FAILURE',
      cleanupDisposition: { workspaceRemoved: false, sessionRemoved: false },
      redEvidence,
      greenEvidence: { ...greenEvidence, exitCode: 1 },
    });
    assert.equal(validateReport(report).ok, false);
  });

  it('accepts a failed launch report with a null result commit', () => {
    const report = buildReport({
      nodeId: 'single-worker-pool-proof',
      attemptId: 'single-worker-pool-proof-attempt-1',
      model: 'moonshot/kimi-k2.7-code',
      baseCommit,
      resultCommit: null,
      status: 'failed',
      fakeAdapter: false,
      checks: [{ name: 'launcher_binding', passed: false }],
      startedAt: new Date(),
      finishedAt: new Date(),
      failureCode: 'POOL_PROOF_LAUNCHER_MISMATCH: launcher expectation binding failed',
      cleanupDisposition: { workspaceRemoved: false, sessionRemoved: false },
      redEvidence,
      greenEvidence: { ...greenEvidence, exitCode: 1 },
    });
    const validated = validateReport(report);
    assert.equal(validated.ok, true);
    assert.equal(report.result_commit, null);
  });

  it('accepts a failed verifier report with a null result commit', () => {
    const report = buildReport({
      nodeId: 'single-worker-pool-proof',
      attemptId: 'single-worker-pool-proof-attempt-1',
      model: 'moonshot/kimi-k2.7-code',
      baseCommit,
      resultCommit: null,
      status: 'failed',
      fakeAdapter: false,
      checks: [
        { name: 'process_exit_success', passed: true },
        { name: 'fixture_test_passes', passed: false },
      ],
      startedAt: new Date(),
      finishedAt: new Date(),
      failureCode: 'VERIFIER_CHECK_FAILED',
      cleanupDisposition: { workspaceRemoved: true, sessionRemoved: true },
      redEvidence,
      greenEvidence: { ...greenEvidence, exitCode: 1 },
    });
    const validated = validateReport(report);
    assert.equal(validated.ok, true);
  });

  it('accepts a no-commit failure report', () => {
    const report = buildReport({
      nodeId: 'single-worker-pool-proof',
      attemptId: 'single-worker-pool-proof-attempt-1',
      model: 'moonshot/kimi-k2.7-code',
      baseCommit,
      resultCommit: null,
      status: 'failed',
      fakeAdapter: false,
      checks: [{ name: 'commit_resolved', passed: false }],
      startedAt: new Date(),
      finishedAt: new Date(),
      failureCode: 'NO_RESULT_COMMIT',
      cleanupDisposition: { workspaceRemoved: true, sessionRemoved: true },
      redEvidence,
      greenEvidence: { ...greenEvidence, exitCode: 1 },
    });
    const validated = validateReport(report);
    assert.equal(validated.ok, true);
  });

  it('rejects a passed report with a null result commit', () => {
    const report = buildReport({
      nodeId: 'n',
      attemptId: 'a',
      model: 'm',
      baseCommit,
      resultCommit: null,
      status: 'passed',
      fakeAdapter: false,
      checks: [{ name: 'ok', passed: true }],
      startedAt: new Date(),
      finishedAt: new Date(),
      failureCode: null,
      cleanupDisposition: { workspaceRemoved: true, sessionRemoved: true },
      redEvidence,
      greenEvidence,
    });
    assert.equal(validateReport(report).ok, false);
  });

  it('enforces schema bounds on oversized fields', () => {
    const report = buildReport({
      nodeId: 'n',
      attemptId: 'a',
      model: 'm',
      baseCommit,
      resultCommit: 'cafebabecafebabecafebabecafebabecafe0001',
      status: 'passed',
      fakeAdapter: false,
      checks: [{ name: 'ok', passed: true }],
      startedAt: new Date(),
      finishedAt: new Date(),
      failureCode: null,
      cleanupDisposition: { workspaceRemoved: true, sessionRemoved: true },
      redEvidence,
      greenEvidence: { ...greenEvidence, outputArtifact: 'x'.repeat(10_000) },
    });
    assert.equal(validateReport(report).ok, false);
  });
});
