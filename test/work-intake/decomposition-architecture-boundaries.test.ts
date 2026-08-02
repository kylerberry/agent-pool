import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const packageRoot = join(repoRoot, "packages/orchestrator-harness");

test("orchestrator-harness package is physically separate from worker-harness", () => {
  assert.ok(existsSync(join(packageRoot, "package.json")));
  assert.ok(!existsSync(join(packageRoot, "skills/craft-pool/SKILL.md")));
  assert.ok(!existsSync(join(packageRoot, "agents/craft-builder.md")));
});

test("orchestrator-harness package.json declares pi-package keyword", () => {
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  assert.ok(pkg.keywords?.includes("pi-package"));
  assert.equal(pkg.name, "agent-pool-orchestrator-harness");
});

test("orchestrator-harness pi config exposes only orchestrator agents and skills", () => {
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const agentsDir = pkg.pi?.subagents?.agents?.[0];
  const skillsDir = pkg.pi?.skills?.[0];
  assert.equal(agentsDir, "./agents");
  assert.equal(skillsDir, "./skills");
});

test("orchestrator-harness config owns decomposition routing only", () => {
  const routing = JSON.parse(readFileSync(join(packageRoot, "config/model-routing.bootstrap.json"), "utf8"));
  assert.equal(routing.actor, "orchestrator-control-plane");
  assert.deepEqual(Object.keys(routing.roles), ["decomposition"]);
  assert.equal(routing.roles.decomposition.primary, "moonshot/kimi-k3");
  assert.deepEqual(routing.roles.decomposition.fallback, ["openai-codex/gpt-5.6-sol"]);
});

test("orchestrator-harness runtime-versions pins control-plane actor", () => {
  const runtime = JSON.parse(readFileSync(join(packageRoot, "config/runtime-versions.json"), "utf8"));
  assert.equal(runtime.actor, "orchestrator-control-plane");
  assert.ok(Array.isArray(runtime.allowedModels));
  assert.ok(runtime.allowedModels.includes("moonshot/kimi-k3"));
});

test("spec-decomposer agent requires structured output and read-only decomposition surface", () => {
  const text = readFileSync(join(packageRoot, "agents/spec-decomposer.md"), "utf8");
  assert.ok(text.includes("structured output"));
  assert.ok(text.includes("read-only"));
  assert.ok(!text.includes("write tool"));
  assert.ok(!text.includes("shell tool"));
  assert.ok(!text.includes("dispatch"));
});

test("spec-decomposer agent frontmatter declares a read-only tools allowlist", () => {
  const text = readFileSync(join(packageRoot, "agents/spec-decomposer.md"), "utf8");
  const frontmatter = text.split("---\n")[1];
  assert.ok(frontmatter, "agent must have YAML frontmatter");
  const toolsMatch = /tools:\s*([\s\S]*?)(?=\n[a-zA-Z]|\n*$)/.exec(frontmatter);
  assert.ok(toolsMatch, "frontmatter must declare a tools list");
  const tools = toolsMatch[1]!.split(/,|\s+/).map((t) => t.trim()).filter(Boolean);
  const disallowed = new Set(["write", "shell", "bash", "repository", "validator", "persistence", "approval", "queue", "dispatch"]);
  for (const tool of tools) {
    assert.ok(!disallowed.has(tool), `tool allowlist contains disallowed capability: ${tool}`);
  }
});

test("decompose-spec skill exposes only decomposition role", () => {
  const text = readFileSync(join(packageRoot, "skills/decompose-spec/SKILL.md"), "utf8");
  assert.ok(text.includes("decomposition"));
  assert.ok(!text.includes("craft-pool"));
  assert.ok(!text.includes("worker-harness"));
});

test("orchestrator-harness source does not import from worker-harness", () => {
  // There is no TypeScript source in the package; scripts are isolated launch/preflight files.
  // This test ensures no worker-harness path appears in the orchestrator package files.
  const files = [
    "package.json",
    "AGENTS.md",
    "config/settings.json",
    "config/runtime-versions.json",
  ];
  for (const file of files) {
    const text = readFileSync(join(packageRoot, file), "utf8");
    assert.ok(!text.includes("worker-harness"), `${file} references worker-harness`);
    assert.ok(!text.includes("craft-pool"), `${file} references craft-pool`);
  }
});

test("emission schema permits only ADR-018 fields", () => {
  const schema = JSON.parse(readFileSync(join(packageRoot, "contracts/decomposition-emission.schema.json"), "utf8"));
  assert.equal(schema.additionalProperties, false);
  const nodeSchema = schema.properties?.nodes?.items;
  assert.equal(nodeSchema?.additionalProperties, false);
  const allowed = new Set(["id", "intent", "change_spec", "acceptance_criteria", "depends_on"]);
  const actual = new Set(Object.keys(nodeSchema?.properties || {}));
  assert.deepEqual(actual, allowed);
});

test("work-intage decomposition source imports only approved domains", () => {
  const source = readFileSync(join(repoRoot, "src/domains/work-intake/decomposition-harness.ts"), "utf8");
  assert.ok(source.includes("model-routing-and-evaluation"));
  assert.ok(source.includes("codebase-knowledge"));
  assert.ok(!source.includes("worker-harness"));
  assert.ok(!source.includes("craft-pool"));
  assert.ok(!source.includes("orchestration"));
});
