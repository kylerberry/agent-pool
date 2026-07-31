import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  validateAvailability,
  selectForRole,
  selectBuilderEvaluatorPair,
  isRoutingFailure,
  isRoutingDecision,
  PROJECTED_DECISION_FIELDS,
  PROJECTED_FAILURE_FIELDS,
} from '../../src/domains/model-routing-and-evaluation/model-router.ts';
import { loadWorkerBootstrapPolicy } from '../../src/domains/model-routing-and-evaluation/bootstrap-policy.ts';
import type { RoutingPolicy } from '../../src/domains/model-routing-and-evaluation/routing-policy.ts';
import type { ApprovedModelId } from '../../src/domains/model-routing-and-evaluation/approved-models.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerFixturePath = join(__dirname, '../../packages/worker-harness/config/model-routing.bootstrap.json');
const workerFixture = JSON.parse(readFileSync(workerFixturePath, 'utf8'));
const workerPolicy = loadWorkerBootstrapPolicy(workerFixture);

function allAvailable() {
  return validateAvailability([
    { fullId: 'openai-codex/gpt-5.6-luna' },
    { fullId: 'moonshot/kimi-k2.7-code' },
    { fullId: 'openai-codex/gpt-5.6-terra' },
    { fullId: 'moonshot/kimi-k3' },
    { fullId: 'openai-codex/gpt-5.6-sol' },
  ]);
}

describe('availability snapshot validation', () => {
  it('accepts a clean snapshot of approved models', () => {
    const result = allAvailable();
    assert.equal(isRoutingFailure(result), false);
    const available = result as Extract<typeof result, { has(_: string): boolean }>;
    assert.equal(available.has('openai-codex/gpt-5.6-sol'), true);
    assert.equal(available.values().length, 5);
  });

  it('rejects a malformed container', () => {
    assert.equal(isRoutingFailure(validateAvailability(null)), true);
    assert.equal(isRoutingFailure(validateAvailability('not-an-array')), true);
    assert.equal(isRoutingFailure(validateAvailability({})), true);
    assert.equal(isRoutingFailure(validateAvailability([{ provider: 'openai-codex' }])), true);
  });

  it('rejects unqualified IDs in availability entries', () => {
    const result = validateAvailability([{ fullId: 'gpt-5.6-luna' }]);
    assert.equal(isRoutingFailure(result), true);
  });

  it('rejects aliases and unknown provider/model IDs', () => {
    assert.equal(isRoutingFailure(validateAvailability([{ fullId: 'moonshot/kimi-k2.7' }])), true);
    assert.equal(isRoutingFailure(validateAvailability([{ fullId: 'anthropic/claude-sonnet' }])), true);
  });

  it('rejects duplicate entries', () => {
    const result = validateAvailability([
      { fullId: 'openai-codex/gpt-5.6-luna' },
      { fullId: 'openai-codex/gpt-5.6-luna' },
    ]);
    assert.equal(isRoutingFailure(result), true);
  });

  it('rejects entries with inconsistent provider/model fields', () => {
    assert.equal(
      isRoutingFailure(
        validateAvailability([{ fullId: 'openai-codex/gpt-5.6-luna', provider: 'moonshot' }]),
      ),
      true,
    );
    assert.equal(
      isRoutingFailure(
        validateAvailability([{ fullId: 'openai-codex/gpt-5.6-luna', model: 'kimi-k3' }]),
      ),
      true,
    );
  });

  it('treats absent models as unavailable but does not fail the snapshot', () => {
    const available = validateAvailability([
      { fullId: 'openai-codex/gpt-5.6-luna' },
      { fullId: 'openai-codex/gpt-5.6-sol' },
    ]) as Extract<ReturnType<typeof validateAvailability>, { has(_: string): boolean }>;
    assert.equal(available.has('openai-codex/gpt-5.6-luna'), true);
    assert.equal(available.has('moonshot/kimi-k3'), false);
  });
});

