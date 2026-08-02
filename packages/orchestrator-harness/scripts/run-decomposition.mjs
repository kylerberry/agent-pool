#!/usr/bin/env node
/**
 * Deterministic decomposition entry point for the orchestrator harness.
 *
 * Reads a validated decomposition job from AGENT_POOL_JOB_PATH, invokes
 * runDecomposition with a Pi-backed model invoker and bounded breadth
 * retrieval, and emits the candidate DAG or typed failure as JSON.
 *
 * No controller, queue, persistence, Gate 1, dispatch, or Pool Worker harness
 * concepts appear here. No production mock/test controls are recognized.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPiModelInvoker } from "./pi-model-invoker.mjs";
import { trustedInterpreter, trustedPath } from "./trusted-spawn.mjs";
import { verifyPiIdentity } from "./pi-identity.mjs";

const packageRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

function readRuntimeVersions() {
  try {
    return JSON.parse(readFileSync(join(packageRoot, "config/runtime-versions.json"), "utf8"));
  } catch (error) {
    throw new Error(`failed to read runtime versions: ${error instanceof Error ? error.message : "unknown"}`);
  }
}

/**
 * Load the runDecomposition harness from the canonical work-intake domain.
 * The orchestrator harness does not duplicate deterministic decomposition logic.
 */
const { runDecomposition } = await import(
  join(packageRoot, "..", "..", "src", "domains", "work-intake", "decomposition-harness.ts")
);
const { loadOrchestratorBootstrapPolicyFromSource } = await import(
  join(packageRoot, "..", "..", "src", "domains", "model-routing-and-evaluation", "bootstrap-policy.ts")
);
const { breadthRetrieval } = await import(
  join(packageRoot, "..", "..", "src", "domains", "codebase-knowledge", "breadth-retrieval.ts")
);

function fail(message) {
  console.error(`orchestrator-harness run-decomposition failed: ${message}`);
  process.exit(1);
}

const launcherPath = process.env.AGENT_POOL_LAUNCHER;
if (!launcherPath || !resolve(launcherPath).startsWith("/")) {
  fail("AGENT_POOL_LAUNCHER must be an absolute path");
}

const workspace = process.env.AGENT_POOL_WORKSPACE;
if (!workspace || !resolve(workspace).startsWith("/")) {
  fail("AGENT_POOL_WORKSPACE must be an absolute path");
}

const runtimeParent = process.env.AGENT_POOL_RUNTIME_PARENT;
if (!runtimeParent || !resolve(runtimeParent).startsWith("/")) {
  fail("AGENT_POOL_RUNTIME_PARENT must be an absolute path");
}

const jobPath = process.env.AGENT_POOL_JOB_PATH;
if (!jobPath) {
  fail("AGENT_POOL_JOB_PATH is required");
}

let job;
try {
  job = JSON.parse(readFileSync(jobPath, "utf8"));
} catch (error) {
  fail(`failed to read job: ${error instanceof Error ? error.message : "unknown error"}`);
}

function parseAvailabilityFromPi(stdout) {
  return stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2)
    .map((parts) => ({ fullId: `${parts[0]}/${parts[1]}` }));
}

const runtime = readRuntimeVersions();
const expectedDigest = String(runtime.launcherDigest ?? "").replace(/^sha256:/, "");

let piExecutable;
try {
  piExecutable = verifyPiIdentity(launcherPath, trustedInterpreter(), expectedDigest);
} catch (error) {
  fail(error instanceof Error ? error.message : "Pi identity verification failed");
}

// Registry/model spawns use the already-pinned identity. No re-baselining.
const listModels = spawnSync(trustedInterpreter(), [piExecutable.path, "--list-models"], {
  env: { PATH: trustedPath() },
  encoding: "utf8",
});
if (listModels.status !== 0) {
  fail("Pi model registry is unavailable");
}
const availability = parseAvailabilityFromPi(listModels.stdout);

const cacheRoot = process.env.AGENT_POOL_CACHE_ROOT || join(runtimeParent, "cache");
const breadthRetriever = {
  retrieve: async (revision, limits, signal) => {
    return await breadthRetrieval({ root: cacheRoot }, revision, limits);
  },
};

const modelInvoker = createPiModelInvoker(piExecutable, runtimeParent);

const records = [];
const result = await runDecomposition({
  job,
  availability,
  breadthRetriever,
  modelInvoker,
  piExecutable: {
    path: piExecutable.path,
    version: piExecutable.version,
    digest: piExecutable.digest,
  },
  onRecord: (record) => records.push(record),
});

console.log(JSON.stringify(result, null, 2));

if (result && typeof result === "object" && "code" in result) {
  process.exitCode = 1;
}
