/**
 * Strict actor-specific bootstrap policy loaders.
 *
 * Worker bootstrap owns pool-worker roles and capability ranks.
 * Orchestrator bootstrap owns only decomposition for the control plane.
 *
 * Trusted source-bound entry points read only the actor-owned fixture;
 * object-level loaders remain available for test/fixture validation.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  APPROVED_MODELS,
  getCapabilityRank,
  isApprovedModelId,
  type ApprovedModelId,
  type ModelId,
} from './approved-models.ts';
import type {
  BootstrapOrchestratorPolicyShape,
  BootstrapWorkerPolicyShape,
  RoleConfig,
} from './contracts.ts';
import type { RoutingPolicy } from './routing-policy.ts';

const WORKER_ROLES = new Set<string>([
  'node_conductor',
  'planning',
  'building',
  'assessing',
  'tightening',
  'sharpening',
  'failure_diagnosis',
]);

const ORCHESTRATOR_ROLES = new Set<string>(['decomposition']);

const WORKER_RULES = new Set<string>([
  'builderEvaluatorMustDiffer',
  'evaluatorMustNotBeLowerCapability',
  'reserveSolFromNormalBuilding',
  'failClosedOnUnavailableExplicitModel',
]);

const ORCHESTRATOR_RULES = new Set<string>(['failClosedOnUnavailableExplicitModel']);

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertNoUnknownFields(value: unknown, allowed: ReadonlySet<string>, label: string): void {
  assertObject(value, label);
  const unknown = Object.keys(value).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    throw new Error(`Unknown ${label} fields: ${unknown.join(', ')}`);
  }
}

function assertValidRoleConfig(
  role: string,
  config: unknown,
): { primary: ApprovedModelId; fallback: ApprovedModelId[] } {
  assertObject(config, `Role ${role} config`);
  assertNoUnknownFields(config, new Set(['primary', 'fallback']), `role ${role} config`);
  const cfg = config as Record<string, unknown>;
  if (typeof cfg.primary !== 'string' || !isApprovedModelId(cfg.primary)) {
    throw new Error(`Role ${role} primary ${String(cfg.primary)} is not an approved model`);
  }
  if (!Array.isArray(cfg.fallback)) {
    throw new Error(`Role ${role} fallback must be an array`);
  }
  const fallback: ApprovedModelId[] = [];
  const seen = new Set<ApprovedModelId>([cfg.primary]);
  for (const entry of cfg.fallback) {
    if (typeof entry !== 'string' || !isApprovedModelId(entry)) {
      throw new Error(`Role ${role} fallback ${String(entry)} is not an approved model`);
    }
    if (seen.has(entry)) {
      throw new Error(`Role ${role} contains duplicate candidate ${entry}`);
    }
    seen.add(entry);
    fallback.push(entry);
  }
  return { primary: cfg.primary, fallback };
}

function validateCapabilityRank(
  rank: Readonly<Record<string, unknown>>,
): asserts rank is Record<ApprovedModelId, number> {
  const extraKeys = Object.keys(rank).filter((k) => !APPROVED_MODELS.includes(k as ApprovedModelId));
  if (extraKeys.length > 0) {
    throw new Error(`Capability rank contains unapproved models: ${extraKeys.join(', ')}`);
  }
  const ranks = new Set<number>();
  for (const id of APPROVED_MODELS) {
    const value = rank[id];
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > APPROVED_MODELS.length) {
      throw new Error(`Capability rank for ${id} must be a finite positive integer in [1, ${APPROVED_MODELS.length}]`);
    }
    if (ranks.has(value)) {
      throw new Error(`Duplicate capability rank ${value}`);
    }
    ranks.add(value);
  }
  if (ranks.size !== APPROVED_MODELS.length) {
    throw new Error('Capability ranks must be unique');
  }
}

function assertWorkerRules(rules: Readonly<Record<string, unknown>>): void {
  assertNoUnknownFields(rules, WORKER_RULES, 'rules');
  if (rules.builderEvaluatorMustDiffer !== true) {
    throw new Error('builderEvaluatorMustDiffer rule must be true');
  }
  if (rules.evaluatorMustNotBeLowerCapability !== true) {
    throw new Error('evaluatorMustNotBeLowerCapability rule must be true');
  }
  for (const name of WORKER_RULES) {
    if (Object.prototype.hasOwnProperty.call(rules, name) && typeof rules[name] !== 'boolean') {
      throw new Error(`Rule ${name} must be a boolean`);
    }
  }
}

function assertOrchestratorRules(rules: Readonly<Record<string, unknown>>): void {
  assertNoUnknownFields(rules, ORCHESTRATOR_RULES, 'rules');
  if (Object.prototype.hasOwnProperty.call(rules, 'failClosedOnUnavailableExplicitModel') && typeof rules.failClosedOnUnavailableExplicitModel !== 'boolean') {
    throw new Error('failClosedOnUnavailableExplicitModel rule must be a boolean');
  }
}

class BootstrapWorkerPolicy implements RoutingPolicy {
  readonly version: number;
  readonly status: string;
  readonly actor = 'pool-worker';
  readonly capabilityRank: Readonly<Record<ApprovedModelId, number>>;
  private readonly roles: ReadonlyMap<string, { readonly primary: ApprovedModelId; readonly fallback: readonly ApprovedModelId[] }>;
  private readonly rules: Readonly<Record<string, unknown>>;

  constructor(shape: BootstrapWorkerPolicyShape) {
    this.version = shape.version;
    this.status = shape.status;
    validateCapabilityRank(shape.capability_rank as Record<string, unknown>);
    this.capabilityRank = Object.freeze({ ...shape.capability_rank } as Record<ApprovedModelId, number>);

    const roleMap = new Map<string, { primary: ApprovedModelId; fallback: readonly ApprovedModelId[] }>();
    for (const role of WORKER_ROLES) {
      const config = shape.roles[role];
      if (!config) {
        throw new Error(`Missing required worker role ${role}`);
      }
      const validated = assertValidRoleConfig(role, config);
      roleMap.set(role, { primary: validated.primary, fallback: Object.freeze([...validated.fallback]) });
    }
    if (Object.keys(shape.roles).some((r) => !WORKER_ROLES.has(r))) {
      const leaked = Object.keys(shape.roles).filter((r) => !WORKER_ROLES.has(r));
      throw new Error(`Worker bootstrap contains disallowed roles: ${leaked.join(', ')}`);
    }
    this.roles = roleMap;

    assertWorkerRules(shape.rules as Record<string, unknown>);
    this.rules = Object.freeze({ ...shape.rules });
  }

  getRoleConfig(role: string): { readonly primary: ModelId; readonly fallback: readonly ModelId[] } | undefined {
    return this.roles.get(role);
  }

  hasRule(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.rules, name);
  }

  getRule(name: string): unknown {
    return (this.rules as Record<string, unknown>)[name];
  }

  getCapabilityRank(modelId: ModelId): number {
    return getCapabilityRank(modelId);
  }
}

class BootstrapOrchestratorPolicy implements RoutingPolicy {
  readonly version: number;
  readonly status: string;
  readonly actor: string;
  private readonly roles: ReadonlyMap<string, { readonly primary: ApprovedModelId; readonly fallback: readonly ApprovedModelId[] }>;
  private readonly rules: Readonly<Record<string, unknown>>;

  constructor(shape: BootstrapOrchestratorPolicyShape) {
    if (shape.actor !== 'orchestrator-control-plane') {
      throw new Error('Orchestrator bootstrap actor must be orchestrator-control-plane');
    }
    this.version = shape.version;
    this.status = shape.status;
    this.actor = shape.actor;

    const roleMap = new Map<string, { primary: ApprovedModelId; fallback: readonly ApprovedModelId[] }>();
    for (const role of ORCHESTRATOR_ROLES) {
      const config = shape.roles[role];
      if (!config) {
        throw new Error(`Missing required orchestrator role ${role}`);
      }
      const validated = assertValidRoleConfig(role, config);
      roleMap.set(role, { primary: validated.primary, fallback: Object.freeze([...validated.fallback]) });
    }
    if (Object.keys(shape.roles).some((r) => !ORCHESTRATOR_ROLES.has(r))) {
      const leaked = Object.keys(shape.roles).filter((r) => !ORCHESTRATOR_ROLES.has(r));
      throw new Error(`Orchestrator bootstrap contains worker roles: ${leaked.join(', ')}`);
    }
    this.roles = roleMap;

    assertOrchestratorRules(shape.rules as Record<string, unknown>);
    this.rules = Object.freeze({ ...shape.rules });
  }

  getRoleConfig(role: string): { readonly primary: ModelId; readonly fallback: readonly ModelId[] } | undefined {
    return this.roles.get(role);
  }

  hasRule(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.rules, name);
  }

  getRule(name: string): unknown {
    return (this.rules as Record<string, unknown>)[name];
  }

  getCapabilityRank(modelId: ModelId): number {
    return getCapabilityRank(modelId);
  }
}

export function loadWorkerBootstrapPolicy(json: unknown): RoutingPolicy {
  assertObject(json, 'Worker bootstrap policy');
  const allowed = new Set(['version', 'status', 'capability_rank', 'roles', 'rules']);
  assertNoUnknownFields(json, allowed, 'worker bootstrap');

  if (typeof json.version !== 'number') {
    throw new Error('Worker bootstrap version must be a number');
  }
  if (json.status !== 'bootstrap-until-eval-derived') {
    throw new Error('Worker bootstrap status must be bootstrap-until-eval-derived');
  }
  if (!json.capability_rank || typeof json.capability_rank !== 'object' || Array.isArray(json.capability_rank)) {
    throw new Error('Worker bootstrap capability_rank must be an object');
  }
  if (!json.roles || typeof json.roles !== 'object' || Array.isArray(json.roles)) {
    throw new Error('Worker bootstrap roles must be an object');
  }
  if (!json.rules || typeof json.rules !== 'object' || Array.isArray(json.rules)) {
    throw new Error('Worker bootstrap rules must be an object');
  }

  return new BootstrapWorkerPolicy(json as BootstrapWorkerPolicyShape);
}

export function loadOrchestratorBootstrapPolicy(json: unknown): RoutingPolicy {
  assertObject(json, 'Orchestrator bootstrap policy');
  const allowed = new Set(['version', 'status', 'actor', 'roles', 'rules']);
  assertNoUnknownFields(json, allowed, 'orchestrator bootstrap');

  if (typeof json.version !== 'number') {
    throw new Error('Orchestrator bootstrap version must be a number');
  }
  if (json.status !== 'bootstrap-until-eval-derived') {
    throw new Error('Orchestrator bootstrap status must be bootstrap-until-eval-derived');
  }
  if (!json.roles || typeof json.roles !== 'object' || Array.isArray(json.roles)) {
    throw new Error('Orchestrator bootstrap roles must be an object');
  }
  if (!json.rules || typeof json.rules !== 'object' || Array.isArray(json.rules)) {
    throw new Error('Orchestrator bootstrap rules must be an object');
  }

  return new BootstrapOrchestratorPolicy(json as BootstrapOrchestratorPolicyShape);
}

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SOURCE_DIR, '..', '..', '..');

function readTrustedFixture(path: string): unknown {
  const text = readFileSync(path, 'utf8');
  return JSON.parse(text);
}

export function loadWorkerBootstrapPolicyFromSource(): RoutingPolicy {
  const path = join(REPO_ROOT, 'packages/worker-harness/config/model-routing.bootstrap.json');
  return loadWorkerBootstrapPolicy(readTrustedFixture(path));
}

export function loadOrchestratorBootstrapPolicyFromSource(): RoutingPolicy {
  const path = join(REPO_ROOT, 'packages/orchestrator-harness/config/model-routing.bootstrap.json');
  return loadOrchestratorBootstrapPolicy(readTrustedFixture(path));
}

class EvalDerivedPolicy implements RoutingPolicy {
  readonly version: number;
  readonly status: string;
  readonly actor: string;
  private readonly source: string;
  private readonly roles: ReadonlyMap<string, { readonly primary: ApprovedModelId; readonly fallback: readonly ApprovedModelId[] }>;
  private readonly rules: Readonly<Record<string, unknown>>;
  private readonly capabilityRank?: Readonly<Record<ApprovedModelId, number>>;

  constructor(
    version: number,
    status: string,
    actor: string,
    source: string,
    roles: ReadonlyMap<string, { readonly primary: ApprovedModelId; readonly fallback: readonly ApprovedModelId[] }>,
    rules: Readonly<Record<string, unknown>>,
    capabilityRank?: Readonly<Record<ApprovedModelId, number>>,
  ) {
    this.version = version;
    this.status = status;
    this.actor = actor;
    this.source = source;
    this.roles = roles;
    this.rules = rules;
    this.capabilityRank = capabilityRank;
  }

  getRoleConfig(role: string): { readonly primary: ModelId; readonly fallback: readonly ModelId[] } | undefined {
    return this.roles.get(role);
  }

  hasRule(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.rules, name);
  }

  getRule(name: string): unknown {
    return (this.rules as Record<string, unknown>)[name];
  }

  getCapabilityRank(modelId: ModelId): number {
    if (this.capabilityRank) {
      return this.capabilityRank[modelId];
    }
    return getCapabilityRank(modelId);
  }
}

function parseEvalRoleMap(
  roles: unknown,
  allowedRoles: ReadonlySet<string>,
): ReadonlyMap<string, { readonly primary: ApprovedModelId; readonly fallback: readonly ApprovedModelId[] }> {
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) {
    throw new Error('Publication roles must be an object');
  }
  const roleMap = new Map<string, { primary: ApprovedModelId; fallback: readonly ApprovedModelId[] }>();
  for (const role of Object.keys(roles)) {
    if (!allowedRoles.has(role)) {
      throw new Error(`Role ${role} is not allowed for this actor`);
    }
    const config = (roles as Record<string, unknown>)[role];
    const validated = assertValidRoleConfig(role, config);
    roleMap.set(role, { primary: validated.primary, fallback: Object.freeze([...validated.fallback]) });
  }
  return roleMap;
}

function parseEvalCapabilityRank(rank: unknown): Readonly<Record<ApprovedModelId, number>> {
  if (!rank || typeof rank !== 'object' || Array.isArray(rank)) {
    throw new Error('Publication capability_rank must be an object');
  }
  validateCapabilityRank(rank as Record<string, unknown>);
  return Object.freeze({ ...(rank as Record<ApprovedModelId, number>) });
}

function parseEvalRules(
  rules: unknown,
  allowedRules: ReadonlySet<string>,
  mandatoryTrue?: ReadonlySet<string>,
): Readonly<Record<string, unknown>> {
  if (rules === undefined) {
    if (mandatoryTrue && mandatoryTrue.size > 0) {
      throw new Error('Publication rules are missing mandatory invariants');
    }
    return Object.freeze({});
  }
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) {
    throw new Error('Publication rules must be an object');
  }
  assertNoUnknownFields(rules, allowedRules, 'rules');
  const record = rules as Record<string, unknown>;
  for (const name of allowedRules) {
    if (Object.prototype.hasOwnProperty.call(record, name) && typeof record[name] !== 'boolean') {
      throw new Error(`Rule ${name} must be a boolean`);
    }
  }
  if (mandatoryTrue) {
    for (const name of mandatoryTrue) {
      if (record[name] !== true) {
        throw new Error(`Rule ${name} must be true`);
      }
    }
  }
  return Object.freeze({ ...record });
}

function assertEvalPublicationEnvelope(
  json: unknown,
  allowedActor: string,
  allowedFields: Set<string>,
): { version: number; status: string; actor: string; source: string } {
  assertObject(json, 'Eval-derived publication');

  const pub = json as Record<string, unknown>;
  if (pub.actor !== allowedActor) {
    throw new Error(`Publication actor must be ${allowedActor}`);
  }
  assertNoUnknownFields(json, allowedFields, 'eval-derived publication');

  if (typeof pub.version !== 'number' || pub.version < 1) {
    throw new Error('Publication version must be a positive integer');
  }
  if (pub.status !== 'eval-derived') {
    throw new Error('Publication status must be eval-derived');
  }
  if (typeof pub.source !== 'string' || pub.source.length === 0) {
    throw new Error('Publication source metadata must be a non-empty string');
  }
  return { version: pub.version, status: pub.status, actor: pub.actor as string, source: pub.source };
}

export function loadWorkerEvalPublication(json: unknown): RoutingPolicy {
  const envelope = assertEvalPublicationEnvelope(
    json,
    'pool-worker',
    new Set(['version', 'status', 'actor', 'source', 'capability_rank', 'roles', 'rules']),
  );
  const pub = json as Record<string, unknown>;
  const capabilityRank = parseEvalCapabilityRank(pub.capability_rank);
  const roles = parseEvalRoleMap(pub.roles, WORKER_ROLES);
  const rules = parseEvalRules(pub.rules, WORKER_RULES, new Set([
    'builderEvaluatorMustDiffer',
    'evaluatorMustNotBeLowerCapability',
  ]));
  return new EvalDerivedPolicy(
    envelope.version,
    envelope.status,
    envelope.actor,
    envelope.source,
    roles,
    rules,
    capabilityRank,
  );
}

export function loadOrchestratorEvalPublication(json: unknown): RoutingPolicy {
  const envelope = assertEvalPublicationEnvelope(
    json,
    'orchestrator-control-plane',
    new Set(['version', 'status', 'actor', 'source', 'roles', 'rules']),
  );
  const pub = json as Record<string, unknown>;
  const roles = parseEvalRoleMap(pub.roles, ORCHESTRATOR_ROLES);
  const rules = parseEvalRules(pub.rules, ORCHESTRATOR_RULES);
  return new EvalDerivedPolicy(
    envelope.version,
    envelope.status,
    envelope.actor,
    envelope.source,
    roles,
    rules,
  );
}

export { APPROVED_MODELS, CANONICAL_CAPABILITY_ORDER, CAPABILITY_RANK, getCapabilityRank } from './approved-models.ts';
