import test, { after } from "node:test";
import { createCopiedPackageFixture } from "./helpers/copied-package-fixture.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkSchemaIntegrity, findDagTopology, validateInstance } from "../lib/json-schema-subset.mjs";

const ownedTempRoots = new Set();
const nativeMkdtempSync = mkdtempSync;
function ownedMkdtempSync(prefix) {
  const path = nativeMkdtempSync(prefix);
  ownedTempRoots.add(path);
  return path;
}
after(() => { for (const path of ownedTempRoots) rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }); });

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(packageRoot, "../..");
const script = join(packageRoot, "scripts/preflight.mjs");

const NONCE = "a".repeat(64);

function validContract(workspace, overrides = {}) {
  return {
    schema_version: 1,
    node_id: "node-1",
    attempt_id: "attempt-1",
    attempt_number: 1,
    intent: "Execute one node attempt",
    change_spec: "Integrate the worker harness.",
    acceptance_criteria: [{ id: "ac-1", text: "Every attempt receives a fresh launcher-owned context." }],
    criteria_origin: { source: "decomposition", source_id: "spec-1" },
    target_repo: "owner/repo",
    target_branch: "main",
    prior_failure_context: [],
    ...overrides,
  };
}

function validMarker(workspace, overrides = {}) {
  const issuedAt = new Date();
  return {
    schema_version: 3,
    actor: "pool-worker",
    node_id: "node-1",
    attempt_id: "attempt-1",
    attempt_nonce: NONCE,
    issued_by: "agent-pool-supervisor",
    issued_at: issuedAt.toISOString(),
    expires_at: new Date(issuedAt.getTime() + 180_000).toISOString(),
    max_age_seconds: 180,
    target_repo: "owner/repo",
    target_branch: "main",
    workspace_path: workspace,
    pi_runtime_parent: join(workspace, ".pi-runtime"),
    pi_session_dir: join(workspace, ".pi-runtime", "session"),
    pi_executable_identity: { path: "/opt/pi/pi", version: "0.81.1", digest: "d1" },
    package_identity: { path: "/opt/agent-pool-worker-harness", profile: "pool-proof-builder", digest: "d2" },
    profile_identity: { name: "pool-proof-builder", path: "/opt/agent-pool-worker-harness/profiles/pool-proof-builder", digest: "d3" },
    selected_model: "moonshot/kimi-k2.7-code",
    tool_grants: ["read", "edit", "write", "bash"],
    result_destination: { kind: "sqlite", id: "result-1" },
    ...overrides,
  };
}

/**
 * Build a fresh attempt workspace. `marker`/`contract` are factories so each test
 * can mutate exactly one input and leave the rest of the launch valid.
 */
function workspaceWith({
  marker = validMarker,
  contract = validContract,
  omitMarker = false,
  omitContract = false,
  extraControlFiles = {},
} = {}) {
  const workspace = ownedMkdtempSync(join(tmpdir(), "agent-pool-worker-"));
  mkdirSync(join(workspace, ".agent-pool"));
  mkdirSync(join(workspace, ".pi", "skills", "graphify"), { recursive: true });
  writeFileSync(
    join(workspace, ".pi/skills/graphify/SKILL.md"),
    `# graphify\ngraphify 0.9.25\n\`\`\`bash\npip install graphifyy==0.9.25\n\`\`\`\n`,
  );
  if (!omitMarker) {
    writeFileSync(join(workspace, ".agent-pool/execution-context.json"), JSON.stringify(marker(workspace)));
  }
  if (!omitContract) {
    writeFileSync(join(workspace, ".agent-pool/attempt-contract.json"), JSON.stringify(contract(workspace)));
  }
  for (const [name, content] of Object.entries(extraControlFiles)) {
    writeFileSync(join(workspace, ".agent-pool", name), content);
  }
  return workspace;
}

function run(workspace, actor = "pool-worker", preflightScript = script) {
  return spawnSync(process.execPath, [preflightScript], {
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
  const result = run(workspaceWith());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /preflight passed/);
});

test("rejects missing execution context", () => {
  const result = run(workspaceWith({ omitMarker: true }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /marker is missing/);
});

test("rejects Repository Builder environment", () => {
  const result = run(workspaceWith(), "repository-builder");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AGENT_POOL_ACTOR/);
});

