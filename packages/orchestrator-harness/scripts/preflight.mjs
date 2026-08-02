#!/usr/bin/env node
import { readFileSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { trustedInterpreter, trustedPath } from "./trusted-spawn.mjs";
import { verifyPiIdentity } from "./pi-identity.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`orchestrator-harness preflight failed: ${message}`);
  process.exit(1);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`${label} is missing or invalid JSON`);
  }
}

if (process.env.AGENT_POOL_ACTOR !== "orchestrator-control-plane") {
  fail("AGENT_POOL_ACTOR must equal orchestrator-control-plane");
}
if (process.env.AGENT_POOL_HARNESS !== "orchestrator-control-plane") {
  fail("AGENT_POOL_HARNESS must equal orchestrator-control-plane");
}
if (process.env.AGENT_POOL_SKIP_EXTERNAL_CHECKS === "1") {
  fail("AGENT_POOL_SKIP_EXTERNAL_CHECKS is not allowed");
}

// Reject ambient Pi configuration, plugins, and inherited environment variables.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_")) {
    fail(`inherited Pi environment variable must not be present: ${key}`);
  }
}
if (process.env.AGENT_POOL_USE_AMBIENT_CONFIG === "1") {
  fail("ambient configuration is disabled; use package-owned explicit settings");
}
if (process.env.AGENT_POOL_PLUGINS) {
  fail("ambient plugin directories are disabled");
}

const workspace = resolve(process.env.AGENT_POOL_WORKSPACE || process.cwd());
if (existsSync(join(workspace, ".agent-pool/execution-context.json"))) {
  const marker = readJson(join(workspace, ".agent-pool/execution-context.json"), "execution-context marker");
  if (marker.actor === "pool-worker") {
    fail("pool-worker execution context must not be present in orchestrator harness");
  }
}

const launcherPath = process.env.AGENT_POOL_LAUNCHER;
if (!launcherPath || !isAbsolute(launcherPath)) {
  fail("AGENT_POOL_LAUNCHER must be an absolute path");
}

const runtimeParent = process.env.AGENT_POOL_RUNTIME_PARENT;
if (!runtimeParent || !isAbsolute(runtimeParent)) {
  fail("AGENT_POOL_RUNTIME_PARENT must be an absolute path");
}
if (!existsSync(runtimeParent)) {
  fail("AGENT_POOL_RUNTIME_PARENT does not exist");
}
const runtimeStat = lstatSync(runtimeParent);
if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) {
  fail("AGENT_POOL_RUNTIME_PARENT must be a regular directory");
}
const realRuntimeParent = realpathSync(runtimeParent);
const realRuntimeStat = lstatSync(realRuntimeParent);
if (!realRuntimeStat.isDirectory() || realRuntimeStat.isSymbolicLink()) {
  fail("AGENT_POOL_RUNTIME_PARENT must be a regular directory");
}

const home = process.env.AGENT_POOL_HOME;
const xdg = process.env.AGENT_POOL_XDG_CONFIG_HOME;
if (!home || !isAbsolute(home)) fail("AGENT_POOL_HOME must be an absolute path");
if (!xdg || !isAbsolute(xdg)) fail("AGENT_POOL_XDG_CONFIG_HOME must be an absolute path");
if (!existsSync(home)) fail("AGENT_POOL_HOME does not exist");
if (!existsSync(xdg)) fail("AGENT_POOL_XDG_CONFIG_HOME does not exist");
const realHome = realpathSync(home);
const realXdg = realpathSync(xdg);
for (const [label, path] of [["AGENT_POOL_HOME", realHome], ["AGENT_POOL_XDG_CONFIG_HOME", realXdg]]) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`${label} must be a regular directory`);
  }
}
const parentPrefix = realRuntimeParent.endsWith("/") ? realRuntimeParent : `${realRuntimeParent}/`;
if (realHome !== realRuntimeParent && !realHome.startsWith(parentPrefix)) {
  fail("AGENT_POOL_HOME must be under runtime parent");
}
if (realXdg !== realRuntimeParent && !realXdg.startsWith(parentPrefix)) {
  fail("AGENT_POOL_XDG_CONFIG_HOME must be under runtime parent");
}

