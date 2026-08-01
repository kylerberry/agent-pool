#!/usr/bin/env node
/**
 * Pool Worker launch preflight.
 *
 * Runs before any paid model call and fails closed. It is the trust boundary
 * between an untrusted host/launcher environment and the attempt: nothing below
 * assumes a field, file, model, tool, or schema is well-formed until it has been
 * checked here (packages/worker-harness/AGENTS.md, ADR-032).
 */
import { readFileSync, existsSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { validateInstance, checkSchemaIntegrity, findDagTopology } from "../lib/json-schema-subset.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = resolve(process.env.AGENT_POOL_WORKSPACE || process.cwd());
const markerPath = resolve(
  process.env.AGENT_POOL_EXECUTION_CONTEXT || join(workspace, ".agent-pool/execution-context.json"),
);
const skipExternal = process.env.AGENT_POOL_SKIP_EXTERNAL_CHECKS === "1";

/** Absolute ceiling from the orchestrator specification; a launcher may be stricter, never laxer. */
const FRESHNESS_CEILING_SECONDS = 300;
/** Tolerance for launcher/worker clock skew on a not-yet-valid marker. */
const CLOCK_SKEW_TOLERANCE_MS = 30_000;

function fail(message) {
  console.error(`worker-harness preflight failed: ${message}`);
  process.exit(1);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`${label} is missing or invalid JSON`);
  }
}

/** Load a bundled contract schema and prove the schema itself is intact before using it. */
function loadContractSchema(name) {
  const path = join(packageRoot, "contracts", name);
  if (!existsSync(path)) fail(`contract schema missing: ${name}`);
  const schema = readJson(path, `contract schema ${name}`);
  const integrityErrors = checkSchemaIntegrity(schema);
  if (integrityErrors.length) fail(`contract schema ${name} failed integrity check: ${integrityErrors[0]}`);
  return schema;
}

// ---------------------------------------------------------------------------
// Actor identity and launcher expectations
// ---------------------------------------------------------------------------

if (process.env.AGENT_POOL_ACTOR !== "pool-worker") {
  fail("AGENT_POOL_ACTOR must equal pool-worker");
}
const expectedNodeId = process.env.AGENT_POOL_NODE_ID;
const expectedAttemptId = process.env.AGENT_POOL_ATTEMPT_ID;
const expectedRepo = process.env.AGENT_POOL_TARGET_REPO;
const expectedBranch = process.env.AGENT_POOL_TARGET_BRANCH;
if (!expectedNodeId || !expectedAttemptId || !expectedRepo || !expectedBranch) {
  fail("launcher must provide expected node, attempt, repository, and branch values");
}
if (!existsSync(markerPath)) fail("execution-context marker is missing");

// ---------------------------------------------------------------------------
// Execution context: schema-validated, identity-bound, workspace-bound, fresh
// ---------------------------------------------------------------------------

const executionContextSchema = loadContractSchema("pool-worker-execution-context.schema.json");
const attemptContractSchema = loadContractSchema("pool-worker-attempt-contract.schema.json");
loadContractSchema("crafts-phase-artifact.schema.json");

const marker = readJson(markerPath, "execution-context marker");
// Bound string length before any pattern matching. The path and timestamp
// patterns use lookaheads whose cost grows with input size, and nothing upstream
// caps how large a field a hostile marker file can contain.
const MAX_MARKER_FIELD_LENGTH = 4096;
for (const [key, value] of Object.entries(marker ?? {})) {
  if (typeof value === "string" && value.length > MAX_MARKER_FIELD_LENGTH) {
    fail(`execution-context ${key} exceeds the maximum field length`);
  }
}
const markerErrors = validateInstance(executionContextSchema, marker);
if (markerErrors.length) {
  // An unknown or absent field is the same class of failure as a wrong one:
  // the marker is not the contract the worker was built to trust.
  fail(`execution-context marker has missing or unknown fields: ${markerErrors[0]}`);
}
if (marker.node_id !== expectedNodeId || marker.attempt_id !== expectedAttemptId) {
  fail("execution-context identity does not match launcher expectations");
}
if (marker.target_repo !== expectedRepo || marker.target_branch !== expectedBranch) {
  fail("execution-context target does not match launcher expectations");
}

/** Parse a schema-validated canonical UTC timestamp, rejecting impossible calendar dates. */
function parseUtcTimestamp(value, label) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);
  if (!parts) fail(`execution-context ${label} is not a canonical UTC RFC 3339 timestamp`);
  const [, year, month, day, hour, minute, second] = parts.map(Number);
  const timestamp = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    timestamp.getUTCFullYear() !== year || timestamp.getUTCMonth() !== month - 1 ||
    timestamp.getUTCDate() !== day || timestamp.getUTCHours() !== hour ||
    timestamp.getUTCMinutes() !== minute || timestamp.getUTCSeconds() !== second
  ) {
    fail(`execution-context ${label} contains an invalid calendar date`);
  }
  return Date.parse(value);
}

