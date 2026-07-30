import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(packageRoot, "../..");
const script = join(packageRoot, "scripts/preflight.mjs");

function workspaceWith(marker) {
  const workspace = mkdtempSync(join(tmpdir(), "agent-pool-worker-"));
  mkdirSync(join(workspace, ".agent-pool"));
  mkdirSync(join(workspace, ".pi", "skills", "graphify"), { recursive: true });
  writeFileSync(
    join(workspace, ".pi/skills/graphify/SKILL.md"),
    `# graphify\ngraphify 0.9.25\n\`\`\`bash\npip install graphifyy==0.9.25\n\`\`\`\n`,
  );
  if (marker !== undefined) {
    writeFileSync(join(workspace, ".agent-pool/execution-context.json"), JSON.stringify(marker));
  }
  return workspace;
}

function validMarker() {
  return {
    schema_version: 1,
    actor: "pool-worker",
    node_id: "node-1",
    attempt_id: "attempt-1",
    issued_by: "agent-pool-supervisor",
    issued_at: new Date().toISOString(),
    target_repo: "owner/repo",
    target_branch: "main"
  };
}

function run(workspace, actor = "pool-worker") {
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_POOL_ACTOR: actor,
      AGENT_POOL_NODE_ID: "node-1",
      AGENT_POOL_ATTEMPT_ID: "attempt-1",
      AGENT_POOL_TARGET_REPO: "owner/repo",
      AGENT_POOL_TARGET_BRANCH: "main",
      AGENT_POOL_WORKSPACE: workspace,
      AGENT_POOL_SKIP_EXTERNAL_CHECKS: "1"
    }
  });
}

test("accepts a valid pool-worker launch context", () => {
  const result = run(workspaceWith(validMarker()));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /preflight passed/);
});

test("rejects missing execution context", () => {
  const result = run(workspaceWith(undefined));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /marker is missing/);
});

test("rejects Repository Builder environment", () => {
  const result = run(workspaceWith(validMarker()), "repository-builder");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AGENT_POOL_ACTOR/);
});

test("rejects malformed or expanded marker", () => {
  const marker = { ...validMarker(), unexpected: true };
  const result = run(workspaceWith(marker));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing or unknown fields/);
});

test("rejects marker identity that differs from launcher expectations", () => {
  const marker = { ...validMarker(), attempt_id: "stale-attempt" };
  const result = run(workspaceWith(marker));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /identity does not match launcher expectations/);
});

test("rejects repository or branch that differs from launcher expectations", () => {
  const marker = { ...validMarker(), target_branch: "untrusted-branch" };
  const result = run(workspaceWith(marker));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /target does not match launcher expectations/);
});

test("rejects non-RFC-3339 timestamps", () => {
  const marker = { ...validMarker(), issued_at: "April 13, 2026" };
  const result = run(workspaceWith(marker));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RFC 3339/);
});

test("rejects impossible calendar dates", () => {
  const marker = { ...validMarker(), issued_at: "2026-02-30T12:00:00Z" };
  const result = run(workspaceWith(marker));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid calendar date/);
});

test("accepts canonical UTC timestamps with fractional seconds", () => {
  const marker = { ...validMarker(), issued_at: new Date().toISOString() };
  const result = run(workspaceWith(marker));
  assert.equal(result.status, 0, result.stderr);
});

test("rejects stale markers", () => {
  const marker = { ...validMarker(), issued_at: new Date(Date.now() - 301_000).toISOString() };
  const result = run(workspaceWith(marker));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /stale/);
});

test("worker routing excludes orchestrator-side decomposition", () => {
  const routing = JSON.parse(readFileSync(join(packageRoot, "config/model-routing.bootstrap.json"), "utf8"));
  assert.equal(Object.hasOwn(routing.roles, "decomposition"), false);
  const orchestratorRouting = JSON.parse(readFileSync(join(repoRoot, "packages/orchestrator-harness/config/model-routing.bootstrap.json"), "utf8"));
  assert.equal(orchestratorRouting.roles.decomposition.primary, "moonshot/kimi-k3");
});

