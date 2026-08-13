import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync as nativeMkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { withEnv } from "./helpers/fixture.mjs";

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
const runtimeVersionsPath = join(packageRoot, "config/runtime-versions.json");
const pinnedDigest = String(
  JSON.parse(readFileSync(runtimeVersionsPath, "utf8")).launcherDigest ?? "",
).replace(/^sha256:/, "");

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
    spec: { intent: "Add user authentication", acceptanceCriteria: ["Users can log in"] },
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
  const dir = mkdtempSync(join(tmpdir(), "agent-pool-orch-f-bin-"));
  writeFileSync(join(dir, "pi"), launcherWrapper(version, marker), { mode: 0o755 });
  writeFileSync(join(dir, "pi-helper.js"), helper, { mode: 0o755 });
  return dir;
}

function digestOf(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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

function runLaunch(envOverrides = {}, { helper, job, marker } = {}) {
  const launcherDir = fakeLauncherDir({ helper, marker });
  const workspace = mkdtempSync(join(tmpdir(), "agent-pool-orch-f-launch-"));
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

test("Pi digest is checked before --version executes", async () => {
  const { verifyPiIdentity } = await import(join(packageRoot, "scripts/pi-identity.mjs"));
  const launcherDir = fakeLauncherDir({ marker: "wrong-digest" });
  const piPath = join(launcherDir, "pi");
  const marker = join(launcherDir, "version-executed");
  // Replace helper so --version writes a marker if it runs.
  writeFileSync(
    join(launcherDir, "pi-helper.js"),
    `#!/usr/bin/env node\nconst fs = require('fs');\nconst args = process.argv.slice(2);\nif (args[0] === '--version') { fs.writeFileSync('${marker}', ''); console.log('pi 0.81.1'); process.exit(0); }\nif (args[0] === '--list-models') { console.log('moonshot kimi-k3'); console.log('openai-codex gpt-5.6-sol'); process.exit(0); }\nprocess.exit(0);\n`,
    { mode: 0o755 },
  );
  assert.throws(
    () => verifyPiIdentity(piPath, process.execPath, pinnedDigest),
    /digest mismatch/,
  );
  assert.ok(!existsSync(marker), "--version was executed before digest check");
});

test("run-decomposition verifies Pi identity before --list-models", async (t) => {
  const launcherDir = fakeLauncherDir({ marker: "wrong-digest" });
  const piPath = join(launcherDir, "pi");
  const marker = join(launcherDir, "list-models-executed");
  writeFileSync(
    join(launcherDir, "pi-helper.js"),
    `#!/usr/bin/env node\nconst fs = require('fs');\nconst args = process.argv.slice(2);\nif (args[0] === '--version') { console.log('pi 0.81.1'); process.exit(0); }\nif (args[0] === '--list-models') { fs.writeFileSync('${marker}', ''); console.log('moonshot kimi-k3'); process.exit(0); }\nprocess.exit(0);\n`,
    { mode: 0o755 },
  );
  const workspace = mkdtempSync(join(tmpdir(), "agent-pool-orch-f-run-"));
  const { createRuntimeParent, cleanupRuntimeParent } = await import(join(packageRoot, "scripts/runtime-parent.mjs"));
  const { path: runtimeParent, home, xdg } = createRuntimeParent();
  t.after(() => cleanupRuntimeParent(runtimeParent));
  const jobPath = join(workspace, "job.json");
  writeFileSync(jobPath, validJob(), "utf8");
  const env = {
    ...baseEnv(),
    AGENT_POOL_ACTOR: "orchestrator-control-plane",
    AGENT_POOL_HARNESS: "orchestrator-control-plane",
    AGENT_POOL_LAUNCHER: piPath,
    AGENT_POOL_WORKSPACE: workspace,
    AGENT_POOL_JOB_PATH: jobPath,
    AGENT_POOL_RUNTIME_PARENT: runtimeParent,
    AGENT_POOL_HOME: home,
    AGENT_POOL_XDG_CONFIG_HOME: xdg,
    AGENT_POOL_PACKAGE_ROOT: packageRoot,
    AGENT_POOL_SETTINGS_PATH: join(packageRoot, "config/settings.json"),
    AGENT_POOL_AGENT_DIR: join(packageRoot, "agents"),
    AGENT_POOL_SKILL_DIR: join(packageRoot, "skills"),
    PATH: `${launcherDir}${baseEnv().PATH ? `:${baseEnv().PATH}` : ""}`,
  };
  const result = spawnSync(process.execPath, [join(packageRoot, "scripts/run-decomposition.mjs")], { encoding: "utf8", env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /digest mismatch/);
  assert.ok(!existsSync(marker), "--list-models was executed before identity verification");
});

test("runtime parent ignores hostile TMPDIR", async (t) => {
  const hostileDir = mkdtempSync(join(tmpdir(), "agent-pool-hostile-tmp-"));
  const canonicalBase = realpathSync("/tmp");
  withEnv(t, { TMPDIR: hostileDir, TEMP: hostileDir, TMP: hostileDir });
  const { createRuntimeParent, cleanupRuntimeParent } = await import(join(packageRoot, "scripts/runtime-parent.mjs"));
  const runtime = createRuntimeParent();
  t.after(() => cleanupRuntimeParent(runtime.path));
  assert.ok(runtime.path.startsWith(`${canonicalBase}/`), `runtime parent under hostile TMPDIR: ${runtime.path}`);
  assert.ok(!runtime.path.startsWith(hostileDir), `runtime parent leaked to hostile TMPDIR: ${runtime.path}`);
});

test("preflight rejects HOME with lexical prefix collision outside runtime parent", () => {
  const launcherDir = fakeLauncherDir();
  const workspace = mkdtempSync(join(tmpdir(), "agent-pool-orch-f-collision-"));
  const parent = mkdtempSync(join(tmpdir(), "agent-pool-orch-runtime-collision-"));
  // HOME is a sibling path that lexically starts with the parent string.
  const evilRoot = `${parent}-evil`;
  ownedTempRoots.add(evilRoot);
  const evilHome = join(evilRoot, "home");
  mkdirSync(dirname(evilHome), { recursive: true, mode: 0o700 });
  mkdirSync(evilHome, { recursive: true, mode: 0o700 });
  const xdg = join(parent, "xdg");
  mkdirSync(xdg, { recursive: true, mode: 0o700 });
  const env = {
    ...baseEnv(),
    AGENT_POOL_ACTOR: "orchestrator-control-plane",
    AGENT_POOL_HARNESS: "orchestrator-control-plane",
    AGENT_POOL_LAUNCHER: join(launcherDir, "pi"),
    AGENT_POOL_WORKSPACE: workspace,
    AGENT_POOL_RUNTIME_PARENT: parent,
    AGENT_POOL_HOME: evilHome,
    AGENT_POOL_XDG_CONFIG_HOME: xdg,
  };
  const result = spawnSync(process.execPath, [join(packageRoot, "scripts/preflight.mjs")], { encoding: "utf8", env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /runtime parent/);
});

test("preflight rejects symlinked runtime parent", () => {
  const launcherDir = fakeLauncherDir();
  const workspace = mkdtempSync(join(tmpdir(), "agent-pool-orch-f-symlink-parent-"));
  const realParent = mkdtempSync(join(tmpdir(), "agent-pool-real-parent-"));
  const symlinkParent = join(mkdtempSync(join(tmpdir(), "agent-pool-symlink-parent-")), "runtime-parent-link");
  symlinkSync(realParent, symlinkParent);
  const home = join(realParent, "home");
  const xdg = join(realParent, "xdg");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(xdg, { recursive: true, mode: 0o700 });
  const env = {
    ...baseEnv(),
    AGENT_POOL_ACTOR: "orchestrator-control-plane",
    AGENT_POOL_HARNESS: "orchestrator-control-plane",
    AGENT_POOL_LAUNCHER: join(launcherDir, "pi"),
    AGENT_POOL_WORKSPACE: workspace,
    AGENT_POOL_RUNTIME_PARENT: symlinkParent,
    AGENT_POOL_HOME: home,
    AGENT_POOL_XDG_CONFIG_HOME: xdg,
  };
  const result = spawnSync(process.execPath, [join(packageRoot, "scripts/preflight.mjs")], { encoding: "utf8", env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /regular directory|symlink/);
});

test("prompt directory symlink swap is rejected", async () => {
  const { createPiModelInvoker } = await import(join(packageRoot, "scripts/pi-model-invoker.mjs"));
  const launcherDir = fakeLauncherDir();
  const piPath = join(launcherDir, "pi");
  const runtimeParent = mkdtempSync(join(tmpdir(), "agent-pool-orch-f-prompt-"));
  const externalDir = mkdtempSync(join(tmpdir(), "agent-pool-f-prompt-external-"));
  const invoker = createPiModelInvoker(
    { path: piPath, version: "0.81.1", digest: `sha256:${digestOf(piPath)}` },
    runtimeParent,
  );
  // Race: replace the prompts directory with a symlink to an external path.
  const promptDir = join(runtimeParent, "prompts");
  rmSync(promptDir, { recursive: true, force: true });
  symlinkSync(externalDir, promptDir);
  await assert.rejects(
    () => invoker.invoke({ prompt: "test", model: "moonshot/kimi-k3", deadlineMs: 5000, maxOutputTokens: 100 }, new AbortController().signal),
    /contained|symlink|regular directory|not a directory/,
  );
});

test("runtime parent symlink swap is rejected before invoke", async () => {
  const { createPiModelInvoker } = await import(join(packageRoot, "scripts/pi-model-invoker.mjs"));
  const launcherDir = fakeLauncherDir();
  const piPath = join(launcherDir, "pi");
  const runtimeParent = mkdtempSync(join(tmpdir(), "agent-pool-orch-f-parent-swap-"));
  const externalDir = mkdtempSync(join(tmpdir(), "agent-pool-f-parent-external-"));
  const invoker = createPiModelInvoker(
    { path: piPath, version: "0.81.1", digest: `sha256:${digestOf(piPath)}` },
    runtimeParent,
  );
  // Race: remove the runtime parent and recreate it as a symlink to an
  // external path. The invoker still holds the original path string.
  rmSync(runtimeParent, { recursive: true, force: true });
  symlinkSync(externalDir, runtimeParent);
  await assert.rejects(
    () => invoker.invoke({ prompt: "test", model: "moonshot/kimi-k3", deadlineMs: 5000, maxOutputTokens: 100 }, new AbortController().signal),
    /contained|symlink|regular directory|not a directory/,
  );
});

test("settings has no static subagent defaultModel", () => {
  const settings = JSON.parse(readFileSync(join(packageRoot, "config/settings.json"), "utf8"));
  assert.equal(settings.subagents.defaultModel, undefined, "static defaultModel must be removed");
  assert.equal(settings.subagents.fallbackModels, undefined, "static fallbackModels must be removed");
});

test("invoker passes exact Sol fallback model in Pi argv", async () => {
  const { createPiModelInvoker } = await import(join(packageRoot, "scripts/pi-model-invoker.mjs"));
  const captureDir = mkdtempSync(join(tmpdir(), "agent-pool-f-sol-argv-"));
  const helper = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('pi 0.81.1'); process.exit(0); }
if (args[0] === '--list-models') { console.log('moonshot kimi-k3'); console.log('openai-codex gpt-5.6-sol'); process.exit(0); }
fs.writeFileSync('${captureDir}/argv', JSON.stringify(args));
process.exit(0);
`;
  const launcherDir = fakeLauncherDir({ helper });
  const piPath = join(launcherDir, "pi");
  const runtimeParent = mkdtempSync(join(tmpdir(), "agent-pool-orch-f-sol-invoker-"));
  const invoker = createPiModelInvoker(
    { path: piPath, version: "0.81.1", digest: `sha256:${digestOf(piPath)}` },
    runtimeParent,
  );
  await invoker.invoke(
    { prompt: "test prompt", model: "openai-codex/gpt-5.6-sol", deadlineMs: 5000, maxOutputTokens: 100 },
    new AbortController().signal,
  );
  const argv = JSON.parse(readFileSync(join(captureDir, "argv"), "utf8"));
  const modelIndex = argv.indexOf("--model");
  assert.ok(modelIndex >= 0, "--model flag missing");
  assert.equal(argv[modelIndex + 1], "openai-codex/gpt-5.6-sol", "Sol must be the effective model argv");
});