const issuedAtMs = parseUtcTimestamp(marker.issued_at, "issued_at");
const expiresAtMs = parseUtcTimestamp(marker.expires_at, "expires_at");
const now = Date.now();

if (expiresAtMs <= issuedAtMs) fail("execution-context expires_at must be after issued_at");
if (expiresAtMs - issuedAtMs > marker.max_age_seconds * 1000) {
  fail("execution-context expires_at exceeds its own max_age_seconds budget");
}
if (marker.max_age_seconds > FRESHNESS_CEILING_SECONDS) {
  fail("execution-context max_age_seconds exceeds the five-minute specification ceiling");
}
if (issuedAtMs - now > CLOCK_SKEW_TOLERANCE_MS) {
  fail("execution-context marker is stale or issued too far in the future");
}
if (now >= expiresAtMs || now - issuedAtMs > marker.max_age_seconds * 1000) {
  fail("execution-context marker is stale or issued too far in the future");
}

const topologyInMarker = findDagTopology(marker, "execution-context");
if (topologyInMarker) fail(`execution context must not carry DAG topology: ${topologyInMarker}`);

// `attempt_nonce` is validated for shape here, not for reuse. A worker process
// serves one attempt and holds no cross-launch state, so replay detection is
// supervisor-owned; the domain-side validator consumes the nonce against a store
// the controller provides. Treating a format check as replay protection would be
// a false assurance, so the boundary is stated rather than implied.

// ---------------------------------------------------------------------------
// Workspace binding and freshness
// ---------------------------------------------------------------------------

/**
 * The marker names the workspace it authorises. Resolving both sides through
 * realpath stops a symlinked or re-pointed workspace from inheriting a context
 * that was issued for a different directory.
 */
if (!existsSync(workspace)) fail("attempt workspace does not exist");
const workspaceReal = realpathSync(workspace);
if (!existsSync(marker.workspace_path)) fail("execution-context workspace_path does not exist");
if (realpathSync(marker.workspace_path) !== workspaceReal) {
  fail("execution-context workspace does not match the launcher workspace");
}
if (!lstatSync(workspaceReal).isDirectory()) fail("attempt workspace is not a directory");

/**
 * Attempt state is per-attempt by construction. Residue from an earlier attempt
 * in the control directory means the workspace was reused, which breaks the
 * ADR-032 one-ephemeral-workspace-per-attempt guarantee.
 */
const controlDir = join(workspaceReal, ".agent-pool");
if (!existsSync(controlDir)) fail("attempt workspace has no .agent-pool control directory");
// A symlinked control directory would let the launch inputs be served from
// outside the workspace the context authorises.
const controlDirInfo = lstatSync(controlDir);
if (controlDirInfo.isSymbolicLink() || !controlDirInfo.isDirectory()) {
  fail(".agent-pool control directory must be a real directory in the workspace");
}
const ALLOWED_CONTROL_ENTRIES = new Set(["execution-context.json", "attempt-contract.json"]);
const controlEntries = readdirSync(controlDir);
for (const entry of controlEntries) {
  if (!ALLOWED_CONTROL_ENTRIES.has(entry)) {
    fail(`attempt workspace is not fresh: unexpected control-directory entry ${entry}`);
  }
}

// ---------------------------------------------------------------------------
// Exactly one attempt contract, carrying no DAG topology
// ---------------------------------------------------------------------------

const attemptContractPath = join(controlDir, "attempt-contract.json");
if (!existsSync(attemptContractPath)) fail("attempt contract is missing");
const attemptContract = readJson(attemptContractPath, "attempt contract");
const contractErrors = validateInstance(attemptContractSchema, attemptContract);
if (contractErrors.length) fail(`attempt contract is invalid: ${contractErrors[0]}`);
if (attemptContract.node_id !== expectedNodeId || attemptContract.attempt_id !== expectedAttemptId) {
  fail("attempt contract identity does not match launcher expectations");
}
if (attemptContract.target_repo !== expectedRepo || attemptContract.target_branch !== expectedBranch) {
  fail("attempt contract target does not match launcher expectations");
}
const topologyInContract = findDagTopology(attemptContract, "attempt-contract");
if (topologyInContract) fail(`attempt contract must not carry DAG topology: ${topologyInContract}`);

// ---------------------------------------------------------------------------
// Package integrity
// ---------------------------------------------------------------------------

const requiredFiles = [
  "AGENTS.md",
  "skills/craft-pool/SKILL.md",
  "agents/craft-planner.md",
  "agents/craft-builder.md",
  "agents/craft-evaluator.md",
  "agents/craft-security.md",
  "agents/craft-sharpener.md",
  "lib/json-schema-subset.mjs",
  "contracts/crafts-phase-artifact.schema.json",
  "contracts/pool-worker-execution-context.schema.json",
  "contracts/pool-worker-attempt-contract.schema.json",
  "config/settings.json",
  "config/model-routing.bootstrap.json",
  "config/runtime-versions.json",
];
for (const path of requiredFiles) {
  if (!existsSync(join(packageRoot, path))) fail(`required package file missing: ${path}`);
}

