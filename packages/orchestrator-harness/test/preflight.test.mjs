import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(packageRoot, "../..");
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

function runWithLauncher(launcherDir, envOverrides = {}) {
  const workspace = mkdtempSync(join(tmpdir(), "agent-pool-orch-"));
  const { parent, home, xdg } = createRuntimeParent();
  const env = {
    ...baseEnv(),
    AGENT_POOL_ACTOR: "orchestrator-control-plane",
    AGENT_POOL_HARNESS: "orchestrator-control-plane",
    AGENT_POOL_WORKSPACE: workspace,
    AGENT_POOL_RUNTIME_PARENT: parent,
    AGENT_POOL_HOME: home,
    AGENT_POOL_XDG_CONFIG_HOME: xdg,
    ...envOverrides,
  };
  if (launcherDir) {
    env.AGENT_POOL_LAUNCHER = join(launcherDir, "pi");
  }
  return spawnSync(process.execPath, [script], { encoding: "utf8", env });
}

test("preflight accepts a valid orchestrator-control-plane launch context", () => {
  const launcherDir = fakeLauncherDir();
  const result = runWithLauncher(launcherDir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /preflight passed/);
});

test("preflight rejects Repository Builder actor", () => {
  const launcherDir = fakeLauncherDir();
  const result = runWithLauncher(launcherDir, { AGENT_POOL_ACTOR: "repository-builder" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AGENT_POOL_ACTOR/);
});

test("preflight rejects pool-worker actor", () => {
  const launcherDir = fakeLauncherDir();
  const result = runWithLauncher(launcherDir, { AGENT_POOL_ACTOR: "pool-worker" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AGENT_POOL_ACTOR/);
});

test("preflight rejects production availability skip", () => {
  const launcherDir = fakeLauncherDir();
  const result = runWithLauncher(launcherDir, { AGENT_POOL_SKIP_EXTERNAL_CHECKS: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AGENT_POOL_SKIP_EXTERNAL_CHECKS|not allowed/);
});

test("preflight rejects HOME outside runtime parent", () => {
  const launcherDir = fakeLauncherDir();
  const result = runWithLauncher(launcherDir, { AGENT_POOL_HOME: join(tmpdir(), "outside-home") });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AGENT_POOL_HOME|runtime parent/);
});

test("preflight rejects XDG_CONFIG_HOME outside runtime parent", () => {
  const launcherDir = fakeLauncherDir();
  const result = runWithLauncher(launcherDir, { AGENT_POOL_XDG_CONFIG_HOME: join(tmpdir(), "outside-xdg") });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AGENT_POOL_XDG_CONFIG_HOME|runtime parent/);
});

test("preflight rejects relative launcher path", () => {
  const result = runWithLauncher(null, { AGENT_POOL_LAUNCHER: "pi" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /absolute/);
});

test("preflight rejects symlinked launcher", () => {
  const launcherDir = fakeLauncherDir();
  const symlinkDir = mkdtempSync(join(tmpdir(), "agent-pool-orch-symlink-"));
  const symlink = join(symlinkDir, "pi");
  symlinkSync(join(launcherDir, "pi"), symlink);
  const result = runWithLauncher(null, { AGENT_POOL_LAUNCHER: symlink });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlink|regular file/);
});

test("preflight rejects wrong launcher version", () => {
  // Keep the wrapper bytes matching the pinned digest and override the
  // version output through the helper so the digest check passes first.
  const launcherDir = fakeLauncherDir({ version: "0.81.1" });
  const helper = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('pi 0.81.2'); process.exit(0); }
if (args[0] === '--list-models') { console.log('moonshot kimi-k3'); console.log('openai-codex gpt-5.6-sol'); process.exit(0); }
process.exit(0);
`;
  writeFileSync(join(launcherDir, "pi-helper.js"), helper, { mode: 0o755 });
  const result = runWithLauncher(launcherDir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /version mismatch/);
});

test("preflight rejects wrong launcher digest", () => {
  const launcherDir = fakeLauncherDir({ marker: "wrong-digest-marker" });
  const result = runWithLauncher(launcherDir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /digest mismatch/);
});

test("preflight computes digest from launcher bytes, not self-reported --digest", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-pool-orch-digest-attack-"));
  const launcher = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('pi 0.81.1'); process.exit(0); }
if (args[0] === '--digest') { console.log('sha256:eaaaf167d5b8c965564cccf734add94999b84a2f6f2c5c4be99b390ad86e7ea9'); process.exit(0); }
process.exit(0);
`;
  writeFileSync(join(dir, "pi"), launcher, { mode: 0o755 });
  const result = runWithLauncher(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /digest mismatch/);
});

test("preflight ignores hostile PATH when absolute launcher is given", () => {
  const launcherDir = fakeLauncherDir();
  const hostileDir = mkdtempSync(join(tmpdir(), "agent-pool-hostile-"));
  writeFileSync(join(hostileDir, "pi"), `#!/usr/bin/env node\nconsole.log('pi 99.99.99');\n`, { mode: 0o755 });
  const result = runWithLauncher(launcherDir, { PATH: `${hostileDir}:${process.env.PATH || ""}` });
  assert.equal(result.status, 0, result.stderr);
});

test("required package files exist", () => {
  const required = [
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
  for (const path of required) {
    assert.ok(existsSync(join(packageRoot, path)), `missing ${path}`);
  }
});

test("settings model scope matches bootstrap routing", () => {
  const settings = JSON.parse(readFileSync(join(packageRoot, "config/settings.json"), "utf8"));
  const routing = JSON.parse(readFileSync(join(packageRoot, "config/model-routing.bootstrap.json"), "utf8"));
  const allowed = new Set(settings.subagents.modelScope.allow);
  assert.equal(settings.subagents.modelScope.enforce, true);
  for (const roleConfig of Object.values(routing.roles)) {
    assert.ok(allowed.has(roleConfig.primary), `${roleConfig.primary} not in settings scope`);
    for (const fallback of roleConfig.fallback) {
      assert.ok(allowed.has(fallback), `${fallback} not in settings scope`);
    }
  }
});

test("preflight allows Sol-only availability as approved fallback", () => {
  const helper = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('pi 0.81.1'); process.exit(0); }
if (args[0] === '--list-models') { console.log('openai-codex gpt-5.6-sol'); process.exit(0); }
process.exit(0);
`;
  const launcherDir = fakeLauncherDir({ helper });
  const result = runWithLauncher(launcherDir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /preflight passed/);
});

test("preflight fails when no approved candidate is available", () => {
  const helper = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('pi 0.81.1'); process.exit(0); }
if (args[0] === '--list-models') { console.log('some-provider other-model'); process.exit(0); }
process.exit(0);
`;
  const launcherDir = fakeLauncherDir({ helper });
  const result = runWithLauncher(launcherDir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no approved decomposition candidate/);
});
