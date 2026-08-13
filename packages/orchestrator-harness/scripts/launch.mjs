#!/usr/bin/env node
/**
 * Orchestrator harness launch wrapper. The exported constructor is deliberately
 * in-process only: production callers still use this file as a CLI entry point.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRuntimeParent, cleanupRuntimeParent } from "./runtime-parent.mjs";
import { trustedInterpreter, trustedPath } from "./trusted-spawn.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allowlist = new Set([
  "LANG", "LC_ALL", "AGENT_POOL_ACTOR", "AGENT_POOL_HARNESS", "AGENT_POOL_LAUNCHER",
  "AGENT_POOL_WORKSPACE", "AGENT_POOL_JOB_PATH",
]);

function launchError(message) {
  console.error(`orchestrator-harness launch failed: ${message}`);
}

function childEnvironment(source, runtime) {
  const env = {};
  for (const key of Object.keys(source)) if (allowlist.has(key)) env[key] = source[key];
  Object.assign(env, {
    AGENT_POOL_ACTOR: "orchestrator-control-plane",
    AGENT_POOL_HARNESS: "orchestrator-control-plane",
    AGENT_POOL_HOME: runtime.home,
    AGENT_POOL_XDG_CONFIG_HOME: runtime.xdg,
    AGENT_POOL_RUNTIME_PARENT: runtime.path,
    HOME: runtime.home,
    XDG_CONFIG_HOME: runtime.xdg,
    PATH: trustedPath(),
    AGENT_POOL_PACKAGE_ROOT: packageRoot,
    AGENT_POOL_SETTINGS_PATH: join(packageRoot, "config/settings.json"),
    AGENT_POOL_AGENT_DIR: join(packageRoot, "agents"),
    AGENT_POOL_SKILL_DIR: join(packageRoot, "skills"),
  });
  return env;
}

function validateEnvironment(env) {
  const launcherPath = env.AGENT_POOL_LAUNCHER;
  if (!launcherPath || !isAbsolute(launcherPath) || !existsSync(launcherPath)) {
    return "AGENT_POOL_LAUNCHER must be an absolute path to an existing launcher";
  }
  const workspace = resolve(env.AGENT_POOL_WORKSPACE || process.cwd());
  if (!isAbsolute(workspace)) return "AGENT_POOL_WORKSPACE must be an absolute path";
  if (env.AGENT_POOL_HOME) return "AGENT_POOL_HOME is caller-controlled and not allowed";
  if (env.AGENT_POOL_XDG_CONFIG_HOME) return "AGENT_POOL_XDG_CONFIG_HOME is caller-controlled and not allowed";
  if (env.AGENT_POOL_SKIP_EXTERNAL_CHECKS) return "AGENT_POOL_SKIP_EXTERNAL_CHECKS is not allowed";
  const reserved = Object.keys(env).filter((key) => key === "AGENT_POOL_TEST_MODE" || key === "AGENT_POOL_TEST_RECORD_PATH" || key.startsWith("AGENT_POOL_MOCK_"));
  return reserved.length ? `reserved test/mock environment variables are not allowed in production: ${reserved.join(", ")}` : null;
}

/**
 * Starts one launch lifecycle. Dependency injection is an in-process test seam,
 * not a caller-visible environment control. The returned promise settles after
 * exact runtime cleanup and signal handlers are removed.
 */
export function startLaunch({
  env = process.env,
  spawnChild = spawn,
  createRuntimeParent: makeRuntime = createRuntimeParent,
  cleanupRuntimeParent: removeRuntime = cleanupRuntimeParent,
  onExit = (code) => process.exit(code),
  onRuntime = () => {},
  signals = process,
} = {}) {
  const invalid = validateEnvironment(env);
  if (invalid) {
    launchError(invalid);
    onExit(1);
    return Promise.resolve({ code: 1, runtime: null });
  }

  let runtime;
  try {
    runtime = makeRuntime();
  } catch (error) {
    launchError(`failed to create runtime parent: ${error instanceof Error ? error.message : "unknown"}`);
    onExit(1);
    return Promise.resolve({ code: 1, runtime: null });
  }
  onRuntime(runtime);
  const childEnv = childEnvironment(env, runtime);
  let activeChild = null;
  let cleaned = false;
  let settled = false;
  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });

  const cleanupOnce = () => {
    if (!cleaned) {
      cleaned = true;
      removeRuntime(runtime.path);
    }
  };
  const removeSignals = () => {
    signals.removeListener("SIGINT", onSigint);
    signals.removeListener("SIGTERM", onSigterm);
  };
  const finish = (code) => {
    if (settled) return;
    settled = true;
    cleanupOnce();
    removeSignals();
    onExit(code);
    resolveResult({ code, runtime });
  };
  const onSigint = () => {
    if (activeChild) activeChild.kill("SIGINT");
    finish(130);
  };
  const onSigterm = () => {
    if (activeChild) activeChild.kill("SIGTERM");
    finish(143);
  };
  signals.on("SIGINT", onSigint);
  signals.on("SIGTERM", onSigterm);

  const runPreflight = () => new Promise((resolvePreflight, rejectPreflight) => {
    activeChild = spawnChild(trustedInterpreter(), [join(packageRoot, "scripts/preflight.mjs")], { env: childEnv, stdio: "inherit" });
    activeChild.once("exit", (code) => { activeChild = null; resolvePreflight(code ?? 1); });
    activeChild.once("error", (error) => { activeChild = null; rejectPreflight(error); });
  });

  void (async () => {
    try {
      const code = await runPreflight();
      if (code !== 0) return finish(code);
    } catch (error) {
      launchError(`preflight error: ${error instanceof Error ? error.message : "unknown"}`);
      return finish(1);
    }
    activeChild = spawnChild(trustedInterpreter(), ["--experimental-strip-types", join(packageRoot, "scripts/run-decomposition.mjs")], { env: childEnv, stdio: "inherit" });
    activeChild.once("exit", (code) => { activeChild = null; finish(code ?? 1); });
    activeChild.once("error", (error) => {
      activeChild = null;
      launchError(`child error: ${error.message}`);
      finish(1);
    });
  })();
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startLaunch();
}
