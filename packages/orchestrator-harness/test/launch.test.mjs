import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync as nativeMkdtempSync, mkdirSync, writeFileSync, existsSync , rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ownedTempRoots = new Set();
function mkdtempSync(prefix) {
  const path = nativeMkdtempSync(prefix);
  ownedTempRoots.add(path);
  return path;
}
after(() => {
  for (const path of ownedTempRoots) rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
});

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const launchScript = join(packageRoot, "scripts/launch.mjs");

const VALID_INDEX_REVISION = {
  repository: { owner: "owner", name: "repo" },
  head: "a".repeat(40),
  graphifyVersion: "0.9.25",
  indexSchemaVersion: "1",
  sensitivePathPolicyVersion: "1",
  manifestDigest: "sha256:manifest",
  indexRevision: "rev-1",
  createdAt: new Date().toISOString(),
};

function validJob() {
  return JSON.stringify({
    jobId: "job-1",
    spec: {
      intent: "Add user authentication",
      acceptanceCriteria: ["Users can log in"],
    },
    rawSpec: "Implement a login endpoint.",
    targetRepository: { owner: "owner", name: "repo" },
    head: "a".repeat(40),
    indexRevision: VALID_INDEX_REVISION,
  });
}

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
  const dir = mkdtempSync(join(tmpdir(), "agent-pool-orch-launch-bin-"));
  writeFileSync(join(dir, "pi"), launcherWrapper(version, marker), { mode: 0o755 });
  writeFileSync(join(dir, "pi-helper.js"), helper, { mode: 0o755 });
  return dir;
}

function baseEnv() {
  const env = {};
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith("PI_") && !key.startsWith("AGENT_POOL_MOCK_") && key !== "AGENT_POOL_TEST_MODE" && key !== "AGENT_POOL_TEST_RECORD_PATH") {
      env[key] = process.env[key];
    }
  }
  return env;
}

function runLaunch(envOverrides = {}, { helper, job } = {}) {
  const launcherDir = fakeLauncherDir({ helper });
  const workspace = mkdtempSync(join(tmpdir(), "agent-pool-orch-launch-"));
  const env = {
    ...baseEnv(),
    AGENT_POOL_ACTOR: "orchestrator-control-plane",
    AGENT_POOL_HARNESS: "orchestrator-control-plane",
    AGENT_POOL_LAUNCHER: join(launcherDir, "pi"),
    AGENT_POOL_WORKSPACE: workspace,
    PATH: `${launcherDir}${baseEnv().PATH ? `:${baseEnv().PATH}` : ""}`,
    ...envOverrides,
  };
  if (job !== undefined) {
    const jobPath = join(workspace, "job.json");
    writeFileSync(jobPath, job, "utf8");
    env.AGENT_POOL_JOB_PATH = jobPath;
  }
  return { result: spawnSync(process.execPath, [launchScript], { encoding: "utf8", env }), workspace, launcherDir };
}

test("launch runs preflight and spawns run-decomposition", () => {
  const { result } = runLaunch({}, { job: validJob() });
  assert.match(result.stdout, /preflight passed/);
});

