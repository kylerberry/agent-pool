/**
 * Smallest production composition root for authenticated single-unit
 * POST /tasks through SQLite import, a SQLite-backed claim loop, and
 * owner-scoped GET /tasks/{submission_id}.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acceptDirectTasks,
  DIRECT_TASK_PATH,
  DIRECT_TASK_ROUTE,
  idempotencyScopeKey,
  isRejection,
  isValidIdempotencyKey,
  statusForViolations,
  type AuthenticationResult,
  type DirectTaskAcceptance,
  type HttpRequest,
  type HttpResponse,
} from '../domains/work-intake/index.ts';
import {
  deriveAttemptId,
  deriveJobId,
  type OrchestrationStore,
} from '../domains/orchestration/index.ts';
import type { AdapterProvenance } from '../domains/agent-execution/minimal-pool-runtime.ts';

import { parseTaskManifest, type TaskManifest } from './task-manifest.ts';
import { runClaimedTask, type TaskRunnerOverrides, type TaskRunnerPreflight } from './task-runner.ts';

export type DirectTaskSettings = {
  readonly task_id: string;
  readonly target_repo_path: string;
  readonly base_commit: string;
  readonly allowed_changed_paths: readonly string[];
  readonly verification_commands: readonly (readonly string[])[];
  readonly model: TaskManifest['model'];
  readonly bounds: TaskManifest['bounds'];
};

export type DirectTaskServiceOptions = {
  readonly store: OrchestrationStore;
  readonly authenticate: (headers: Readonly<Record<string, string | undefined>>) => AuthenticationResult;
  readonly generateSubmissionId: () => string;
  readonly taskSettings: DirectTaskSettings;
  readonly adapterProvenance: AdapterProvenance;
  readonly adapterOverrides?: TaskRunnerOverrides;
  readonly preflight: TaskRunnerPreflight & { readonly sandboxImage?: { readonly image: string; readonly runtime: string; readonly verified: boolean } };
  readonly containerRuntime: 'docker' | 'podman';
  readonly sandboxImage: string;
  readonly leaseTtlMs?: number;
};

export type DirectTaskService = {
  readonly handleRequest: (request: HttpRequest) => Promise<HttpResponse>;
  readonly claimOnce: () => Promise<void>;
};

function headerValue(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) return headers[key];
  }
  return undefined;
}

function submissionPath(path: string): string | null {
  const prefix = `${DIRECT_TASK_PATH}/`;
  if (!path.startsWith(prefix)) return null;
  const id = path.slice(prefix.length);
  if (id.length === 0 || id.includes('/')) return null;
  return id;
}

function combineManifest(
  settings: DirectTaskSettings,
  unit: DirectTaskAcceptance['units'][number],
): ReturnType<typeof parseTaskManifest> {
  const criteria = unit.acceptance_criteria.map((text, index) => ({
    id: `c${index + 1}`,
    text,
  }));
  return parseTaskManifest({
    schema_version: 1,
    task_id: settings.task_id,
    target_repo_path: settings.target_repo_path,
    base_commit: settings.base_commit,
    intent: unit.intent,
    change_spec: unit.change_spec,
    acceptance_criteria: criteria,
    allowed_changed_paths: [...settings.allowed_changed_paths],
    verification_commands: settings.verification_commands.map((argv) => [...argv]),
    model: settings.model,
    bounds: { ...settings.bounds },
  });
}

function acceptanceWithWork(acceptance: DirectTaskAcceptance, workId: string): DirectTaskAcceptance & { readonly work_id: string } {
  return Object.freeze({ ...acceptance, work_id: workId });
}

function boundedStatus(input: {
  readonly submission_id: string;
  readonly work_id: string;
  readonly node_id: string;
  readonly node_state: string;
  readonly attempt_id: string | null;
  readonly result_status: 'passed' | 'failed' | null;
  readonly result_id: string | null;
  readonly commit_present: boolean;
  readonly checks: readonly { readonly name: string; readonly passed: boolean }[];
}): Record<string, unknown> {
  const terminal = input.result_status ?? (input.node_state === 'passed' || input.node_state === 'failed' ? input.node_state : input.attempt_id ? 'in_progress' : 'accepted');
  return {
    submission_id: input.submission_id,
    work_id: input.work_id,
    node_id: input.node_id,
    status: terminal,
    attempt: input.attempt_id ? { attempt_id: input.attempt_id } : null,
    result: input.result_id && input.result_status
      ? {
          result_id: input.result_id,
          status: input.result_status,
          commit_present: input.commit_present,
          checks: input.checks.slice(0, 16),
        }
      : null,
  };
}

export function createDirectTaskService(options: DirectTaskServiceOptions): DirectTaskService {
  const leaseTtlMs = options.leaseTtlMs ?? 10 * 60 * 1000;
  const claimOwner = 'direct-task-service';

  async function handlePost(request: HttpRequest, callerId: string): Promise<HttpResponse> {
    const body = request.body;
    if (body !== null && typeof body === 'object' && !Array.isArray(body) && Object.hasOwn(body, 'units')) {
      return {
        status: 400,
        body: {
          rejected: true,
          violations: [{ code: 'AMBIGUOUS_SUBMISSION_SHAPE', path: '/units', message: 'composed POST /tasks accepts one unit only' }],
        },
      };
    }

    const idempotencyKey = headerValue(request.headers, 'idempotency-key') ?? null;
    if (idempotencyKey !== null && !isValidIdempotencyKey(idempotencyKey)) {
      return {
        status: 400,
        body: {
          rejected: true,
          violations: [{
            code: 'INVALID_IDEMPOTENCY_KEY',
            path: 'Idempotency-Key',
            message: 'idempotency key must be non-empty printable ASCII without whitespace',
          }],
        },
      };
    }
    const scopeKey = idempotencyKey === null ? null : idempotencyScopeKey(callerId, DIRECT_TASK_ROUTE, idempotencyKey);

    const accepted = acceptDirectTasks(
      { callerId, body: request.body, idempotencyKey },
      {
        store: {
          get: () => undefined,
          put: () => {},
        },
        generateSubmissionId: options.generateSubmissionId,
      },
    );
    if (isRejection(accepted)) {
      return { status: statusForViolations(accepted.violations), body: accepted };
    }
    if (accepted.submission_shape !== 'single_unit' || accepted.units.length !== 1) {
      return {
        status: 400,
        body: {
          rejected: true,
          violations: [{ code: 'AMBIGUOUS_SUBMISSION_SHAPE', path: '/units', message: 'composed POST /tasks accepts one unit only' }],
        },
      };
    }

    const unit = accepted.units[0]!;
    const parsed = combineManifest(options.taskSettings, unit);
    if (!parsed.ok) {
      return {
        status: 400,
        body: {
          rejected: true,
          violations: [{ code: 'INVALID_FIELD_FORMAT', path: '/unit', message: parsed.reason }],
        },
      };
    }

    const workId = `work://${accepted.submission_id}`;
    const nodeId = unit.id;
    const imported = await options.store.importDirectTask({
      callerId,
      scopeKey,
      payloadHash: accepted.payload_hash,
      submissionId: accepted.submission_id,
      acceptanceJson: JSON.stringify(accepted),
      manifestJson: JSON.stringify(parsed.manifest),
      work: {
        work_id: workId,
        origin: 'direct_task',
        repo: options.taskSettings.task_id,
        branch: 'detached',
        payload_hash: `sha256:${createHash('sha256').update(JSON.stringify(parsed.manifest)).digest('hex')}`,
        nodes: [{
          id: nodeId,
          intent: unit.intent,
          change_spec: unit.change_spec,
          acceptance_criteria: [...unit.acceptance_criteria],
          depends_on: [],
          criteria_origin_source: 'direct_task',
          criteria_origin_source_id: accepted.submission_id,
        }],
      },
    });
    if ('error' in imported) {
      if (imported.error.code === 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH') {
        return {
          status: 409,
          body: {
            rejected: true,
            violations: [{
              code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
              path: 'Idempotency-Key',
              message: imported.error.message,
            }],
          },
        };
      }
      return {
        status: 400,
        body: {
          rejected: true,
          violations: [{ code: 'MALFORMED_BODY', path: '$', message: imported.error.message }],
        },
      };
    }
    if (imported.kind === 'replayed') {
      const original = JSON.parse(imported.acceptance_json) as DirectTaskAcceptance;
      return { status: 200, body: acceptanceWithWork({ ...original, replayed: true }, imported.work_id) };
    }
    return { status: 202, body: acceptanceWithWork(accepted, imported.work_id) };
  }

  async function handleGet(callerId: string, submissionId: string): Promise<HttpResponse> {
    const submission = await options.store.getDirectTaskSubmission(callerId, submissionId);
    if (!submission) {
      return { status: 404, body: { rejected: true, violations: [] } };
    }
    const nodes = await options.store.listNodes(submission.work_id);
    const node = nodes[0];
    if (!node) {
      return { status: 404, body: { rejected: true, violations: [] } };
    }
    const active = await options.store.getActiveAttemptForNode(submission.work_id, node.node_id);
    const proofRows = await options.store.getProofResultsByWork(submission.work_id);
    const attemptId = active?.attempt_id ?? proofRows[0]?.attempt_id ?? null;
    const proof = attemptId ? await options.store.getProofResult(attemptId) : null;
    const checks = attemptId
      ? (await options.store.getProofChecks(attemptId)).map((c) => ({ name: c.check_name, passed: c.passed === 1 }))
      : [];
    return {
      status: 200,
      body: boundedStatus({
        submission_id: submission.submission_id,
        work_id: submission.work_id,
        node_id: node.node_id,
        node_state: node.state,
        attempt_id: attemptId,
        result_status: proof?.status ?? null,
        result_id: proof?.result_id ?? null,
        commit_present: proof?.commit_sha !== null && proof?.commit_sha !== undefined,
        checks,
      }),
    };
  }

  return {
    async handleRequest(request: HttpRequest): Promise<HttpResponse> {
      const authentication = options.authenticate(request.headers);
      if (!authentication.authenticated) {
        return {
          status: 401,
          body: {
            rejected: true,
            violations: [{ code: 'UNAUTHENTICATED', path: '$', message: 'an authenticated caller id is required' }],
          },
        };
      }
      const method = request.method.toUpperCase();
      if (method === 'POST' && request.path === DIRECT_TASK_PATH) {
        return handlePost(request, authentication.callerId);
      }
      if (method === 'GET') {
        const submissionId = submissionPath(request.path);
        if (submissionId) return handleGet(authentication.callerId, submissionId);
      }
      if (request.path === DIRECT_TASK_PATH) {
        return {
          status: 405,
          body: { rejected: true, violations: [{ code: 'MALFORMED_BODY', path: '$', message: 'only POST is supported' }] },
        };
      }
      return { status: 404, body: { rejected: true, violations: [] } };
    },

    async claimOnce(): Promise<void> {
      const now = new Date();
      for (const attempt of await options.store.listAttemptsNeedingReconciliation(now)) {
        if (attempt.state === 'leased') {
          await options.store.reclaimLease(attempt.attempt_id, claimOwner, now);
        }
      }

      const claimables = await options.store.listDirectTaskClaimables();
      const next = claimables.find((row) => row.node_state === 'pending' || row.node_state === 'ready' || (row.node_state === 'in_progress' && row.attempt_state !== 'completed'));
      if (!next) return;
      const proofExisting = next.attempt_id ? await options.store.getProofResult(next.attempt_id) : null;
      if (proofExisting) return;

      let nodeState = next.node_state;
      let nodeVersion = next.node_version;
      if (nodeState === 'pending') {
        const ready = await options.store.transitionNode(next.work_id, next.node_id, nodeVersion, 'ready');
        if ('error' in ready) return;
        nodeState = ready.state;
        nodeVersion = ready.version;
      }

      const attemptNumber = 1;
      const attemptId = next.attempt_id ?? deriveAttemptId(next.work_id, next.node_id, attemptNumber);
      const jobId = deriveJobId(attemptId);
      if (!next.attempt_id) {
        const created = await options.store.createAttempt(
          next.work_id,
          next.node_id,
          attemptId,
          attemptNumber,
          jobId,
          { builder: options.taskSettings.model, policyVersion: 1 },
        );
        if ('error' in created) return;
      }

      if (nodeState === 'ready') {
        const inProgress = await options.store.transitionNode(next.work_id, next.node_id, nodeVersion, 'in_progress');
        if ('error' in inProgress) return;
        nodeVersion = inProgress.version;
      }

      const claimed = await options.store.claimLease(
        { kind: 'claim', attempt_id: attemptId, owner: claimOwner },
        new Date(now.getTime() + leaseTtlMs),
        now,
      );
      if ('error' in claimed) {
        if (claimed.error.code === 'LEASE_CONFLICT') return;
        return;
      }

      const parsed = parseTaskManifest(JSON.parse(next.manifest_json));
      if (!parsed.ok) return;
      const runtimeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'direct-task-runtime-')));
      try {
        const run = await runClaimedTask({
          store: options.store,
          manifest: parsed.manifest,
          identities: {
            workId: next.work_id,
            nodeId: next.node_id,
            attemptId,
            attemptNumber,
            jobId,
            criteriaOriginSourceId: next.submission_id,
          },
          preflight: options.preflight,
          containerRuntime: options.containerRuntime,
          sandboxImage: options.sandboxImage,
          adapterProvenance: options.adapterProvenance,
          adapterOverrides: options.adapterOverrides,
          runtimeRoot,
        });
        const outcome = run.status;
        const accepted = await options.store.acceptResult({
          result_id: run.resultId,
          attempt_id: attemptId,
          node_id: next.node_id,
          work_id: next.work_id,
          outcome,
          phase: 'R',
          token: claimed.token,
          generation: claimed.generation,
          expected_node_version: nodeVersion,
        }, new Date());
        if (accepted.ok) {
          await options.store.completeAuthorizedResult(next.work_id, next.node_id, attemptId);
        }
      } finally {
        try { rmSync(runtimeRoot, { recursive: true, force: true }); } catch {}
      }
    },
  };
}