const runtime = readJson(join(packageRoot, "config/runtime-versions.json"), "runtime versions");
if (runtime.actor !== "orchestrator-control-plane") {
  fail("runtime baseline actor is not orchestrator-control-plane");
}

const expectedDigest = String(runtime.launcherDigest ?? "").replace(/^sha256:/, "");

let piIdentity;
try {
  piIdentity = verifyPiIdentity(launcherPath, trustedInterpreter(), expectedDigest);
} catch (error) {
  fail(error instanceof Error ? error.message : "Pi identity verification failed");
}

// Defense-in-depth: the digest was already verified before execution.
if (piIdentity.digest !== `sha256:${expectedDigest}`) {
  fail(`launcher digest mismatch: expected sha256:${expectedDigest}, got ${piIdentity.digest}`);
}

const requiredFiles = [
  "AGENTS.md",
  "agents/spec-decomposer.md",
  "skills/decompose-spec/SKILL.md",
  "contracts/decomposition-job.schema.json",
  "contracts/decomposition-emission.schema.json",
  "config/model-routing.bootstrap.json",
  "config/decomposition-limits.json",
  "config/sanitization-policy.json",
  "config/settings.json",
  "config/runtime-versions.json",
  "scripts/launch.mjs",
  "scripts/preflight.mjs",
];
for (const path of requiredFiles) {
  if (!existsSync(join(packageRoot, path))) fail(`required package file missing: ${path}`);
}

const settings = readJson(join(packageRoot, "config/settings.json"), "orchestrator settings");
const routing = readJson(join(packageRoot, "config/model-routing.bootstrap.json"), "model routing");
if (settings.subagents.modelScope.enforce !== true) {
  fail("model scope must be enforced");
}
const allowed = settings.subagents.modelScope.allow;
if (!Array.isArray(allowed) || allowed.length === 0) {
  fail("model scope allowlist must be non-empty");
}
if (JSON.stringify(allowed) !== JSON.stringify(runtime.allowedModels)) {
  fail("settings/runtime model scopes differ");
}

for (const [role, config] of Object.entries(routing.roles || {})) {
  if (!allowed.includes(config.primary)) fail(`${role} primary model is outside scope`);
  for (const fallback of config.fallback || []) {
    if (!allowed.includes(fallback)) fail(`${role} fallback model is outside scope`);
  }
}
if (!routing.roles?.decomposition) fail("decomposition routing is required");
for (const role of Object.keys(routing.roles || {})) {
  if (role !== "decomposition") fail(`orchestrator harness contains disallowed role: ${role}`);
}

const agentText = readFileSync(join(packageRoot, "agents/spec-decomposer.md"), "utf8");
for (const fragment of ["structured output", "read-only", "contracts/decomposition-emission.schema.json"]) {
  if (!agentText.includes(fragment)) fail(`spec-decomposer.md missing ${fragment}`);
}

// Registry availability: at least one approved decomposition candidate must be
// reachable. We do not require every allowed model, so the approved Sol
// fallback can operate when Kimi K3 is unavailable.
const piModels = spawnSync(trustedInterpreter(), [launcherPath, "--list-models"], {
  encoding: "utf8",
  env: { PATH: trustedPath() },
});
if (piModels.status !== 0) fail("Pi model registry is unavailable");
const live = new Set(
  piModels.stdout.split("\n").map((line) => line.trim().split(/\s+/)).filter((parts) => parts.length >= 2)
    .map((parts) => `${parts[0]}/${parts[1]}`),
);
const decompositionRole = routing.roles.decomposition;
const decompositionCandidates = [decompositionRole.primary, ...decompositionRole.fallback];
const availableCandidates = decompositionCandidates.filter((model) => live.has(model));
if (availableCandidates.length === 0) {
  fail("no approved decomposition candidate is available");
}

console.log(`orchestrator-harness preflight passed: actor=orchestrator-control-plane package=${packageRoot}`);