test("launch fails before spawning when launcher digest is wrong", () => {
  const launcherDir = fakeLauncherDir({ marker: "wrong-digest-marker" });
  const workspace = mkdtempSync(join(tmpdir(), "agent-pool-orch-launch-digest-"));
  const env = {
    ...baseEnv(),
    AGENT_POOL_ACTOR: "orchestrator-control-plane",
    AGENT_POOL_HARNESS: "orchestrator-control-plane",
    AGENT_POOL_LAUNCHER: join(launcherDir, "pi"),
    AGENT_POOL_WORKSPACE: workspace,
    PATH: `${launcherDir}${baseEnv().PATH ? `:${baseEnv().PATH}` : ""}`,
  };
  const result = spawnSync(process.execPath, [launchScript], { encoding: "utf8", env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /digest mismatch|preflight failed/);
});

test("launch rejects caller-controlled HOME", () => {
  const { result } = runLaunch({
    AGENT_POOL_HOME: join(tmpdir(), "hostile-home"),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AGENT_POOL_HOME|caller-controlled/);
});

test("launch rejects caller-controlled XDG_CONFIG_HOME", () => {
  const { result } = runLaunch({
    AGENT_POOL_XDG_CONFIG_HOME: join(tmpdir(), "hostile-xdg"),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AGENT_POOL_XDG_CONFIG_HOME|caller-controlled/);
});

test("launch rejects production availability skip", () => {
  const { result } = runLaunch({
    AGENT_POOL_SKIP_EXTERNAL_CHECKS: "1",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AGENT_POOL_SKIP_EXTERNAL_CHECKS|not allowed/);
});

test("launch rejects reserved test/mock environment variables", () => {
  const { result } = runLaunch({
    AGENT_POOL_TEST_MODE: "1",
    AGENT_POOL_MOCK_AVAILABILITY: JSON.stringify([{ fullId: "moonshot/kimi-k3" }]),
    AGENT_POOL_MOCK_MODEL_RESPONSES: JSON.stringify(["[]"]),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reserved|AGENT_POOL_TEST_MODE|not allowed/);
});

test("launch creates a fresh private runtime parent independent of workspace", () => {
  const { result, workspace } = runLaunch({}, { job: validJob() });
  assert.match(result.stdout, /preflight passed/);
  assert.ok(!existsSync(join(workspace, ".agent-pool", "orchestrator-home")), "workspace-derived HOME must not be created");
  assert.ok(!existsSync(join(workspace, ".agent-pool", "orchestrator-xdg")), "workspace-derived XDG must not be created");
});

test("launch cleans the runtime subtree after preflight passes", () => {
  const { result, workspace } = runLaunch({}, { job: validJob() });
  assert.match(result.stdout, /preflight passed/);
  assert.ok(!existsSync(join(workspace, ".agent-pool")), "workspace subtree leaked");
});

test("hostile PATH cannot control the interpreter used for Pi", () => {
  const hostileDir = mkdtempSync(join(tmpdir(), "agent-pool-hostile-"));
  const marker = join(hostileDir, "marker");
  writeFileSync(join(hostileDir, "node"), `#!/usr/bin/env node\nrequire('fs').writeFileSync('${marker}', '');\n`, { mode: 0o755 });
  writeFileSync(join(hostileDir, "pi"), `#!/usr/bin/env node\nrequire('fs').writeFileSync('${marker}', '');\n`, { mode: 0o755 });
  const launcherDir = fakeLauncherDir();
  const workspace = mkdtempSync(join(tmpdir(), "agent-pool-orch-path-"));
  const jobPath = join(workspace, "job.json");
  writeFileSync(jobPath, validJob(), "utf8");
  const env = {
    ...baseEnv(),
    AGENT_POOL_ACTOR: "orchestrator-control-plane",
    AGENT_POOL_HARNESS: "orchestrator-control-plane",
    AGENT_POOL_LAUNCHER: join(launcherDir, "pi"),
    AGENT_POOL_WORKSPACE: workspace,
    AGENT_POOL_JOB_PATH: jobPath,
    PATH: `${hostileDir}`,
  };
  const result = spawnSync(process.execPath, [launchScript], { encoding: "utf8", env });
  assert.match(result.stdout, /preflight passed/);
  assert.ok(!existsSync(marker), "hostile PATH shim executed");
});

test("Sol fallback is allowed when Kimi K3 is unavailable", () => {
  const helper = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('pi 0.81.1'); process.exit(0); }
if (args[0] === '--list-models') { console.log('openai-codex gpt-5.6-sol'); process.exit(0); }
process.exit(0);
`;
  const { result } = runLaunch({}, { helper, job: validJob() });
  assert.match(result.stdout, /preflight passed/);
});
