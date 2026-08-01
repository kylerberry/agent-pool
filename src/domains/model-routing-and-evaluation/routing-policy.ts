/**
 * Versioned routing-policy interface implemented by bootstrap and future
 * eval-derived publications. The router depends only on this contract.
 */

import { APPROVED_MODELS, isApprovedModelId, type ApprovedModelId, type ModelId } from './approved-models.ts';
import type { RoleConfig } from './contracts.ts';

export type RoutingPolicy = {
  readonly version: number;
  readonly status: string;
  readonly actor: string;
  readonly getRoleConfig: (role: string) => { readonly primary: ModelId; readonly fallback: readonly ModelId[] } | undefined;
  readonly hasRule: (name: string) => boolean;
  readonly getRule: (name: string) => unknown;
  readonly getCapabilityRank: (modelId: ModelId) => number;
};

export type RoutingPolicyPublication = {
  readonly version: number;
  readonly status: string;
  readonly actor: string;
  readonly source: string;
  readonly roles: Readonly<Record<string, RoleConfig>>;
  readonly rules?: Readonly<Record<string, unknown>>;
};

/**
 * Assert that a candidate value is a safe positive integer.
 * Rejects non-numbers, non-integral numbers, NaN, Infinity, zero, negatives,
 * and values outside the safe integer range.
 */
export function assertPositiveIntegerVersion(value: unknown, label = 'version'): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

/**
 * Validate a candidate publication against the canonical approved-model scope
 * and actor-specific role ownership. Returns a typed failure if the
 * publication would expand the approved scope, cross actor roles, or carry
 * malformed metadata.
 */
export function validateRoutingPolicyPublication(
  candidate: unknown,
  allowedActor: string,
  allowedRoles: ReadonlySet<string>,
): RoutingPolicyPublication {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('Publication must be an object');
  }
  const pub = candidate as Record<string, unknown>;

  assertPositiveIntegerVersion(pub.version, 'Publication version');
  if (pub.status !== 'eval-derived') {
    throw new Error('Publication status must be eval-derived');
  }
  if (typeof pub.actor !== 'string' || pub.actor !== allowedActor) {
    throw new Error(`Publication actor must be ${allowedActor}`);
  }
  if (typeof pub.source !== 'string' || pub.source.length === 0) {
    throw new Error('Publication source metadata must be a non-empty string');
  }

  const seenRoles = new Set<string>();
  const roles = pub.roles;
  if (!roles || typeof roles !== 'object') {
    throw new Error('Publication roles must be an object');
  }

  for (const role of Object.keys(roles as object)) {
    if (!allowedRoles.has(role)) {
      throw new Error(`Role ${role} is not allowed for actor ${allowedActor}`);
    }
    if (seenRoles.has(role)) {
      throw new Error(`Duplicate role ${role} in publication`);
    }
    seenRoles.add(role);

    const config = (roles as Record<string, unknown>)[role];
    if (!config || typeof config !== 'object') {
      throw new Error(`Role ${role} config must be an object`);
    }
    assertNoUnknownRoleFields(config);
    const cfg = config as Record<string, unknown>;
    if (typeof cfg.primary !== 'string' || !isApprovedModelId(cfg.primary)) {
      throw new Error(`Role ${role} primary is not an approved model`);
    }
    if (!Array.isArray(cfg.fallback)) {
      throw new Error(`Role ${role} fallback must be an array`);
    }
    const seenModels = new Set<ApprovedModelId>([cfg.primary]);
    for (const id of cfg.fallback) {
      if (typeof id !== 'string' || !isApprovedModelId(id)) {
        throw new Error(`Role ${role} contains a non-approved model ID`);
      }
      if (seenModels.has(id)) {
        throw new Error(`Role ${role} contains duplicate candidate ${id}`);
      }
      seenModels.add(id);
    }
  }

  const unknownFields = new Set(Object.keys(pub));
  for (const field of ['version', 'status', 'actor', 'source', 'roles', 'rules']) {
    unknownFields.delete(field);
  }
  if (unknownFields.size > 0) {
    throw new Error(`Unknown publication fields: ${[...unknownFields].join(', ')}`);
  }

  return candidate as RoutingPolicyPublication;
}

function assertNoUnknownRoleFields(config: object): void {
  const allowed = new Set(['primary', 'fallback']);
  const unknown = Object.keys(config).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    throw new Error(`Unknown role config fields: ${unknown.join(', ')}`);
  }
}
