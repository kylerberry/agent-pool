#!/usr/bin/env node
/**
 * Orchestrator harness launch wrapper.
 *
 * Validates isolation, runs the package preflight, then invokes the
 * deterministic runDecomposition harness through a Pi-backed model-invoker
 * adapter. The untrusted job never reaches spec-decomposer directly.
 *
 * The launcher creates a fresh, launcher-owned private runtime parent,
 * rejects all production-reachable mock/test controls, and cleans the whole
 * subtree on every controlled outcome.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRuntimeParent, cleanupRuntimeParent } from "./runtime-parent.mjs";
import { trustedInterpreter, trustedPath } from "./trusted-spawn.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`orchestrator-harness launch failed: ${message}`);
  process.exit(1);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`${label} is missing or invalid JSON`);
  }
}

const launcherPath = process.env.AGENT_POOL_LAUNCHER;
if (!launcherPath || !isAbsolute(launcherPath) || !existsSync(launcherPath)) {
  fail("AGENT_POOL_LAUNCHER must be an absolute path to an existing launcher");
}

const workspace = resolve(process.env.AGENT_POOL_WORKSPACE || process.cwd());
if (!isAbsolute(workspace)) {
  fail("AGENT_POOL_WORKSPACE must be an absolute path");
}

// Reject caller-controlled configuration roots and production availability skip.
if (process.env.AGENT_POOL_HOME) {
  fail("AGENT_POOL_HOME is caller-controlled and not allowed");
}
if (process.env.AGENT_POOL_XDG_CONFIG_HOME) {
  fail("AGENT_POOL_XDG_CONFIG_HOME is caller-controlled and not allowed");
}
if (process.env.AGENT_POOL_SKIP_EXTERNAL_CHECKS) {
  fail("AGENT_POOL_SKIP_EXTERNAL_CHECKS is not allowed");
}

// Reject production-reachable mock/test controls. Tests must inject fakes
// through test-local in-process constructors, never through environment
// variables that a caller can set.
const reservedKeys = Object.keys(process.env).filter(
  (k) => k === "AGENT_POOL_TEST_MODE" || k.startsWith("AGENT_POOL_MOCK_") || k === "AGENT_POOL_TEST_RECORD_PATH",
);
if (reservedKeys.length > 0) {
  fail(`reserved test/mock environment variables are not allowed in production: ${reservedKeys.join(", ")}`);
}

let runtime;
try {
  runtime = createRuntimeParent();
} catch (error) {
  fail(`failed to create runtime parent: ${error instanceof Error ? error.message : "unknown"}`);
}

const home = runtime.home;
const xdg = runtime.xdg;

const settingsPath = join(packageRoot, "config/settings.json");
const agentPath = join(packageRoot, "agents");
const skillPath = join(packageRoot, "skills");

// Minimal allowlist for the child environment. PATH is fixed independently of
// caller PATH; HOME and XDG are derived only from the launcher-owned parent.
const allowlist = new Set([
  "LANG",
  "LC_ALL",
  "AGENT_POOL_ACTOR",
  "AGENT_POOL_HARNESS",
  "AGENT_POOL_LAUNCHER",
  "AGENT_POOL_WORKSPACE",
  "AGENT_POOL_JOB_PATH",
]);

const env = {};
for (const key of Object.keys(process.env)) {
  if (allowlist.has(key)) {
    env[key] = process.env[key];
  }
}
env.AGENT_POOL_ACTOR = "orchestrator-control-plane";
env.AGENT_POOL_HARNESS = "orchestrator-control-plane";
env.AGENT_POOL_HOME = home;
env.AGENT_POOL_XDG_CONFIG_HOME = xdg;
env.AGENT_POOL_RUNTIME_PARENT = runtime.path;
env.HOME = home;
env.XDG_CONFIG_HOME = xdg;
env.PATH = trustedPath();

// Package-owned paths consumed by run-decomposition.mjs.
env.AGENT_POOL_PACKAGE_ROOT = packageRoot;
env.AGENT_POOL_SETTINGS_PATH = settingsPath;
env.AGENT_POOL_AGENT_DIR = agentPath;
env.AGENT_POOL_SKILL_DIR = skillPath;

let cleaned = false;
function cleanupOnce() {
  if (cleaned) return;
  cleaned = true;
  cleanupRuntimeParent(runtime.path);
}

function cleanupAndExit(code) {
  cleanupOnce();
  process.exit(code);
}

let activeChild = null;

function runPreflightAsync() {
  return new Promise((resolve, reject) => {
    activeChild = spawn(trustedInterpreter(), [join(packageRoot, "scripts/preflight.mjs")], {
      env,
      stdio: "inherit",
    });
    activeChild.on("exit", (code) => {
      activeChild = null;
      resolve(code ?? 1);
    });
    activeChild.on("error", (error) => {
      activeChild = null;
      reject(error);
    });
  });
}

function runDecompositionAsync() {
  activeChild = spawn(trustedInterpreter(), [
    "--experimental-strip-types",
    join(packageRoot, "scripts/run-decomposition.mjs"),
  ], {
    env,
    stdio: "inherit",
  });
  activeChild.on("exit", (code) => {
    activeChild = null;
    cleanupAndExit(code ?? 1);
  });
  activeChild.on("error", (error) => {
    activeChild = null;
    console.error(`orchestrator-harness launch failed: child error: ${error.message}`);
    cleanupAndExit(1);
  });
}

process.on("SIGINT", () => {
  if (activeChild) activeChild.kill("SIGINT");
  cleanupAndExit(130);
});

process.on("SIGTERM", () => {
  if (activeChild) activeChild.kill("SIGTERM");
  cleanupAndExit(143);
});

try {
  const preflightCode = await runPreflightAsync();
  if (preflightCode !== 0) {
    cleanupAndExit(preflightCode);
  }
} catch (error) {
  console.error(`orchestrator-harness launch failed: preflight error: ${error instanceof Error ? error.message : "unknown"}`);
  cleanupAndExit(1);
}

runDecompositionAsync();