test("runtime resources are not locally auto-discovered", () => {
  for (const name of ["planner", "builder", "evaluator", "security", "sharpener"]) {
    assert.equal(readFileSync(join(repoRoot, `.pi/agents/local-craft-${name}.md`), "utf8").includes(`name: local-craft-${name}`), true);
    assert.equal(existsSync(join(repoRoot, `.pi/agents/craft-${name}.md`)), false);
  }
  assert.equal(existsSync(join(repoRoot, ".pi/skills/craft-pool/SKILL.md")), false);
});

test("bundled phase schema matches the canonical source", () => {
  const canonical = readFileSync(join(repoRoot, "docs/raw/specs/schemas/crafts-phase-artifact.schema.json"), "utf8");
  const bundled = readFileSync(join(packageRoot, "contracts/crafts-phase-artifact.schema.json"), "utf8");
  assert.equal(bundled, canonical);
});

test("bundled execution schema matches the canonical source", () => {
  const canonical = readFileSync(join(repoRoot, "docs/raw/specs/schemas/pool-worker-execution-context.schema.json"), "utf8");
  const bundled = readFileSync(join(packageRoot, "contracts/pool-worker-execution-context.schema.json"), "utf8");
  assert.equal(bundled, canonical);
});

function fakeBinDir(overrides = {}) {
  const runtime = JSON.parse(readFileSync(join(packageRoot, "config/runtime-versions.json"), "utf8"));
  const dir = mkdtempSync(join(tmpdir(), "agent-pool-fake-bin-"));

  const allowedModels = runtime.allowedModels.map((m) => m.split("/").join(" "));
  const piLines = ["provider      model                context  max-out  thinking  images", ...allowedModels];
  writeFileSync(join(dir, "pi"), `#!/bin/sh\necho '${piLines.join("\n")}'\n`);

  const graphifyVersion = overrides.graphifyVersion ?? runtime.graphify;
  const graphifyExit = overrides.graphifyExit ?? 0;
  writeFileSync(
    join(dir, "graphify"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "graphify ${graphifyVersion}"\n  exit ${graphifyExit}\nfi\necho "graphify ${graphifyVersion}"\n`,
  );

  for (const name of ["pi", "graphify"]) {
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

function runExternal(workspace, fakeBin, actor = "pool-worker") {
  const envPath = `${fakeBin}${process.env.PATH ? `:${process.env.PATH}` : ""}`;
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_POOL_ACTOR: actor,
      AGENT_POOL_NODE_ID: "node-1",
      AGENT_POOL_ATTEMPT_ID: "attempt-1",
      AGENT_POOL_TARGET_REPO: "owner/repo",
      AGENT_POOL_TARGET_BRANCH: "main",
      AGENT_POOL_WORKSPACE: workspace,
      PATH: envPath,
    },
  });
}

test("preflight accepts exact pinned Graphify version", () => {
  const workspace = workspaceWith(validMarker());
  const fakeBin = fakeBinDir();
  writeFileSync(join(fakeBin, "graphify"), `#!/bin/sh\necho "graphify 0.9.25"\n`, { mode: 0o755 });
  const result = runExternal(workspace, fakeBin);
  assert.equal(result.status, 0, result.stderr);
});

test("preflight rejects substring version like 0.9.250", () => {
  const workspace = workspaceWith(validMarker());
  const fakeBin = fakeBinDir({ graphifyVersion: "0.9.250" });
  writeFileSync(join(fakeBin, "graphify"), `#!/bin/sh\necho "graphify 0.9.250"\n`, { mode: 0o755 });
  const result = runExternal(workspace, fakeBin);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /version mismatch/);
});

test("preflight rejects unavailable Graphify executable", () => {
  const workspace = workspaceWith(validMarker());
  const fakeBin = fakeBinDir();
  writeFileSync(join(fakeBin, "graphify"), `#!/bin/sh\nexit 1\n`, { mode: 0o755 });
  const result = runExternal(workspace, fakeBin);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Graphify/);
});

test("preflight rejects Graphify skill provenance mismatch", () => {
  const workspace = workspaceWith(validMarker());
  writeFileSync(join(workspace, ".pi/skills/graphify/SKILL.md"), "graphify 0.9.24\n", { mode: 0o644 });
  const fakeBin = fakeBinDir();
  writeFileSync(join(fakeBin, "graphify"), `#!/bin/sh\necho "graphify 0.9.25"\n`, { mode: 0o755 });
  const result = runExternal(workspace, fakeBin);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /skill provenance/);
});
