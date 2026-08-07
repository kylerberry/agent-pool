import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bootstrapPath = join(
  packageRoot,
  "profiles/pool-proof-builder/extensions/trusted-bootstrap.ts",
);

function loadBootstrapWithContext(context) {
  const contextDir = mkdtempSync(join(tmpdir(), "trusted-bootstrap-ctx-"));
  const contextFile = join(contextDir, "context.json");
  writeFileSync(contextFile, JSON.stringify(context));

  const script = `
    import bootstrap from ${JSON.stringify(bootstrapPath)};
    const tools = [];
    const pi = { registerTool(tool) { tools.push(tool); } };
    bootstrap(pi);
    const identityTool = tools.find((t) => t.name === "actor_identity");
    const identityResult = await identityTool.execute();
    console.log(JSON.stringify({
      count: tools.length,
      names: tools.map((t) => t.name).sort(),
      identity: identityResult.details,
    }));
  `;

  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", script],
    {
      env: {
        ...process.env,
        AGENT_POOL_EXECUTION_CONTEXT: contextFile,
        AGENT_POOL_BROKER_SOCKET: "/tmp/agent-pool-broker.sock",
      },
      encoding: "utf8",
    },
  );

  rmSync(contextDir, { recursive: true, force: true });

  if (result.status !== 0) {
    throw new Error(
      `trusted bootstrap smoke failed: ${result.stderr || result.stdout}`,
    );
  }

  const lines = result.stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

test("trusted bootstrap loads without paid calls and registers five tools", () => {
  const context = {
    node_id: "node-1",
    attempt_id: "att://proof/node-1/1",
    target_repo: "fixture",
    target_branch: "main",
  };

  const result = loadBootstrapWithContext(context);

  assert.equal(result.count, 5, "trusted bootstrap must register exactly five tools");
  assert.deepEqual(result.names, [
    "actor_identity",
    "bash",
    "edit",
    "read",
    "write",
  ]);
  assert.equal(result.identity.actor, "pool-worker");
  assert.equal(result.identity.authority, "single-attempt-execution");
  assert.equal(result.identity.context_source, "launcher-verified");
  assert.equal(result.identity.can_modify_pool_policy, false);
  assert.equal(result.identity.node_id, "node-1");
  assert.equal(result.identity.attempt_id, "att://proof/node-1/1");
});
