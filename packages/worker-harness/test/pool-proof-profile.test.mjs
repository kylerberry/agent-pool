import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profileRoot = join(packageRoot, "profiles", "pool-proof-builder");

test("pool-proof-builder profile exists and declares builder-only scope", () => {
  assert.equal(existsSync(join(profileRoot, "profile.json")), true);
  assert.equal(existsSync(join(profileRoot, "settings.json")), true);
  assert.equal(existsSync(join(profileRoot, "agents", "pool-proof-builder.md")), true);
  assert.equal(existsSync(join(profileRoot, "extensions", "trusted-bootstrap.ts")), true);

  const profile = JSON.parse(readFileSync(join(profileRoot, "profile.json"), "utf8"));
  assert.equal(profile.actor, "pool-worker");
  assert.equal(profile.name, "pool-proof-builder");

  const agentText = readFileSync(join(profileRoot, "agents", "pool-proof-builder.md"), "utf8");
  assert.ok(agentText.includes("actor_identity"));
  assert.ok(agentText.includes("can_modify_pool_policy"));
  assert.ok(!agentText.includes("craft-evaluator"));
});

test("pool-proof-builder settings match the approved model registry", () => {
  const settings = JSON.parse(readFileSync(join(profileRoot, "settings.json"), "utf8"));
  const expected = [
    "openai-codex/gpt-5.6-luna",
    "openai-codex/gpt-5.6-terra",
    "openai-codex/gpt-5.6-sol",
    "moonshot/kimi-k2.7-code",
    "moonshot/kimi-k3",
  ];
  assert.deepEqual(settings.enabledModels.sort(), expected.sort());
  assert.deepEqual(settings.subagents.modelScope.allow.sort(), expected.sort());
  assert.equal(settings.subagents.modelScope.enforce, true);
});

test("trusted bootstrap exposes parameterless actor_identity", () => {
  const bootstrap = readFileSync(join(profileRoot, "extensions", "trusted-bootstrap.ts"), "utf8");
  assert.ok(bootstrap.includes("export function actor_identity"));
  assert.ok(bootstrap.includes("can_modify_pool_policy: false"));
  assert.ok(bootstrap.includes("AGENT_POOL_EXECUTION_CONTEXT"));
  assert.ok(!bootstrap.includes("env: Type.Optional"));
  assert.ok(!bootstrap.includes("...request.env"));
});

test("in-container broker builds its own environment and never spreads caller env", () => {
  const broker = readFileSync(join(profileRoot, "broker.mjs"), "utf8");
  assert.ok(broker.includes("PATH: '/usr/local/bin:/usr/bin:/bin'"));
  assert.ok(!broker.includes("...request.env"));
  assert.ok(!broker.includes("request.env"));
});
