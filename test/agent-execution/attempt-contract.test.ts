import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAG_TOPOLOGY_KEYS,
  findDagTopology,
  isExecutionFailure,
  validateAttemptContracts,
  type AttemptContractExpectations,
} from '../../src/domains/agent-execution/index.ts';

const expectations: AttemptContractExpectations = {
  nodeId: 'node-1',
  attemptId: 'attempt-1',
  targetRepo: 'owner/repo',
  targetBranch: 'main',
};

function contract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    node_id: 'node-1',
    attempt_id: 'attempt-1',
    attempt_number: 1,
    intent: 'Execute one DAG-unaware node attempt',
    change_spec: 'Integrate the explicit worker harness package.',
    acceptance_criteria: [{ id: 'ac-1', text: 'Every attempt receives a fresh launcher-owned context.' }],
    criteria_origin: { source: 'decomposition', source_id: 'spec-42' },
    target_repo: 'owner/repo',
    target_branch: 'main',
    prior_failure_context: [],
    ...overrides,
  };
}

function codeOf(result: unknown): string {
  assert.ok(isExecutionFailure(result), `expected a failure, got ${JSON.stringify(result)}`);
  return result.code;
}

describe('attempt contract', () => {
  it('accepts exactly one well-formed contract', () => {
    const result = validateAttemptContracts([contract()], expectations);
    assert.equal(isExecutionFailure(result), false);
    assert.ok('contract' in result);
    assert.deepEqual([...result.criteriaIds], ['ac-1']);
  });

  it('rejects zero, many, or non-array deliveries', () => {
    assert.equal(codeOf(validateAttemptContracts([], expectations)), 'CONTRACT_NOT_EXACTLY_ONE');
    assert.equal(
      codeOf(validateAttemptContracts([contract(), contract()], expectations)),
      'CONTRACT_NOT_EXACTLY_ONE',
    );
    assert.equal(codeOf(validateAttemptContracts(contract(), expectations)), 'CONTRACT_NOT_EXACTLY_ONE');
    assert.equal(codeOf(validateAttemptContracts(null, expectations)), 'CONTRACT_NOT_EXACTLY_ONE');
  });

  it('rejects DAG topology at the top level of the contract', () => {
    const result = validateAttemptContracts([{ ...contract(), depends_on: ['model-routing-foundation'] }], expectations);
    assert.equal(codeOf(result), 'CONTRACT_UNKNOWN_FIELD');
  });

  it('rejects DAG topology nested inside an otherwise-permitted field', () => {
    const smuggled = contract({
      prior_failure_context: [
        {
          attempt_id: 'attempt-0',
          phase: 'R',
          attempted: ['build'],
          failure_reason: 'tests failed',
          discoveries: [],
          dead_ends: [],
          nodes: ['a', 'b'],
        },
      ],
    });
    assert.equal(codeOf(validateAttemptContracts([smuggled], expectations)), 'CONTRACT_UNKNOWN_FIELD');
  });

  it('sweeps every declared topology key at any depth', () => {
    for (const key of DAG_TOPOLOGY_KEYS) {
      const payload = { level_one: { level_two: { [key]: ['x'] } } };
      assert.equal(findDagTopology(payload), `payload.level_one.level_two.${key}`);
    }
  });

  it('sweeps topology keys inside arrays and tolerates cyclic payloads', () => {
    assert.equal(findDagTopology({ items: [{ ready_frontier: [] }] }), 'payload.items[0].ready_frontier');
    const cyclic: Record<string, unknown> = { safe: 'value' };
    cyclic.self = cyclic;
    assert.equal(findDagTopology(cyclic), null);
  });

  it('rejects identity and target drift from the execution context', () => {
    assert.equal(
      codeOf(validateAttemptContracts([contract({ attempt_id: 'attempt-2' })], expectations)),
      'CONTRACT_IDENTITY_MISMATCH',
    );
    assert.equal(
      codeOf(validateAttemptContracts([contract({ target_repo: 'attacker/repo' })], expectations)),
      'CONTRACT_TARGET_MISMATCH',
    );
  });

  it('requires non-empty acceptance criteria with unique ids', () => {
    assert.equal(
      codeOf(validateAttemptContracts([contract({ acceptance_criteria: [] })], expectations)),
      'CONTRACT_INVALID_FIELD',
    );
    const duplicated = contract({
      acceptance_criteria: [
        { id: 'ac-1', text: 'first' },
        { id: 'ac-1', text: 'second' },
      ],
    });
    assert.equal(codeOf(validateAttemptContracts([duplicated], expectations)), 'CONTRACT_INVALID_FIELD');
    const extraKey = contract({ acceptance_criteria: [{ id: 'ac-1', text: 'first', weight: 2 }] });
    assert.equal(codeOf(validateAttemptContracts([extraKey], expectations)), 'CONTRACT_INVALID_FIELD');
  });

  it('requires criteria provenance from an approved source', () => {
    assert.equal(
      codeOf(validateAttemptContracts([contract({ criteria_origin: { source: 'agent', source_id: 'x' } })], expectations)),
      'CONTRACT_INVALID_FIELD',
    );
    assert.equal(
      codeOf(validateAttemptContracts([contract({ criteria_origin: { source: 'direct-task' } })], expectations)),
      'CONTRACT_INVALID_FIELD',
    );
  });

  it('accepts prior failure context so a retry never starts blind', () => {
    const retry = contract({
      attempt_number: 2,
      prior_failure_context: [
        {
          attempt_id: 'attempt-0',
          phase: 'R',
          attempted: ['pinned the wrong graphify version'],
          failure_reason: 'preflight rejected the version',
          discoveries: ['the version check is exact, not prefix'],
          dead_ends: ['loosening the regex'],
        },
      ],
    });
    const result = validateAttemptContracts([retry], expectations);
    assert.equal(isExecutionFailure(result), false);
    assert.ok('contract' in result);
    assert.equal(result.contract.prior_failure_context[0].phase, 'R');
  });

  it('rejects an unsupported contract version and malformed attempt numbers', () => {
    assert.equal(
      codeOf(validateAttemptContracts([contract({ schema_version: 2 })], expectations)),
      'CONTRACT_VERSION_UNSUPPORTED',
    );
    assert.equal(
      codeOf(validateAttemptContracts([contract({ attempt_number: 0 })], expectations)),
      'CONTRACT_INVALID_FIELD',
    );
    assert.equal(
      codeOf(validateAttemptContracts([contract({ attempt_number: 1.5 })], expectations)),
      'CONTRACT_INVALID_FIELD',
    );
  });
});
