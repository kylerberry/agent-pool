/**
 * Stage 1 proof report builder and schema validator.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error worker-harness JSON schema validator has no type declarations
import { validateInstance } from '../../worker-harness/lib/json-schema-subset.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(
  readFileSync(join(packageRoot, 'contracts', 'stage-1-proof-report.schema.json'), 'utf8'),
) as Record<string, unknown>;

export type Stage1ProofReport = {
  readonly schema_version: 1;
  readonly node_id: string;
  readonly attempt_id: string;
  readonly model: string;
  readonly base_commit: string;
  readonly result_commit: string | null;
  readonly status: 'passed' | 'failed';
  readonly fake_adapter: boolean;
  readonly verifier_checks: readonly { readonly name: string; readonly passed: boolean }[];
  readonly diagnostics: {
    readonly started_at: string;
    readonly finished_at: string;
    readonly failure_code: string | null;
  };
  readonly cleanup_disposition: {
    readonly workspace_removed: boolean;
    readonly session_removed: boolean;
  };
  readonly residual_warning: string;
  readonly red_evidence: {
    readonly command: readonly string[];
    readonly exit_code: number;
    readonly output_artifact: string;
  };
  readonly green_evidence: {
    readonly command: readonly string[];
    readonly exit_code: number;
    readonly output_artifact: string;
  };
};

export function buildReport(input: {
  nodeId: string;
  attemptId: string;
  model: string;
  baseCommit: string;
  resultCommit: string | null;
  status: 'passed' | 'failed';
  fakeAdapter: boolean;
  checks: readonly { readonly name: string; readonly passed: boolean }[];
  startedAt: Date;
  finishedAt: Date;
  failureCode: string | null;
  cleanupDisposition: { workspaceRemoved: boolean; sessionRemoved: boolean };
  redEvidence: { command: readonly string[]; exitCode: number; outputArtifact: string };
  greenEvidence: { command: readonly string[]; exitCode: number; outputArtifact: string };
}): Stage1ProofReport {
  return {
    schema_version: 1,
    node_id: input.nodeId,
    attempt_id: input.attemptId,
    model: input.model,
    base_commit: input.baseCommit,
    result_commit: input.resultCommit,
    status: input.status,
    fake_adapter: input.fakeAdapter,
    verifier_checks: input.checks,
    diagnostics: {
      started_at: input.startedAt.toISOString(),
      finished_at: input.finishedAt.toISOString(),
      failure_code: input.failureCode,
    },
    cleanup_disposition: {
      workspace_removed: input.cleanupDisposition.workspaceRemoved,
      session_removed: input.cleanupDisposition.sessionRemoved,
    },
    residual_warning: 'This controlled fixture proof is not production authorization for arbitrary repositories.',
    red_evidence: {
      command: input.redEvidence.command,
      exit_code: input.redEvidence.exitCode,
      output_artifact: input.redEvidence.outputArtifact,
    },
    green_evidence: {
      command: input.greenEvidence.command,
      exit_code: input.greenEvidence.exitCode,
      output_artifact: input.greenEvidence.outputArtifact,
    },
  };
}

function is40HexSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export function validateReport(report: unknown): { ok: true } | { ok: false; error: string } {
  const schemaErrors = validateInstance(schema, report);
  if (schemaErrors.length > 0) {
    return { ok: false, error: `schema validation failed: ${schemaErrors.join('; ')}` };
  }
  const obj = report as Stage1ProofReport;

  if (obj.fake_adapter !== false) {
    return { ok: false, error: 'fake_adapter must be false' };
  }
  if (obj.status === 'passed') {
    if (obj.diagnostics.failure_code !== null) {
      return { ok: false, error: 'passed report must have null failure_code' };
    }
    if (!obj.verifier_checks.every((c) => c.passed)) {
      return { ok: false, error: 'passed report requires all verifier checks true' };
    }
    if (obj.red_evidence.exit_code === 0) {
      return { ok: false, error: 'red evidence must have non-zero exit code' };
    }
    if (obj.green_evidence.exit_code !== 0) {
      return { ok: false, error: 'green evidence must have zero exit code' };
    }
    if (obj.result_commit === null || !is40HexSha(obj.result_commit)) {
      return { ok: false, error: 'passed report requires a 40-hex SHA-1 result_commit' };
    }
    if (obj.base_commit === obj.result_commit) {
      return { ok: false, error: 'base_commit and result_commit must be distinct' };
    }
  } else {
    if (obj.diagnostics.failure_code === null || obj.diagnostics.failure_code.length === 0) {
      return { ok: false, error: 'failed report must have a non-empty failure_code' };
    }
    if (obj.green_evidence.exit_code === 0) {
      return { ok: false, error: 'failed report cannot claim green evidence with exit code 0' };
    }
    if (obj.verifier_checks.every((c) => c.passed)) {
      return { ok: false, error: 'failed report cannot claim all verifier checks passed' };
    }
    if (obj.result_commit !== null && !is40HexSha(obj.result_commit)) {
      return { ok: false, error: 'failed report result_commit must be null or a 40-hex SHA-1' };
    }
  }
  if (!is40HexSha(obj.base_commit)) {
    return { ok: false, error: 'base_commit must be a 40-hex SHA-1' };
  }
  if (obj.status === 'passed' && (!obj.cleanup_disposition.workspace_removed || !obj.cleanup_disposition.session_removed)) {
    return { ok: false, error: 'passed report requires complete cleanup' };
  }
  return { ok: true };
}