test("rejects malformed or expanded marker", () => {
  const result = run(workspaceWith({ marker: (w) => ({ ...validMarker(w), unexpected: true }) }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing or unknown fields/);
});

test("rejects a version 1 marker that carries no launcher-owned freshness", () => {
  const result = run(
    workspaceWith({
      marker: () => ({
        schema_version: 1,
        actor: "pool-worker",
        node_id: "node-1",
        attempt_id: "attempt-1",
        issued_by: "agent-pool-supervisor",
        issued_at: new Date().toISOString(),
        target_repo: "owner/repo",
        target_branch: "main",
      }),
    }),
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing or unknown fields/);
});

test("rejects marker identity that differs from launcher expectations", () => {
  const result = run(workspaceWith({ marker: (w) => validMarker(w, { attempt_id: "stale-attempt" }) }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /identity does not match launcher expectations/);
});

test("rejects repository or branch that differs from launcher expectations", () => {
  const result = run(workspaceWith({ marker: (w) => validMarker(w, { target_branch: "untrusted-branch" }) }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /target does not match launcher expectations/);
});

test("rejects an untrusted issuer", () => {
  const result = run(workspaceWith({ marker: (w) => validMarker(w, { issued_by: "repository-builder" }) }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing or unknown fields/);
});

test("rejects non-RFC-3339 timestamps", () => {
  const result = run(workspaceWith({ marker: (w) => validMarker(w, { issued_at: "April 13, 2026" }) }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing or unknown fields|RFC 3339/);
});

test("rejects impossible calendar dates", () => {
  const result = run(
    workspaceWith({
      marker: (w) => validMarker(w, { issued_at: "2026-02-30T12:00:00Z", expires_at: "2026-02-30T12:03:00Z" }),
    }),
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid calendar date/);
});

test("accepts canonical UTC timestamps with fractional seconds", () => {
  const result = run(workspaceWith());
  assert.equal(result.status, 0, result.stderr);
});

test("rejects stale markers", () => {
  const issuedAt = new Date(Date.now() - 301_000);
  const result = run(
    workspaceWith({
      marker: (w) =>
        validMarker(w, {
          issued_at: issuedAt.toISOString(),
          expires_at: new Date(issuedAt.getTime() + 180_000).toISOString(),
        }),
    }),
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /stale/);
});

test("rejects a marker whose expiry has already passed", () => {
  const issuedAt = new Date(Date.now() - 60_000);
  const result = run(
    workspaceWith({
      marker: (w) =>
        validMarker(w, {
          issued_at: issuedAt.toISOString(),
          expires_at: new Date(issuedAt.getTime() + 30_000).toISOString(),
          max_age_seconds: 300,
        }),
    }),
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /stale/);
});

test("rejects a marker issued too far in the future", () => {
  const issuedAt = new Date(Date.now() + 120_000);
  const result = run(
    workspaceWith({
      marker: (w) =>
        validMarker(w, {
          issued_at: issuedAt.toISOString(),
          expires_at: new Date(issuedAt.getTime() + 60_000).toISOString(),
        }),
    }),
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /future/);
});

test("rejects a freshness budget above the five-minute ceiling", () => {
  const result = run(workspaceWith({ marker: (w) => validMarker(w, { max_age_seconds: 301 }) }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing or unknown fields|ceiling/);
});

test("rejects an expiry that outruns the marker's own freshness budget", () => {
  const issuedAt = new Date();
  const result = run(
    workspaceWith({
      marker: (w) =>
        validMarker(w, {
          issued_at: issuedAt.toISOString(),
          expires_at: new Date(issuedAt.getTime() + 240_000).toISOString(),
          max_age_seconds: 60,
        }),
    }),
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /max_age_seconds budget/);
});

test("rejects a marker bound to a different workspace", () => {
  const other = ownedMkdtempSync(join(tmpdir(), "agent-pool-other-"));
  const result = run(workspaceWith({ marker: () => validMarker(other) }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /workspace does not match/);
});

test("rejects a marker whose workspace_path does not exist", () => {
  const result = run(workspaceWith({ marker: () => validMarker("/nonexistent/agent-pool/attempt") }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /workspace_path does not exist/);
});

test("rejects a reused workspace carrying prior-attempt residue", () => {
  const result = run(workspaceWith({ extraControlFiles: { "attempt-0-result.json": "{}" } }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not fresh/);
});

test("rejects an oversized marker field before pattern matching", () => {
  const result = run(workspaceWith({ marker: (w) => validMarker(w, { target_repo: "o".repeat(100_000) }) }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /maximum field length/);
});

test("rejects a symlinked control directory", () => {
  const workspace = workspaceWith();
  // Move the (otherwise entirely valid) control directory outside the workspace
  // and symlink it back in, so only the symlink itself distinguishes this launch.
  const outside = ownedMkdtempSync(join(tmpdir(), "agent-pool-outside-"));
  const relocated = join(outside, ".agent-pool");
  mkdirSync(relocated);
  for (const name of ["execution-context.json", "attempt-contract.json"]) {
    writeFileSync(join(relocated, name), readFileSync(join(workspace, ".agent-pool", name), "utf8"));
  }
  rmSync(join(workspace, ".agent-pool"), { recursive: true });
  symlinkSync(relocated, join(workspace, ".agent-pool"));

  const result = run(workspace);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be a real directory/);
});

test("rejects a missing attempt contract", () => {
  const result = run(workspaceWith({ omitContract: true }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /attempt contract is missing/);
});

test("rejects an attempt contract carrying DAG topology", () => {
  const result = run(
    workspaceWith({ contract: (w) => ({ ...validContract(w), depends_on: ["model-routing-foundation"] }) }),
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /attempt contract is invalid|must not carry DAG topology/);
});

test("rejects DAG topology nested inside an allowed contract field", () => {
  const result = run(
    workspaceWith({
      contract: (w) =>
        validContract(w, {
          prior_failure_context: [
            {
              attempt_id: "attempt-0",
              phase: "R",
              attempted: [],
              failure_reason: "failed",
              discoveries: [],
              dead_ends: [],
              nodes: ["a"],
            },
          ],
        }),
    }),
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /attempt contract is invalid|must not carry DAG topology/);
});

test("rejects an attempt contract for a different attempt", () => {
  const result = run(workspaceWith({ contract: (w) => validContract(w, { attempt_id: "attempt-9" }) }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /attempt contract identity does not match/);
});

test("rejects an attempt contract with no acceptance criteria", () => {
  const result = run(workspaceWith({ contract: (w) => validContract(w, { acceptance_criteria: [] }) }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /attempt contract is invalid/);
});

test("rejects a missing bundled contract schema", (t) => {
  const workspace = workspaceWith();
  const fixture = createCopiedPackageFixture(t);
  rmSync(join(fixture.packagePath, "contracts/pool-worker-attempt-contract.schema.json"));
  const result = run(workspace, "pool-worker", fixture.script);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /contract schema missing/);
});

test("rejects a corrupted contract schema before any paid work", (t) => {
  const workspace = workspaceWith();
  const fixture = createCopiedPackageFixture(t);
  const schemaPath = join(fixture.packagePath, "contracts/pool-worker-attempt-contract.schema.json");
  const widened = JSON.parse(readFileSync(schemaPath, "utf8"));
  widened.additionalProperties = true;
  writeFileSync(schemaPath, JSON.stringify(widened));
  const result = run(workspace, "pool-worker", fixture.script);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /integrity check/);
});

test("rejects a model scope that drifts from the specification, even when both config files agree", (t) => {
  const workspace = workspaceWith();
  const fixture = createCopiedPackageFixture(t);
  const settingsPath = join(fixture.packagePath, "config/settings.json");
  const runtimePath = join(fixture.packagePath, "config/runtime-versions.json");
  const hostile = ["anthropic/hostile-model"];
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
  settings.enabledModels = hostile;
  settings.subagents.modelScope.allow = hostile;
  runtime.allowedModels = hostile;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  writeFileSync(runtimePath, JSON.stringify(runtime, null, 2));
  const result = run(workspace, "pool-worker", fixture.script);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exact specification model set/);
});

test("bundled v3 execution-context schema accepts both supervisor and runtime issuers", () => {
  const schema = JSON.parse(readFileSync(join(packageRoot, "contracts/pool-worker-execution-context.schema.json"), "utf8"));
  assert.deepEqual(schema.properties.issued_by.enum, ["agent-pool-supervisor", "agent-pool-runtime"]);
});

test("preflight's exact model set matches the domain approved-model registry", () => {
  const preflightSource = readFileSync(script, "utf8");
  const registrySource = readFileSync(join(repoRoot, "src/domains/model-routing-and-evaluation/approved-models.ts"), "utf8");
  const declared = [...preflightSource.matchAll(/"((?:openai-codex|moonshot)\/[^"]+)"/g)].map((m) => m[1]);
  assert.equal(declared.length, 5, "preflight must declare exactly five models");
  for (const model of declared) {
    assert.ok(registrySource.includes(model), `${model} is not in the domain approved-model registry`);
  }
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

test("bundled contract schemas match their canonical sources", () => {
  for (const name of [
    "crafts-phase-artifact.schema.json",
    "pool-worker-execution-context.schema.json",
    "pool-worker-attempt-contract.schema.json",
  ]) {
    const canonical = readFileSync(join(repoRoot, "docs/raw/specs/schemas", name), "utf8");
    const bundled = readFileSync(join(packageRoot, "contracts", name), "utf8");
    assert.equal(bundled, canonical, `${name} drifted from its canonical source`);
  }
});

test("every bundled contract schema passes the integrity check", () => {
  for (const name of [
    "crafts-phase-artifact.schema.json",
    "pool-worker-execution-context.schema.json",
    "pool-worker-attempt-contract.schema.json",
  ]) {
    const schema = JSON.parse(readFileSync(join(packageRoot, "contracts", name), "utf8"));
    assert.deepEqual(checkSchemaIntegrity(schema), [], `${name} failed integrity check`);
  }
});

test("schema subset validator enforces the keywords the contracts rely on", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["kind", "count"],
    properties: {
      kind: { enum: ["a", "b"] },
      count: { type: "integer", minimum: 1, maximum: 3 },
      tags: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
    },
  };
  assert.deepEqual(validateInstance(schema, { kind: "a", count: 2 }), []);
  assert.ok(validateInstance(schema, { kind: "c", count: 2 }).length > 0);
  assert.ok(validateInstance(schema, { kind: "a", count: 4 }).length > 0);
  assert.ok(validateInstance(schema, { kind: "a", count: 1, extra: true }).length > 0);
  assert.ok(validateInstance(schema, { kind: "a", count: 1, tags: ["x", "x"] }).length > 0);
  assert.ok(validateInstance(schema, { kind: "a" }).length > 0);
});

test("schema integrity rejects an unresolvable reference and an unsupported keyword", () => {
  assert.ok(checkSchemaIntegrity({ type: "object", properties: { a: { $ref: "#/$defs/missing" } } }).length > 0);
  assert.ok(checkSchemaIntegrity({ type: "object", propertyNames: { type: "string" } }).length > 0);
});

test("topology sweep finds DAG keys at any depth and tolerates cycles", () => {
  assert.equal(findDagTopology({ a: { b: { depends_on: [] } } }), "payload.a.b.depends_on");
  assert.equal(findDagTopology({ items: [{ ready_frontier: [] }] }), "payload.items[0].ready_frontier");
  const cyclic = { safe: true };
  cyclic.self = cyclic;
  assert.equal(findDagTopology(cyclic), null);
});

function fakeBinDir(overrides = {}) {
  const runtime = JSON.parse(readFileSync(join(packageRoot, "config/runtime-versions.json"), "utf8"));
  const dir = ownedMkdtempSync(join(tmpdir(), "agent-pool-fake-bin-"));

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
  const workspace = workspaceWith();
  const fakeBin = fakeBinDir();
  writeFileSync(join(fakeBin, "graphify"), `#!/bin/sh\necho "graphify 0.9.25"\n`, { mode: 0o755 });
  const result = runExternal(workspace, fakeBin);
  assert.equal(result.status, 0, result.stderr);
});

test("preflight rejects substring version like 0.9.250", () => {
  const workspace = workspaceWith();
  const fakeBin = fakeBinDir({ graphifyVersion: "0.9.250" });
  writeFileSync(join(fakeBin, "graphify"), `#!/bin/sh\necho "graphify 0.9.250"\n`, { mode: 0o755 });
  const result = runExternal(workspace, fakeBin);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /version mismatch/);
});

test("preflight rejects unavailable Graphify executable", () => {
  const workspace = workspaceWith();
  const fakeBin = fakeBinDir();
  writeFileSync(join(fakeBin, "graphify"), `#!/bin/sh\nexit 1\n`, { mode: 0o755 });
  const result = runExternal(workspace, fakeBin);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Graphify/);
});

test("preflight rejects Graphify skill provenance mismatch", () => {
  const workspace = workspaceWith();
  writeFileSync(join(workspace, ".pi/skills/graphify/SKILL.md"), "graphify 0.9.24\n", { mode: 0o644 });
  const fakeBin = fakeBinDir();
  writeFileSync(join(fakeBin, "graphify"), `#!/bin/sh\necho "graphify 0.9.25"\n`, { mode: 0o755 });
  const result = runExternal(workspace, fakeBin);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /skill provenance/);
});