const settings = readJson(join(packageRoot, "config/settings.json"), "worker settings");
const routing = readJson(join(packageRoot, "config/model-routing.bootstrap.json"), "model routing");
const runtime = readJson(join(packageRoot, "config/runtime-versions.json"), "runtime versions");
const allowed = settings?.subagents?.modelScope?.allow;
if (settings?.subagents?.modelScope?.enforce !== true || !Array.isArray(allowed) || allowed.length === 0) {
  fail("model scope must be enforced and non-empty");
}
if (runtime.actor !== "pool-worker") fail("runtime baseline actor is not pool-worker");
if (JSON.stringify(allowed) !== JSON.stringify(runtime.allowedModels)) fail("settings/runtime model scopes differ");

for (const [role, config] of Object.entries(routing.roles || {})) {
  if (!allowed.includes(config.primary)) fail(`${role} primary model is outside scope`);
  for (const fallback of config.fallback || []) {
    if (!allowed.includes(fallback)) fail(`${role} fallback model is outside scope`);
  }
}
const workerRoles = ["node_conductor", "planning", "building", "assessing", "tightening", "sharpening", "failure_diagnosis"];
for (const role of workerRoles) {
  if (!routing.roles?.[role]) fail(`required worker routing role missing: ${role}`);
}
if (routing.roles?.decomposition) fail("decomposition routing must not be owned by the Pool Worker harness");
const builder = routing.roles?.building?.primary;
const evaluator = routing.roles?.assessing?.primary;
if (!builder || !evaluator || builder === evaluator) fail("builder/evaluator models must differ");
if ((routing.capability_rank?.[evaluator] || 0) < (routing.capability_rank?.[builder] || 0)) {
  fail("evaluator capability rank is lower than builder");
}

const agentChecks = {
  "craft-builder.md": ["bash", "edit", "write", "acceptanceRole: writer"],
  "craft-evaluator.md": ["acceptanceRole: read-only"],
  "craft-security.md": ["acceptanceRole: read-only"],
  "craft-sharpener.md": ["edit", "write", "acceptanceRole: writer", "never modify application code"],
};
for (const [file, fragments] of Object.entries(agentChecks)) {
  const text = readFileSync(join(packageRoot, "agents", file), "utf8");
  for (const fragment of fragments) {
    if (!text.includes(fragment)) fail(`${file} is missing required capability rule: ${fragment}`);
  }
}

// ---------------------------------------------------------------------------
// External tool and model availability
// ---------------------------------------------------------------------------

if (!skipExternal) {
  const piModels = spawnSync("pi", ["--list-models"], { encoding: "utf8" });
  if (piModels.status !== 0) fail("Pi model registry is unavailable");
  const live = new Set(
    piModels.stdout.split("\n").map((line) => line.trim().split(/\s+/)).filter((parts) => parts.length >= 2)
      .map((parts) => `${parts[0]}/${parts[1]}`),
  );
  const missingModels = allowed.filter((model) => !live.has(model));
  if (missingModels.length) fail(`configured models unavailable: ${missingModels.join(", ")}`);

  const graphifyPath = (() => {
    const which = spawnSync("which", ["graphify"], { encoding: "utf8" });
    if (which.status !== 0) fail("Graphify executable not found in PATH");
    const resolved = which.stdout.trim().split("\n")[0];
    if (!resolved || !isAbsolute(resolved)) fail("Graphify path is not absolute");
    return resolved;
  })();
  const graphify = spawnSync(graphifyPath, ["--version"], {
    encoding: "utf8",
    env: { LANG: "C", LC_ALL: "C", PATH: process.env.PATH },
  });
  if (graphify.status !== 0) fail("Graphify executable failed");
  const versionMatch = /^graphify\s+v?(\d+\.\d+\.\d+)$/m.exec(graphify.stdout.trim());
  if (!versionMatch || versionMatch[1] !== runtime.graphify) {
    fail(`pinned Graphify version mismatch: expected ${runtime.graphify}, got ${versionMatch?.[1] ?? "unknown"}`);
  }
  const skillCandidates = [
    process.env.AGENT_POOL_GRAPHIFY_SKILL_PATH,
    join(workspace, ".pi/skills/graphify/SKILL.md"),
    join(homedir(), ".pi/agent/skills/graphify/SKILL.md"),
  ].filter(Boolean);
  const skillPath = skillCandidates.find(existsSync);
  if (!skillPath) fail("Graphify skill is unavailable");
  const skillText = readFileSync(skillPath, "utf8");
  if (!skillText.includes(`graphify ${runtime.graphify}`)) {
    fail(`Graphify skill provenance does not match pinned version ${runtime.graphify}`);
  }
  if (!skillText.includes("graphifyy")) {
    fail("Graphify skill does not reference the graphifyy Python distribution");
  }
}

console.log(`worker-harness preflight passed: node=${marker.node_id} attempt=${marker.attempt_id}`);
