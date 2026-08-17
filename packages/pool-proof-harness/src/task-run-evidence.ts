/**
 * Runner-owned task-run evidence builder and schema validator.
 *
 * Records the manifest identity, attempt/result ids, selected model, bounded
 * process outcome, result commit, verifier checks, informational base-state
 * command results, cleanup disposition, and redacted/capped diagnostics.
 * Carries no host paths, credentials, prompts, or raw model output
 * (report.ts build/validate separation pattern).
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error worker-harness JSON schema validator has no type declarations
import { validateInstance } from '../../worker-harness/lib/json-schema-subset.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(
  readFileSync(join(packageRoot, 'contracts', 'task-run-evidence.schema.json'), 'utf8'),
) as Record<string, unknown>;

const DETAIL_CAP = 300;

export type TaskRunEvidence = {
  readonly schema_version: 1;
  readonly manifest_sha256: string;
  readonly task_id: string;
  readonly base_commit: string;
  readonly attempt_id: string;
  readonly result_id: string;
  readonly selected_model: string;
  readonly status: 'passed' | 'failed';
  readonly process: {
    readonly exit_code: number | null;
    readonly signal_code: NodeJS.Signals | null;
    readonly timed_out: boolean;
    readonly pid_present: boolean;
  };
  readonly result_commit: string | null;
  readonly verifier_checks: readonly { readonly name: string; readonly passed: boolean }[];
  readonly base_state_evidence: readonly {
    readonly command: readonly string[];
    readonly exit_code: number;
    readonly timed_out: boolean;
  }[];
  readonly cleanup_disposition: {
    readonly workspace_removed: boolean;
    readonly session_removed: boolean;
  };
  readonly diagnostics: {
    readonly started_at: string;
    readonly finished_at: string;
    readonly failure_code: string | null;
    readonly detail: string | null;
  };
};

/** Redact credential shapes and host paths, then cap at 300 characters. */
export function redactAndCap(value: string | undefined | null, cap = DETAIL_CAP): string | null {
  if (value === null || value === undefined || value.length === 0) return null;
  let s = value;
  s = s.replace(/(?:MOONSHOT_API_KEY|ZAI_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN|ANTHROPIC_API_KEY)\s*=\s*\S+/gi, '[REDACTED]');
  s = s.replace(/sk-[A-Za-z0-9]{16,}/g, '[REDACTED]');
  s = s.replace(/(?:api[_-]?key|token|secret|password|credential|auth[_-]?token)["'\s:=]+[A-Za-z0-9_\-./+=]{8,}/gi, '[REDACTED]');
  s = s.replace(/(\/(?:Users|var|tmp|private|home|opt|usr|etc|root)[^\s"')\]]*)/g, '[REDACTED_PATH]');
  if (s.length > cap) {
    s = s.slice(0, cap) + '…';
  }
  return s;
}

export function buildTaskRunEvidence(input: {
  manifest_sha256: string;
  task_id: string;
  base_commit: string;
  attempt_id: string;
  result_id: string;
  selected_model: string;
  status: 'passed' | 'failed';
  process: { exit_code: number | null; signal_code: NodeJS.Signals | null; timed_out: boolean; pid_present: boolean };
  result_commit: string | null;
  checks: readonly { name: string; passed: boolean }[];
  base_state_evidence: readonly { command: readonly string[]; exit_code: number; timed_out: boolean }[];
  cleanup_disposition: { workspace_removed: boolean; session_removed: boolean };
  started_at: Date;
  finished_at: Date;
  failure_code: string | null;
  failure_detail?: string | undefined | null;
}): TaskRunEvidence {
  return {
    schema_version: 1,
    manifest_sha256: input.manifest_sha256,
    task_id: input.task_id,
    base_commit: input.base_commit,
    attempt_id: input.attempt_id,
    result_id: input.result_id,
    selected_model: input.selected_model,
    status: input.status,
    process: { ...input.process },
    result_commit: input.result_commit,
    verifier_checks: input.checks.map((check) => ({ name: check.name, passed: check.passed })),
    base_state_evidence: input.base_state_evidence.map((entry) => ({ ...entry, command: [...entry.command] })),
    cleanup_disposition: { ...input.cleanup_disposition },
    diagnostics: {
      started_at: input.started_at.toISOString(),
      finished_at: input.finished_at.toISOString(),
      failure_code: input.failure_code,
      detail: redactAndCap(input.failure_detail ?? null),
    },
  };
}

function is40HexSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export function validateTaskRunEvidence(report: unknown): { ok: true } | { ok: false; error: string } {
  const schemaErrors = validateInstance(schema, report);
  if (schemaErrors.length > 0) {
    return { ok: false, error: `schema validation failed: ${schemaErrors.join('; ')}` };
  }
  const obj = report as TaskRunEvidence;

  if (obj.status === 'passed') {
    if (obj.diagnostics.failure_code !== null) {
      return { ok: false, error: 'passed evidence must have null failure_code' };
    }
    if (!obj.verifier_checks.every((c) => c.passed)) {
      return { ok: false, error: 'passed evidence requires all verifier checks true' };
    }
    if (obj.result_commit === null || !is40HexSha(obj.result_commit)) {
      return { ok: false, error: 'passed evidence requires a 40-hex SHA-1 result_commit' };
    }
    if (!obj.cleanup_disposition.workspace_removed || !obj.cleanup_disposition.session_removed) {
      return { ok: false, error: 'passed evidence requires complete cleanup' };
    }
  } else {
    if (obj.diagnostics.failure_code === null || obj.diagnostics.failure_code.length === 0) {
      return { ok: false, error: 'failed evidence must have a non-empty failure_code' };
    }
    if (obj.verifier_checks.every((c) => c.passed)) {
      return { ok: false, error: 'failed evidence cannot claim all verifier checks passed' };
    }
    if (obj.result_commit !== null && !is40HexSha(obj.result_commit)) {
      return { ok: false, error: 'failed evidence result_commit must be null or a 40-hex SHA-1' };
    }
  }
  if (!is40HexSha(obj.base_commit)) {
    return { ok: false, error: 'base_commit must be a 40-hex SHA-1' };
  }
  return { ok: true };
}