describe('role routing', () => {
  it('selects the configured primary when available', () => {
    const available = allAvailable() as Extract<ReturnType<typeof allAvailable>, { has(_: string): boolean }>;
    const decision = selectForRole(workerPolicy, 'building', available);
    assert.equal(isRoutingDecision(decision), true);
    assert.equal((decision as { selectedModel: string }).selectedModel, 'moonshot/kimi-k2.7-code');
  });

  it('selects the first available ordered fallback when primary is absent', () => {
    const available = validateAvailability([
      { fullId: 'openai-codex/gpt-5.6-terra' },
      { fullId: 'moonshot/kimi-k3' },
    ]) as Extract<ReturnType<typeof validateAvailability>, { has(_: string): boolean }>;
    const decision = selectForRole(workerPolicy, 'building', available);
    assert.equal((decision as { selectedModel: string }).selectedModel, 'openai-codex/gpt-5.6-terra');
    const fallbackBehavior = (decision as { fallbackBehavior: { selectedFallbackIndex: number; primaryAvailable: boolean } }).fallbackBehavior;
    assert.equal(fallbackBehavior.selectedFallbackIndex, 0);
    assert.equal(fallbackBehavior.primaryAvailable, false);
  });

  it('fails closed when no configured candidate is available', () => {
    const available = validateAvailability([{ fullId: 'openai-codex/gpt-5.6-luna' }]) as Extract<
      ReturnType<typeof validateAvailability>,
      { has(_: string): boolean }
    >;
    const result = selectForRole(workerPolicy, 'building', available);
    assert.equal(isRoutingFailure(result), true);
  });

  it('fails closed for unavailable explicit model without consulting fallback', () => {
    const available = validateAvailability([{ fullId: 'openai-codex/gpt-5.6-luna' }]) as Extract<
      ReturnType<typeof validateAvailability>,
      { has(_: string): boolean }
    >;
    const result = selectForRole(workerPolicy, 'building', available, 'moonshot/kimi-k2.7-code');
    assert.equal(isRoutingFailure(result), true);
    const failure = result as { requestedModel?: string };
    assert.equal(failure.requestedModel, 'moonshot/kimi-k2.7-code');
  });

  it('accepts an available explicit approved model', () => {
    const available = allAvailable() as Extract<ReturnType<typeof allAvailable>, { has(_: string): boolean }>;
    const decision = selectForRole(workerPolicy, 'building', available, 'openai-codex/gpt-5.6-sol');
    assert.equal(isRoutingDecision(decision), true);
    assert.equal((decision as { selectedModel: string }).selectedModel, 'openai-codex/gpt-5.6-sol');
  });

  it('rejects an explicit unapproved model', () => {
    const available = allAvailable() as Extract<ReturnType<typeof allAvailable>, { has(_: string): boolean }>;
    const result = selectForRole(workerPolicy, 'building', available, 'anthropic/claude-sonnet');
    assert.equal(isRoutingFailure(result), true);
  });

  it('records rationale and fallback behavior', () => {
    const available = validateAvailability([
      { fullId: 'openai-codex/gpt-5.6-terra' },
    ]) as Extract<ReturnType<typeof validateAvailability>, { has(_: string): boolean }>;
    const decision = selectForRole(workerPolicy, 'building', available) as unknown as {
      role: string;
      selectedModel: string;
      policyVersion: number;
      rationale: unknown[];
      fallbackBehavior: { skippedCandidates: unknown[] };
    };
    assert.equal(decision.role, 'building');
    assert.equal(decision.policyVersion, 1);
    assert.ok(decision.rationale.length > 0);
    assert.ok(decision.fallbackBehavior.skippedCandidates.length > 0);
  });
});

