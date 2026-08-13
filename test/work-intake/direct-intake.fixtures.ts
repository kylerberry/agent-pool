import assert from 'node:assert/strict';

import { InMemoryIdempotencyStore } from '../../src/domains/work-intake/idempotency.ts';
import { isRejection } from '../../src/domains/work-intake/contracts.ts';
import type { DirectTaskAcceptance, DirectTaskResult } from '../../src/domains/work-intake/contracts.ts';

export function deps(seed = 0) {
  let counter = seed;
  return {
    store: new InMemoryIdempotencyStore(),
    generateSubmissionId: () => `sub-${++counter}`,
  };
}

export const unit = (overrides: Record<string, unknown> = {}) => ({
  id: 'a',
  intent: 'do the thing',
  change_spec: 'change the thing',
  acceptance_criteria: ['the thing is changed'],
  ...overrides,
});

export const body = (overrides: Record<string, unknown> = {}) => ({
  repo: 'owner/repo',
  branch: 'main',
  ...overrides,
});

export function accepted(result: DirectTaskResult): DirectTaskAcceptance {
  assert.equal(isRejection(result), false, `expected acceptance, got ${JSON.stringify(result)}`);
  return result as DirectTaskAcceptance;
}
