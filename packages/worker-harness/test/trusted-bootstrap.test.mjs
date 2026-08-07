import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bootstrapPath = join(packageRoot, "profiles/pool-proof-builder/extensions/trusted-bootstrap.ts");

test("trusted bootstrap source exposes parameterless actor_identity and captures context once", () => {
  const source = readFileSync(bootstrapPath, "utf8");
  assert.ok(source.includes("export function actor_identity"));
  assert.ok(source.includes("can_modify_pool_policy: false"));
  assert.ok(source.includes("pi.registerTool"));
  // Five tools: actor_identity, read, write, edit, bash.
  const toolMatches = [...source.matchAll(/registerTool\(\{[^}]*name:\s*['"]([^'"]+)['"]/g)];
  assert.equal(toolMatches.length, 5, "trusted bootstrap must register exactly five tools");
  const names = toolMatches.map((m) => m[1]).sort();
  assert.deepEqual(names, ["actor_identity", "bash", "edit", "read", "write"]);
  // bash tool must not accept caller-supplied env
  assert.ok(!source.includes("env: Type.Optional"));
  assert.ok(source.includes("AGENT_POOL_EXECUTION_CONTEXT"));
  // actor_identity is parameterless and derived from a captured context loaded once.
  assert.ok(source.includes("const capturedContext = deepFreeze(loadContext());"));
});