describe('builder/evaluator pair routing', () => {
  it('selects distinct builder and evaluator models', () => {
    const available = allAvailable() as Extract<ReturnType<typeof allAvailable>, { has(_: string): boolean }>;
    const result = selectBuilderEvaluatorPair(workerPolicy, available);
    assert.equal(isRoutingFailure(result), false);
    const pair = result as { builder: { selectedModel: ApprovedModelId }; evaluator: { selectedModel: ApprovedModelId } };
    assert.notEqual(pair.builder.selectedModel, pair.evaluator.selectedModel);
  });

  it('ensures evaluator capability is never lower than builder capability', () => {
    const available = allAvailable() as Extract<ReturnType<typeof allAvailable>, { has(_: string): boolean }>;
    const result = selectBuilderEvaluatorPair(workerPolicy, available);
    const pair = result as { builder: { selectedModel: ApprovedModelId }; evaluator: { selectedModel: ApprovedModelId } };
    const builderRank = workerPolicy.getCapabilityRank(pair.builder.selectedModel);
    const evaluatorRank = workerPolicy.getCapabilityRank(pair.evaluator.selectedModel);
    assert.ok(evaluatorRank >= builderRank);
  });

  it('fails closed when no valid pair exists', () => {
    const available = validateAvailability([{ fullId: 'openai-codex/gpt-5.6-sol' }]) as Extract<
      ReturnType<typeof validateAvailability>,
      { has(_: string): boolean }
    >;
    const result = selectBuilderEvaluatorPair(workerPolicy, available);
    assert.equal(isRoutingFailure(result), true);
  });

  it('respects explicit builder and evaluator constraints', () => {
    const available = allAvailable() as Extract<ReturnType<typeof allAvailable>, { has(_: string): boolean }>;
    const result = selectBuilderEvaluatorPair(workerPolicy, available, {
      explicitBuilder: 'moonshot/kimi-k2.7-code',
      explicitEvaluator: 'openai-codex/gpt-5.6-sol',
    });
    const pair = result as { builder: { selectedModel: ApprovedModelId }; evaluator: { selectedModel: ApprovedModelId } };
    assert.equal(pair.builder.selectedModel, 'moonshot/kimi-k2.7-code');
    assert.equal(pair.evaluator.selectedModel, 'openai-codex/gpt-5.6-sol');
  });

  it('fails closed when explicit pair violates the capability invariant', () => {
    const available = allAvailable() as Extract<ReturnType<typeof allAvailable>, { has(_: string): boolean }>;
    const result = selectBuilderEvaluatorPair(workerPolicy, available, {
      explicitBuilder: 'openai-codex/gpt-5.6-sol',
      explicitEvaluator: 'moonshot/kimi-k2.7-code',
    });
    assert.equal(isRoutingFailure(result), true);
  });

  it('enforces builder/evaluator invariants unconditionally even if policy rules disable them', () => {
    const hostilePolicy: RoutingPolicy = {
      version: 99,
      status: 'hostile',
      actor: 'test',
      getCapabilityRank: workerPolicy.getCapabilityRank.bind(workerPolicy),
      getRoleConfig(role: string) {
        if (role === 'building') {
          return { primary: 'openai-codex/gpt-5.6-luna', fallback: ['openai-codex/gpt-5.6-terra'] };
        }
        if (role === 'assessing') {
          return {
            primary: 'openai-codex/gpt-5.6-luna',
            fallback: ['openai-codex/gpt-5.6-terra', 'moonshot/kimi-k3', 'openai-codex/gpt-5.6-sol'],
          };
        }
        return undefined;
      },
      hasRule() {
        return false;
      },
      getRule() {
        return false;
      },
    };
    const available = allAvailable() as Extract<ReturnType<typeof allAvailable>, { has(_: string): boolean }>;
    const result = selectBuilderEvaluatorPair(hostilePolicy, available);
    assert.equal(isRoutingFailure(result), false);
    const pair = result as { builder: { selectedModel: ApprovedModelId }; evaluator: { selectedModel: ApprovedModelId } };
    assert.notEqual(pair.builder.selectedModel, pair.evaluator.selectedModel);
    assert.ok(
      hostilePolicy.getCapabilityRank(pair.evaluator.selectedModel) >= hostilePolicy.getCapabilityRank(pair.builder.selectedModel),
    );
  });

  it('exhaustively validates builder/evaluator pairs over availability subsets', () => {
    const models: ApprovedModelId[] = [
      'openai-codex/gpt-5.6-luna',
      'moonshot/kimi-k2.7-code',
      'openai-codex/gpt-5.6-terra',
      'moonshot/kimi-k3',
      'openai-codex/gpt-5.6-sol',
    ];
    for (let mask = 0; mask < 1 << models.length; mask += 1) {
      const subset = models.filter((_, i) => (mask & (1 << i)) !== 0);
      const available = validateAvailability(subset.map((fullId) => ({ fullId }))) as Extract<
        ReturnType<typeof validateAvailability>,
        { has(_: string): boolean }
      >;
      const result = selectBuilderEvaluatorPair(workerPolicy, available);
      if (isRoutingFailure(result)) continue;
      const pair = result as { builder: { selectedModel: ApprovedModelId }; evaluator: { selectedModel: ApprovedModelId } };
      assert.notEqual(pair.builder.selectedModel, pair.evaluator.selectedModel);
      assert.ok(workerPolicy.getCapabilityRank(pair.evaluator.selectedModel) >= workerPolicy.getCapabilityRank(pair.builder.selectedModel));
    }
  });
});

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
