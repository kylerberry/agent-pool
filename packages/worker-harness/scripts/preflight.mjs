#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = resolve(process.env.AGENT_POOL_WORKSPACE || process.cwd());
const markerPath = resolve(
  process.env.AGENT_POOL_EXECUTION_CONTEXT || join(workspace, ".agent-pool/execution-context.json"),
);
const skipExternal = process.env.AGENT_POOL_SKIP_EXTERNAL_CHECKS === "1";

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

const marker = readJson(markerPath, "execution-context marker");
const markerKeys = [
  "schema_version", "actor", "node_id", "attempt_id", "issued_by", "issued_at",
  "target_repo", "target_branch",
];
if (Object.keys(marker).sort().join("|") !== [...markerKeys].sort().join("|")) {
  fail("execution-context marker has missing or unknown fields");
}
if (marker.schema_version !== 1 || marker.actor !== "pool-worker") fail("execution-context role/version mismatch");
if (marker.issued_by !== "agent-pool-supervisor") fail("execution-context issuer is invalid");
if (marker.node_id !== expectedNodeId || marker.attempt_id !== expectedAttemptId) {
  fail("execution-context identity does not match launcher expectations");
}
if (marker.target_repo !== expectedRepo || marker.target_branch !== expectedBranch) {
  fail("execution-context target does not match launcher expectations");
}
for (const key of ["node_id", "attempt_id", "issued_at", "target_repo", "target_branch"]) {
  if (typeof marker[key] !== "string" || marker[key].trim() === "") fail(`execution-context ${key} is required`);
}
const utcTimestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;
const timestampParts = utcTimestamp.exec(marker.issued_at);
if (!timestampParts) fail("execution-context issued_at is not a canonical UTC RFC 3339 timestamp");
const [, year, month, day, hour, minute, second] = timestampParts.map(Number);
const timestamp = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
if (
  timestamp.getUTCFullYear() !== year || timestamp.getUTCMonth() !== month - 1 ||
  timestamp.getUTCDate() !== day || timestamp.getUTCHours() !== hour ||
  timestamp.getUTCMinutes() !== minute || timestamp.getUTCSeconds() !== second
) {
  fail("execution-context issued_at contains an invalid calendar date");
}
const markerAgeMs = Date.now() - Date.parse(marker.issued_at);
if (markerAgeMs < -30_000 || markerAgeMs > 300_000) {
  fail("execution-context marker is stale or issued too far in the future");
}

const requiredFiles = [
  "AGENTS.md",
  "skills/craft-pool/SKILL.md",
  "agents/craft-planner.md",
  "agents/craft-builder.md",
  "agents/craft-evaluator.md",
  "agents/craft-security.md",
  "agents/craft-sharpener.md",
  "contracts/crafts-phase-artifact.schema.json",
  "contracts/pool-worker-execution-context.schema.json",
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

if (!skipExternal) {
  const piModels = spawnSync("pi", ["--list-models"], { encoding: "utf8" });
  if (piModels.status !== 0) fail("Pi model registry is unavailable");
  const live = new Set(
    piModels.stdout.split("\n").map((line) => line.trim().split(/\s+/)).filter((parts) => parts.length >= 2)
      .map((parts) => `${parts[0]}/${parts[1]}`),
  );
  const missingModels = allowed.filter((model) => !live.has(model));
  if (missingModels.length) fail(`configured models unavailable: ${missingModels.join(", ")}`);

  const graphify = spawnSync("graphify", ["--version"], { encoding: "utf8" });
  if (graphify.status !== 0 || !graphify.stdout.includes(runtime.graphify)) fail("pinned Graphify executable is unavailable");
  const skillCandidates = [
    process.env.AGENT_POOL_GRAPHIFY_SKILL_PATH,
    join(workspace, ".pi/skills/graphify/SKILL.md"),
    join(homedir(), ".pi/agent/skills/graphify/SKILL.md"),
  ].filter(Boolean);
  if (!skillCandidates.some(existsSync)) fail("Graphify skill is unavailable");
}

console.log(`worker-harness preflight passed: node=${marker.node_id} attempt=${marker.attempt_id}`);
