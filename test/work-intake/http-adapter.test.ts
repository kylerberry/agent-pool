import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { handleDirectTaskRequest } from '../../src/domains/work-intake/http-adapter.ts';
import { InMemoryIdempotencyStore } from '../../src/domains/work-intake/idempotency.ts';
import type { DirectTaskAcceptance } from '../../src/domains/work-intake/contracts.ts';

function deps(callerId: string | null = 'caller-1') {
  let counter = 0;
  return {
    store: new InMemoryIdempotencyStore(),
    generateSubmissionId: () => `sub-${++counter}`,
    authenticate: () =>
      callerId === null ? ({ authenticated: false } as const) : ({ authenticated: true, callerId } as const),
  };
}

const unit = (overrides: Record<string, unknown> = {}) => ({
  id: 'a',
  intent: 'do the thing',
  change_spec: 'change the thing',
  acceptance_criteria: ['the thing is changed'],
  ...overrides,
});

const request = (overrides: Record<string, unknown> = {}) => ({
  method: 'POST',
  path: '/tasks',
  headers: {} as Record<string, string | undefined>,
  body: { repo: 'owner/repo', branch: 'main', unit: unit() },
  ...overrides,
});

describe('POST /tasks adapter', () => {
  it('returns 202 for a newly accepted submission', () => {
    const response = handleDirectTaskRequest(request(), deps());
    assert.equal(response.status, 202);
    assert.equal((response.body as DirectTaskAcceptance).gate2_required, true);
  });

  it('returns 202 for a hand-authored DAG', () => {
    const response = handleDirectTaskRequest(
      request({
        body: { repo: 'owner/repo', branch: 'main', units: [unit({ id: 'a' }), unit({ id: 'b', depends_on: ['a'] })] },
      }),
      deps(),
    );
    assert.equal(response.status, 202);
    assert.equal((response.body as DirectTaskAcceptance).units.length, 2);
  });

  it('returns 200 with the original body on an idempotent replay', () => {
    const dependencies = deps();
    const headers = { 'Idempotency-Key': 'k1' };

    const first = handleDirectTaskRequest(request({ headers }), dependencies);
    const second = handleDirectTaskRequest(request({ headers }), dependencies);

    assert.equal(first.status, 202);
    assert.equal(second.status, 200);
    assert.equal(
      (second.body as DirectTaskAcceptance).submission_id,
      (first.body as DirectTaskAcceptance).submission_id,
    );
  });

  it('reads the idempotency header case-insensitively', () => {
    const dependencies = deps();
    handleDirectTaskRequest(request({ headers: { 'Idempotency-Key': 'k1' } }), dependencies);
    const replay = handleDirectTaskRequest(request({ headers: { 'idempotency-key': 'k1' } }), dependencies);
    assert.equal(replay.status, 200);
  });

  it('returns 409 when the same key carries a different payload', () => {
    const dependencies = deps();
    const headers = { 'Idempotency-Key': 'k1' };
    handleDirectTaskRequest(request({ headers }), dependencies);

    const conflict = handleDirectTaskRequest(
      request({
        headers,
        body: { repo: 'owner/repo', branch: 'main', unit: unit({ change_spec: 'something else' }) },
      }),
      dependencies,
    );
    assert.equal(conflict.status, 409);
  });

  it('returns 400 for a validation failure', () => {
    const response = handleDirectTaskRequest(
      request({ body: { repo: 'owner/repo', branch: 'main', unit: { id: 'a' } } }),
      deps(),
    );
    assert.equal(response.status, 400);
  });

  it('returns 400 for an unparseable body', () => {
    assert.equal(handleDirectTaskRequest(request({ body: undefined }), deps()).status, 400);
  });

  it('returns 401 when authentication fails', () => {
    const response = handleDirectTaskRequest(request(), deps(null));
    assert.equal(response.status, 401);
  });

  it('never reads the caller id from the request body', () => {
    const response = handleDirectTaskRequest(
      request({ body: { repo: 'owner/repo', branch: 'main', unit: unit(), caller_id: 'someone-else' } }),
      deps('caller-1'),
    );
    assert.equal(response.status, 400, 'caller_id in the body is an unknown field');
  });

  it('uses the authenticated principal for provenance, not any header the caller sets', () => {
    const response = handleDirectTaskRequest(
      request({ headers: { 'x-caller-id': 'spoofed' } }),
      deps('caller-1'),
    );
    const acceptance = response.body as DirectTaskAcceptance;
    assert.equal(acceptance.units[0]?.acceptance_criteria_provenance.caller_id, 'caller-1');
  });

  it('returns 405 for a non-POST method', () => {
    assert.equal(handleDirectTaskRequest(request({ method: 'GET' }), deps()).status, 405);
  });

  it('returns 404 for another path', () => {
    assert.equal(handleDirectTaskRequest(request({ path: '/specs' }), deps()).status, 404);
  });
});
