/**
 * Work Intake — deterministic limit policy for decomposition.
 *
 * One immutable, versioned policy loaded from the orchestrator-harness package.
 * All byte, token, node, field, diagnostic, repair-context, call, and deadline
 * limits live here and are enforced before provider invocation where possible.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface DecompositionLimits {
  readonly version: number;
  readonly maxSerializedJobBytes: number;
  readonly maxRawSpecBytes: number;
  readonly maxBreadthUnits: number;
  readonly maxBreadthEdges: number;
  readonly maxPromptBytes: number;
  readonly maxOutputTokens: number;
  readonly maxResponseBytes: number;
  readonly maxNodes: number;
  readonly maxNodeIdLength: number;
  readonly maxNodeStringLength: number;
  readonly maxNodeCollectionLength: number;
  readonly maxDiagnostics: number;
  readonly maxRepairContextBytes: number;
  readonly maxCalls: number;
  readonly deadlineMs: number;
}

const DEFAULT_LIMITS: DecompositionLimits = Object.freeze({
  version: 1,
  maxSerializedJobBytes: 262_144,
  maxRawSpecBytes: 65_536,
  maxBreadthUnits: 200,
  maxBreadthEdges: 500,
  maxPromptBytes: 524_288,
  maxOutputTokens: 32_768,
  maxResponseBytes: 1_048_576,
  maxNodes: 256,
  maxNodeIdLength: 256,
  maxNodeStringLength: 8_192,
  maxNodeCollectionLength: 256,
  maxDiagnostics: 100,
  maxRepairContextBytes: 16_384,
  maxCalls: 2,
  deadlineMs: 120_000,
});

function assertPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

export function validateLimitPolicy(json: unknown = loadLimitPolicyFromSource()): DecompositionLimits {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("limit policy must be an object");
  }
  const obj = json as Record<string, unknown>;
  const allowed = new Set([
    "version",
    "maxSerializedJobBytes",
    "maxRawSpecBytes",
    "maxBreadthUnits",
    "maxBreadthEdges",
    "maxPromptBytes",
    "maxOutputTokens",
    "maxResponseBytes",
    "maxNodes",
    "maxNodeIdLength",
    "maxNodeStringLength",
    "maxNodeCollectionLength",
    "maxDiagnostics",
    "maxRepairContextBytes",
    "maxCalls",
    "deadlineMs",
  ]);
  const unknown = Object.keys(obj).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    throw new Error(`unknown limit policy fields: ${unknown.join(", ")}`);
  }

  return Object.freeze({
    version: assertPositiveInteger(obj.version, "version"),
    maxSerializedJobBytes: assertPositiveInteger(obj.maxSerializedJobBytes, "maxSerializedJobBytes"),
    maxRawSpecBytes: assertPositiveInteger(obj.maxRawSpecBytes, "maxRawSpecBytes"),
    maxBreadthUnits: assertPositiveInteger(obj.maxBreadthUnits, "maxBreadthUnits"),
    maxBreadthEdges: assertPositiveInteger(obj.maxBreadthEdges, "maxBreadthEdges"),
    maxPromptBytes: assertPositiveInteger(obj.maxPromptBytes, "maxPromptBytes"),
    maxOutputTokens: assertPositiveInteger(obj.maxOutputTokens, "maxOutputTokens"),
    maxResponseBytes: assertPositiveInteger(obj.maxResponseBytes, "maxResponseBytes"),
    maxNodes: assertPositiveInteger(obj.maxNodes, "maxNodes"),
    maxNodeIdLength: assertPositiveInteger(obj.maxNodeIdLength, "maxNodeIdLength"),
    maxNodeStringLength: assertPositiveInteger(obj.maxNodeStringLength, "maxNodeStringLength"),
    maxNodeCollectionLength: assertPositiveInteger(obj.maxNodeCollectionLength, "maxNodeCollectionLength"),
    maxDiagnostics: assertPositiveInteger(obj.maxDiagnostics, "maxDiagnostics"),
    maxRepairContextBytes: assertPositiveInteger(obj.maxRepairContextBytes, "maxRepairContextBytes"),
    maxCalls: assertPositiveInteger(obj.maxCalls, "maxCalls"),
    deadlineMs: assertPositiveInteger(obj.deadlineMs, "deadlineMs"),
  });
}

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SOURCE_DIR, "..", "..", "..");

export function loadLimitPolicyFromSource(): unknown {
  const path = join(REPO_ROOT, "packages/orchestrator-harness/config/decomposition-limits.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
