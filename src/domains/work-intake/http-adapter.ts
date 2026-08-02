/**
 * Policy-free HTTP adapter for `POST /tasks`.
 *
 * Framework-agnostic by design: it maps a already-parsed request shape onto the
 * domain boundary and back to a status code. It holds no auth policy of its own
 * — the caller injects an `authenticate` function, keeping the pool's bearer
 * token scheme outside the domain (integration seam with the controller).
 */

import type { DirectTaskResult, IntakeErrorCode, IntakeViolation } from './contracts.ts';
import { isRejection } from './contracts.ts';
import type { DirectIntakeDependencies } from './direct-intake.ts';
import { acceptDirectTasks } from './direct-intake.ts';

export const DIRECT_TASK_PATH = '/tasks';

export type HttpRequest = {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** Already-parsed JSON body, or `undefined` when parsing failed. */
  readonly body: unknown;
};

export type HttpResponse = {
  readonly status: number;
  readonly body: unknown;
};

export type AuthenticationResult =
  | { readonly authenticated: true; readonly callerId: string }
  | { readonly authenticated: false };

export type HttpAdapterDependencies = DirectIntakeDependencies & {
  readonly authenticate: (headers: Readonly<Record<string, string | undefined>>) => AuthenticationResult;
};

/**
 * Rejections map to a status by their most severe code. Idempotency conflicts
 * are 409 because the request is well-formed but contradicts recorded state;
 * everything else caller-correctable is 400.
 */
const STATUS_BY_CODE: Partial<Record<IntakeErrorCode, number>> = {
  UNAUTHENTICATED: 401,
  IDEMPOTENCY_KEY_PAYLOAD_MISMATCH: 409,
};

export function statusForViolations(violations: readonly IntakeViolation[]): number {
  for (const violation of violations) {
    const status = STATUS_BY_CODE[violation.code];
    if (status !== undefined) return status;
  }
  return 400;
}

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

/**
 * Handle a `POST /tasks` request.
 *
 * A replayed acceptance returns 200 to distinguish it from the 202 of a
 * submission that was newly enqueued; both carry the identical body, which is
 * what makes the replay observably the original result.
 */
export function handleDirectTaskRequest(
  request: HttpRequest,
  dependencies: HttpAdapterDependencies,
): HttpResponse {
  if (request.path !== DIRECT_TASK_PATH) {
    return { status: 404, body: { rejected: true, violations: [] } };
  }
  if (request.method.toUpperCase() !== 'POST') {
    return {
      status: 405,
      body: {
        rejected: true,
        violations: [{ code: 'MALFORMED_BODY', path: '$', message: 'only POST is supported' }],
      },
    };
  }

  const authentication = dependencies.authenticate(request.headers);
  if (!authentication.authenticated) {
    return {
      status: 401,
      body: {
        rejected: true,
        violations: [
          { code: 'UNAUTHENTICATED', path: '$', message: 'an authenticated caller id is required' },
        ],
      },
    };
  }

  const result: DirectTaskResult = acceptDirectTasks(
    {
      callerId: authentication.callerId,
      body: request.body,
      idempotencyKey: headerValue(request.headers, 'idempotency-key') ?? null,
    },
    dependencies,
  );

  if (isRejection(result)) {
    return { status: statusForViolations(result.violations), body: result };
  }

  return { status: result.replayed ? 200 : 202, body: result };
}
