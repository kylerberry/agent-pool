import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync as nativeMkdtempSync, writeFileSync, readFileSync, existsSync , rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

function captureHelper(captureDir) {
  return `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('pi 0.81.1'); process.exit(0); }
if (args[0] === '--list-models') { console.log('moonshot kimi-k3'); console.log('openai-codex gpt-5.6-sol'); process.exit(0); }
fs.writeFileSync('${captureDir}/argv', JSON.stringify(args));
const inputIndex = args.indexOf('--input');
if (inputIndex >= 0 && args[inputIndex + 1]) {
  process.stdout.write(fs.readFileSync(args[inputIndex + 1], 'utf8'));
}
process.exit(0);
`;
}

function defaultHelper() {
  return `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('pi 0.81.1'); process.exit(0); }
if (args[0] === '--list-models') { console.log('moonshot kimi-k3'); console.log('openai-codex gpt-5.6-sol'); process.exit(0); }
const inputIndex = args.indexOf('--input');
if (inputIndex >= 0 && args[inputIndex + 1]) {
  process.stdout.write(fs.readFileSync(args[inputIndex + 1], 'utf8'));
}
process.exit(0);
`;
}

function fakeLauncherDir({ marker = "", helper = defaultHelper() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agent-pool-orch-invoker-bin-"));
  writeFileSync(join(dir, "pi"), launcherWrapper("0.81.1", marker), { mode: 0o755 });
  writeFileSync(join(dir, "pi-helper.js"), helper, { mode: 0o755 });
  return dir;
}

function digestOf(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("invoker passes exact router-selected model in Pi argv", async () => {
  const { createPiModelInvoker } = await import(join(packageRoot, "scripts/pi-model-invoker.mjs"));
  const captureDir = mkdtempSync(join(tmpdir(), "agent-pool-argv-cap-"));
  const launcherDir = fakeLauncherDir({ helper: captureHelper(captureDir) });
  const piPath = join(launcherDir, "pi");
  const runtimeParent = mkdtempSync(join(tmpdir(), "agent-pool-orch-invoker-runtime-"));
  const invoker = createPiModelInvoker({ path: piPath, version: "0.81.1", digest: `sha256:${digestOf(piPath)}` }, runtimeParent);
  await invoker.invoke({ prompt: "test prompt", model: "moonshot/kimi-k3", deadlineMs: 5000, maxOutputTokens: 100 }, new AbortController().signal);
  const argv = JSON.parse(readFileSync(join(captureDir, "argv"), "utf8"));
  const modelIndex = argv.indexOf("--model");
  assert.ok(modelIndex >= 0, "--model flag missing");
  assert.equal(argv[modelIndex + 1], "moonshot/kimi-k3", "model argv mismatch");
});

test("invoker passes Sol fallback model in Pi argv", async () => {
  const { createPiModelInvoker } = await import(join(packageRoot, "scripts/pi-model-invoker.mjs"));
  const captureDir = mkdtempSync(join(tmpdir(), "agent-pool-argv-cap-"));
  const launcherDir = fakeLauncherDir({ helper: captureHelper(captureDir) });
  const piPath = join(launcherDir, "pi");
  const runtimeParent = mkdtempSync(join(tmpdir(), "agent-pool-orch-invoker-runtime-"));
  const invoker = createPiModelInvoker({ path: piPath, version: "0.81.1", digest: `sha256:${digestOf(piPath)}` }, runtimeParent);
  await invoker.invoke({ prompt: "test prompt", model: "openai-codex/gpt-5.6-sol", deadlineMs: 5000, maxOutputTokens: 100 }, new AbortController().signal);
  const argv = JSON.parse(readFileSync(join(captureDir, "argv"), "utf8"));
  const modelIndex = argv.indexOf("--model");
  assert.ok(modelIndex >= 0, "--model flag missing");
  assert.equal(argv[modelIndex + 1], "openai-codex/gpt-5.6-sol", "fallback model argv mismatch");
});

test("invoker creates prompt files under runtime parent", async () => {
  const { createPiModelInvoker } = await import(join(packageRoot, "scripts/pi-model-invoker.mjs"));
  const captureDir = mkdtempSync(join(tmpdir(), "agent-pool-argv-cap-"));
  const helper = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('pi 0.81.1'); process.exit(0); }
if (args[0] === '--list-models') { console.log('moonshot kimi-k3'); console.log('openai-codex gpt-5.6-sol'); process.exit(0); }
fs.writeFileSync('${captureDir}/argv', JSON.stringify(args));
const inputIndex = args.indexOf('--input');
if (inputIndex >= 0 && args[inputIndex + 1]) {
  fs.writeFileSync('${captureDir}/prompt-content', fs.readFileSync(args[inputIndex + 1], 'utf8'));
  process.stdout.write(fs.readFileSync(args[inputIndex + 1], 'utf8'));
}
process.exit(0);
`;
  const launcherDir = fakeLauncherDir({ helper });
  const piPath = join(launcherDir, "pi");
  const runtimeParent = mkdtempSync(join(tmpdir(), "agent-pool-orch-invoker-runtime-"));
  const invoker = createPiModelInvoker({ path: piPath, version: "0.81.1", digest: `sha256:${digestOf(piPath)}` }, runtimeParent);
  await invoker.invoke({ prompt: "secret prompt content", model: "moonshot/kimi-k3", deadlineMs: 5000, maxOutputTokens: 100 }, new AbortController().signal);
  const argv = JSON.parse(readFileSync(join(captureDir, "argv"), "utf8"));
  const inputIndex = argv.indexOf("--input");
  assert.ok(inputIndex >= 0, "--input flag missing");
  const inputFile = argv[inputIndex + 1];
  assert.ok(inputFile.startsWith(runtimeParent), "prompt file outside runtime parent");
  assert.equal(readFileSync(join(captureDir, "prompt-content"), "utf8"), "secret prompt content", "prompt content mismatch");
});

test("invoker aborts when Pi executable changes after creation", async () => {
  const { createPiModelInvoker } = await import(join(packageRoot, "scripts/pi-model-invoker.mjs"));
  const launcherDir = fakeLauncherDir();
  const piPath = join(launcherDir, "pi");
  const runtimeParent = mkdtempSync(join(tmpdir(), "agent-pool-orch-invoker-runtime-"));
  const invoker = createPiModelInvoker({ path: piPath, version: "0.81.1", digest: `sha256:${digestOf(piPath)}` }, runtimeParent);
  writeFileSync(piPath, `#!/usr/bin/env node\nconsole.log('pi 0.81.1');\n`, { mode: 0o755 });
  await assert.rejects(
    () => invoker.invoke({ prompt: "test", model: "moonshot/kimi-k3", deadlineMs: 5000, maxOutputTokens: 100 }, new AbortController().signal),
    /identity changed|digest mismatch/,
  );
});

test("invoker uses trusted absolute interpreter and fixed PATH", async (t) => {
  const { createPiModelInvoker } = await import(join(packageRoot, "scripts/pi-model-invoker.mjs"));
  const captureDir = mkdtempSync(join(tmpdir(), "agent-pool-argv-cap-"));
  const launcherDir = fakeLauncherDir({ helper: captureHelper(captureDir) });
  const piPath = join(launcherDir, "pi");
  const runtimeParent = mkdtempSync(join(tmpdir(), "agent-pool-orch-invoker-runtime-"));
  const invoker = createPiModelInvoker({ path: piPath, version: "0.81.1", digest: `sha256:${digestOf(piPath)}` }, runtimeParent);

  const hostileDir = mkdtempSync(join(tmpdir(), "agent-pool-hostile-"));
  const marker = join(hostileDir, "marker");
  writeFileSync(join(hostileDir, "node"), `#!/usr/bin/env node\nrequire('fs').writeFileSync('${marker}', '');\n`, { mode: 0o755 });
  withEnv(t, { PATH: hostileDir });

  await invoker.invoke({ prompt: "test", model: "moonshot/kimi-k3", deadlineMs: 5000, maxOutputTokens: 100 }, new AbortController().signal);
  assert.ok(!existsSync(marker), "hostile PATH shim executed");
});
