import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAvailability,
  selectForRole,
  selectBuilderEvaluatorPair,
  isRoutingFailure,
  isRoutingDecision,
  PROJECTED_DECISION_FIELDS,
  PROJECTED_FAILURE_FIELDS,
} from '../../src/domains/model-routing-and-evaluation/model-router.ts';
import type { RoutingPolicy } from '../../src/domains/model-routing-and-evaluation/routing-policy.ts';
import type { ApprovedModelId } from '../../src/domains/model-routing-and-evaluation/approved-models.ts';
import { allAvailable, workerPolicy } from './model-router.fixtures.ts';

describe('decision evidence projection and immutability', () => {
  it('projects only allowlisted decision fields', () => {
    const available = allAvailable() as Extract<ReturnType<typeof allAvailable>, { has(_: string): boolean }>;
    const decision = selectForRole(workerPolicy, 'building', available) as {
      selectedModel: string;
      toJSON(): Record<string, unknown>;
    };
    const json = decision.toJSON();
    const keys = Object.keys(json).sort();
    assert.deepEqual(keys, [...PROJECTED_DECISION_FIELDS].sort());
    assert.equal(typeof json.rationale, 'object');
    assert.equal(typeof json.fallbackBehavior, 'object');
  });

  it('projects only allowlisted failure fields', () => {
    const available = validateAvailability([{ fullId: 'openai-codex/gpt-5.6-luna' }]) as Extract<
      ReturnType<typeof validateAvailability>,
      { has(_: string): boolean }
    >;
    const failure = selectForRole(workerPolicy, 'building', available) as { toJSON(): Record<string, unknown> };
    const json = failure.toJSON();
    const keys = Object.keys(json);
    assert.ok(keys.every((k) => (PROJECTED_FAILURE_FIELDS as readonly string[]).includes(k)));
    assert.equal(typeof json.code, 'string');
    assert.equal(typeof json.reason, 'string');
  });

  it('keeps credentials and provider payloads out of decisions and failures', () => {
    const sentinelApiKey = 'sk-routing-test-deadbeef';
    const sentinelPayload = JSON.stringify({ authorization: 'Bearer secret-token' });
    const hostileInput = [
      { fullId: 'openai-codex/gpt-5.6-luna', provider: 'openai-codex', model: 'gpt-5.6-luna', apiKey: sentinelApiKey },
      { fullId: 'moonshot/kimi-k3', provider: 'moonshot', model: 'kimi-k3', payload: sentinelPayload },
    ];
    const available = validateAvailability(hostileInput) as Extract<
      ReturnType<typeof validateAvailability>,
      { has(_: string): boolean }
    >;
    const decision = selectForRole(workerPolicy, 'building', available) as unknown as { toJSON(): string };
    const serialized = JSON.stringify(decision);
    assert.equal(serialized.includes(sentinelApiKey), false);
    assert.equal(serialized.includes(sentinelPayload), false);
    assert.equal(serialized.includes('apiKey'), false);
    assert.equal(serialized.includes('payload'), false);
  });

  it('deeply freezes decision evidence against source mutation', () => {
    const decision = selectForRole(
      workerPolicy,
      'building',
      validateAvailability([{ fullId: 'moonshot/kimi-k2.7-code' }]) as Extract<
        ReturnType<typeof validateAvailability>,
        { has(_: string): boolean }
      >,
    ) as unknown as { rationale: unknown[]; fallbackBehavior: { skippedCandidates: unknown[] }; toJSON(): Record<string, unknown> };
    const json = decision.toJSON();

    // Returned nested views must be immutable; mutation attempts throw.
    assert.throws(() => decision.rationale.push({ code: 'tamper' } as never));
    assert.throws(() => decision.fallbackBehavior.skippedCandidates.push({ model: 'x', reason: 'y' } as never));

    // Mutating a returned serialization must not affect subsequent serializations.
    const jsonAfterMutation = decision.toJSON();
    assert.deepEqual(jsonAfterMutation.rationale, json.rationale);
    assert.deepEqual(jsonAfterMutation.fallbackBehavior, json.fallbackBehavior);
  });

  it('serializes consistently after repeated mutation attempts', () => {
    const decision = selectForRole(
      workerPolicy,
      'building',
      validateAvailability([{ fullId: 'moonshot/kimi-k2.7-code' }]) as Extract<
        ReturnType<typeof validateAvailability>,
        { has(_: string): boolean }
      >,
    ) as { toJSON(): Record<string, unknown> };
    const first = JSON.stringify(decision.toJSON());
    const returned = decision.toJSON();
    returned.rationale = ['tampered'] as unknown as typeof returned.rationale;
    const second = JSON.stringify(decision.toJSON());
    assert.equal(first, second);
  });

  it('does not serialize failures as successful decisions', () => {
    const available = validateAvailability([{ fullId: 'openai-codex/gpt-5.6-luna' }]) as Extract<
      ReturnType<typeof validateAvailability>,
      { has(_: string): boolean }
    >;
    const failure = selectForRole(workerPolicy, 'building', available);
    assert.equal(isRoutingFailure(failure), true);
    assert.equal(isRoutingDecision(failure), false);
    const failureJson = (failure as { toJSON(): Record<string, unknown> }).toJSON();
    assert.equal(failureJson.selectedModel, undefined);
    assert.equal(failureJson.rationale, undefined);
    assert.equal(typeof failureJson.code, 'string');
    assert.equal(typeof failureJson.reason, 'string');
  });

  it('projects only allowlisted, credential-free failure fields', () => {
    const secretRole = 'secret-role-password=hunter2';
    const secretModel = 'sk-deadbeef-explicit-model-secret';
    const available = allAvailable() as Extract<ReturnType<typeof allAvailable>, { has(_: string): boolean }>;

    const unknownRoleFailure = selectForRole(workerPolicy, secretRole, available) as { toJSON(): Record<string, unknown> };
    const unknownRoleJson = unknownRoleFailure.toJSON();
    assert.ok((PROJECTED_FAILURE_FIELDS as readonly string[]).every((k) => Object.prototype.hasOwnProperty.call(unknownRoleJson, k) || unknownRoleJson[k] === undefined));
    assert.equal(unknownRoleJson.role, undefined);
    assert.equal(JSON.stringify(unknownRoleJson).includes(secretRole), false);

    const unapprovedFailure = selectForRole(workerPolicy, 'building', available, secretModel) as { toJSON(): Record<string, unknown> };
    const unapprovedJson = unapprovedFailure.toJSON();
    assert.equal(unapprovedJson.requestedModel, undefined);
    assert.equal(JSON.stringify(unapprovedJson).includes(secretModel), false);
    assert.equal((unapprovedJson.reason as string).includes(secretModel), false);
  });
});
