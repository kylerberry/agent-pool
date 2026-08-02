import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const script = join(packageRoot, "scripts/preflight.mjs");

function launcherWrapper(version, marker = "") {
  const markerLine = marker ? `\n// ${marker}` : "";
  return `#!/usr/bin/env node${markerLine}
const helper = require('path').join(__dirname, 'pi-helper.js');
if (require('fs').existsSync(helper)) {
  require('child_process').execFileSync(process.execPath, [helper, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(0);
}
if (process.argv[2] === '--version') { console.log('pi ${version}'); process.exit(0); }
process.exit(0);
`;
}

function defaultHelper(version = "0.81.1") {
  return `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('pi ${version}'); process.exit(0); }
if (args[0] === '--list-models') { console.log('moonshot kimi-k3'); console.log('openai-codex gpt-5.6-sol'); process.exit(0); }
process.exit(0);
`;
}

function fakeLauncherDir({ version = "0.81.1", marker = "", helper = defaultHelper(version) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agent-pool-orch-bin-"));
  writeFileSync(join(dir, "pi"), launcherWrapper(version, marker), { mode: 0o755 });
  writeFileSync(join(dir, "pi-helper.js"), helper, { mode: 0o755 });
  return dir;
}

function baseEnv() {
  const env = {};
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith("PI_")) {
      env[key] = process.env[key];
    }
  }
  return env;
}

function createRuntimeParent() {
  const parent = mkdtempSync(join(tmpdir(), "agent-pool-orch-runtime-"));
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const home = join(parent, "home");
  const xdg = join(parent, "xdg");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(xdg, { recursive: true, mode: 0o700 });
  return { parent, home, xdg };
}

function run(envOverrides = {}) {
  const launcherDir = fakeLauncherDir();
  const workspace = mkdtempSync(join(tmpdir(), "agent-pool-orch-sec-"));
  mkdirSync(join(workspace, ".pi"), { recursive: true });
  mkdirSync(join(workspace, ".agent-pool"), { recursive: true });
  const { parent, home, xdg } = createRuntimeParent();
  const env = {
    ...baseEnv(),
    AGENT_POOL_ACTOR: "orchestrator-control-plane",
    AGENT_POOL_HARNESS: "orchestrator-control-plane",
    AGENT_POOL_LAUNCHER: join(launcherDir, "pi"),
    AGENT_POOL_WORKSPACE: workspace,
    AGENT_POOL_RUNTIME_PARENT: parent,
    AGENT_POOL_HOME: home,
    AGENT_POOL_XDG_CONFIG_HOME: xdg,
    ...envOverrides,
  };
  return spawnSync(process.execPath, [script], { encoding: "utf8", env });
}

test("preflight rejects ambient repository .pi config", () => {
  const result = run({ AGENT_POOL_USE_AMBIENT_CONFIG: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ambient config|explicit/);
});

test("preflight rejects inherited PI environment variables", () => {
  const result = run({ PI_CONFIG_HOME: "/tmp/pi-config" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PI_|ambient/);
});

test("preflight rejects global plugin directory", () => {
  const result = run({ AGENT_POOL_PLUGINS: "/usr/share/pi/plugins" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /plugin/);
});

test("preflight rejects non-absolute HOME or XDG paths", () => {
  const result = run({ AGENT_POOL_HOME: "relative/home", AGENT_POOL_XDG_CONFIG_HOME: "relative/xdg" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /absolute/);
});

test("preflight ensures isolated HOME and XDG roots exist under runtime parent", () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-pool-orch-iso-"));
  const { parent, home, xdg } = createRuntimeParent();
  const launcherDir = fakeLauncherDir();
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...baseEnv(),
      AGENT_POOL_ACTOR: "orchestrator-control-plane",
      AGENT_POOL_HARNESS: "orchestrator-control-plane",
      AGENT_POOL_LAUNCHER: join(launcherDir, "pi"),
      AGENT_POOL_WORKSPACE: workspace,
      AGENT_POOL_RUNTIME_PARENT: parent,
      AGENT_POOL_HOME: home,
      AGENT_POOL_XDG_CONFIG_HOME: xdg,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(home));
  assert.ok(existsSync(xdg));
});

test("preflight verifies orchestrator actor in runtime-versions", () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const runtime = JSON.parse(readFileSync(join(packageRoot, "config/runtime-versions.json"), "utf8"));
  assert.equal(runtime.actor, "orchestrator-control-plane");
});

test("preflight rejects worker-harness marker presence", () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-pool-orch-worker-"));
  mkdirSync(join(workspace, ".agent-pool"), { recursive: true });
  const { parent, home, xdg } = createRuntimeParent();
  writeFileSync(
    join(workspace, ".agent-pool/execution-context.json"),
    JSON.stringify({ actor: "pool-worker" }),
  );
  const launcherDir = fakeLauncherDir();
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...baseEnv(),
      AGENT_POOL_ACTOR: "orchestrator-control-plane",
      AGENT_POOL_HARNESS: "orchestrator-control-plane",
      AGENT_POOL_LAUNCHER: join(launcherDir, "pi"),
      AGENT_POOL_WORKSPACE: workspace,
      AGENT_POOL_RUNTIME_PARENT: parent,
      AGENT_POOL_HOME: home,
      AGENT_POOL_XDG_CONFIG_HOME: xdg,
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pool-worker|worker-harness/);
});

test("preflight rejects production availability skip", () => {
  const result = run({ AGENT_POOL_SKIP_EXTERNAL_CHECKS: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AGENT_POOL_SKIP_EXTERNAL_CHECKS|not allowed/);
});

test("preflight rejects missing runtime parent", () => {
  const launcherDir = fakeLauncherDir();
  const workspace = mkdtempSync(join(tmpdir(), "agent-pool-orch-noparent-"));
  const home = join(workspace, ".agent-pool", "orchestrator-home");
  const xdg = join(workspace, ".agent-pool", "orchestrator-xdg");
  mkdirSync(home, { recursive: true });
  mkdirSync(xdg, { recursive: true });
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...baseEnv(),
      AGENT_POOL_ACTOR: "orchestrator-control-plane",
      AGENT_POOL_HARNESS: "orchestrator-control-plane",
      AGENT_POOL_LAUNCHER: join(launcherDir, "pi"),
      AGENT_POOL_WORKSPACE: workspace,
      AGENT_POOL_HOME: home,
      AGENT_POOL_XDG_CONFIG_HOME: xdg,
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AGENT_POOL_RUNTIME_PARENT/);
});
