import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
export const launchScript = join(packageRoot, "scripts/launch.mjs");

export function baseChildEnv(overrides = {}) {
  const env = {};
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith("PI_") && !key.startsWith("AGENT_POOL_MOCK_") && key !== "AGENT_POOL_TEST_MODE" && key !== "AGENT_POOL_TEST_RECORD_PATH") env[key] = process.env[key];
  }
  return { ...env, ...overrides };
}

export function withEnv(t, overrides) {
  const original = new Map(Object.keys(overrides).map((key) => [key, { own: Object.hasOwn(process.env, key), value: process.env[key] }]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, prior] of original) {
      if (prior.own) process.env[key] = prior.value;
      else delete process.env[key];
    }
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

export function defaultHelper(version = "0.81.1") {
  return `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('pi ${version}'); process.exit(0); }
if (args[0] === '--list-models') { console.log('moonshot kimi-k3'); console.log('openai-codex gpt-5.6-sol'); process.exit(0); }
process.exit(0);
`;
}

export function createFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "agent-pool-orch-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }));
  let sequence = 0;
  const makeDir = (name) => {
    const path = join(root, `${name}-${sequence++}`);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
  };
  const writeLauncher = ({ version = "0.81.1", marker = "", helper = defaultHelper(version) } = {}) => {
    const dir = makeDir("launcher");
    writeFileSync(join(dir, "pi"), launcherWrapper(version, marker), { mode: 0o755 });
    writeFileSync(join(dir, "pi-helper.js"), helper, { mode: 0o755 });
    return dir;
  };
  const writeJob = (job, workspace = makeDir("workspace")) => {
    const path = join(workspace, "job.json");
    writeFileSync(path, job, "utf8");
    return { workspace, path };
  };
  return { root, makeDir, writeLauncher, writeJob, baseChildEnv };
}

export function runLaunch(fixture, { envOverrides = {}, helper, job, marker } = {}) {
  const launcherDir = fixture.writeLauncher({ helper, marker });
  const workspace = fixture.makeDir("workspace");
  const base = baseChildEnv();
  const env = {
    ...base,
    AGENT_POOL_ACTOR: "orchestrator-control-plane",
    AGENT_POOL_HARNESS: "orchestrator-control-plane",
    AGENT_POOL_LAUNCHER: join(launcherDir, "pi"),
    AGENT_POOL_WORKSPACE: workspace,
    PATH: `${launcherDir}${base.PATH ? `:${base.PATH}` : ""}`,
    ...envOverrides,
  };
  if (job !== undefined) {
    const { path } = fixture.writeJob(job, workspace);
    env.AGENT_POOL_JOB_PATH = path;
  }
  return { result: spawnSync(process.execPath, [launchScript], { encoding: "utf8", env }), workspace, launcherDir };
}

export function createPreflightContext(fixture, { helper, marker, envOverrides = {}, workspace = fixture.makeDir("workspace") } = {}) {
  const launcherDir = fixture.writeLauncher({ helper, marker });
  const runtime = fixture.makeDir("runtime");
  const home = join(runtime, "home");
  const xdg = join(runtime, "xdg");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(xdg, { recursive: true, mode: 0o700 });
  const env = {
    ...baseChildEnv(), AGENT_POOL_ACTOR: "orchestrator-control-plane", AGENT_POOL_HARNESS: "orchestrator-control-plane",
    AGENT_POOL_LAUNCHER: join(launcherDir, "pi"), AGENT_POOL_WORKSPACE: workspace,
    AGENT_POOL_RUNTIME_PARENT: runtime, AGENT_POOL_HOME: home, AGENT_POOL_XDG_CONFIG_HOME: xdg, ...envOverrides,
  };
  return { launcherDir, workspace, runtime, home, xdg, env };
}
