import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { glob } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '../..');
const domainSourceRoot = join(repoRoot, 'src/domains/agent-execution');

async function domainSourceFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of glob(`${domainSourceRoot}/**/*.ts`)) files.push(entry);
  assert.ok(files.length > 0, 'expected domain source files');
  return files;
}

describe('architecture boundaries', () => {
  it('agent-execution source carries no DAG, scheduler, or gate logic', async () => {
    // `decomposition` itself is permitted: it is a criteria-provenance *value* the
    // attempt contract must carry (orchestrator-spec §5.1). What must be absent is
    // decomposition and scheduling *behaviour*.
    const forbidden = [
      'ready_frontier',
      'readyFrontier',
      'topological',
      'scheduler',
      'gate1',
      'gate_1',
      'decompose(',
      'decomposeSpec',
      'emitDag',
      'connected component',
    ];
    for (const file of await domainSourceFiles()) {
      const content = readFileSync(file, 'utf8');
      // dag-exclusion.ts names topology in order to reject it; that is its job.
      if (file.endsWith('dag-exclusion.ts')) continue;
      for (const token of forbidden) {
        assert.equal(
          content.toLowerCase().includes(token.toLowerCase()),
          false,
          `${file} must not reference ${token}`,
        );
      }
    }
  });

  it('agent-execution source does not load repository-builder resources', async () => {
    for (const file of await domainSourceFiles()) {
      const content = readFileSync(file, 'utf8');
      assert.equal(content.includes('.pi/skills'), false, `${file} must not load local Pi skills`);
      assert.equal(content.includes('local-craft-'), false, `${file} must not reference local craft agents`);
      assert.equal(/from\s+['"].*packages\/worker-harness/.test(content), false, `${file} must not import the worker package`);
    }
  });

  it('the public interface exposes no DAG-shaped type', () => {
    const content = readFileSync(join(domainSourceRoot, 'index.ts'), 'utf8');
    for (const token of ['DagNode', 'DagShape', 'NodeGraph', 'DependsOn']) {
      assert.equal(content.includes(token), false, `index.ts must not export ${token}`);
    }
    for (const token of ['validateExecutionContext', 'validateAttemptContracts', 'retainTranscript']) {
      assert.ok(content.includes(token), `index.ts should export ${token}`);
    }
  });

  it('bundled worker contract schemas match their canonical raw sources', () => {
    for (const name of [
      'pool-worker-execution-context.schema.json',
      'pool-worker-attempt-contract.schema.json',
      'crafts-phase-artifact.schema.json',
    ]) {
      const canonical = readFileSync(join(repoRoot, 'docs/raw/specs/schemas', name), 'utf8');
      const bundled = readFileSync(join(repoRoot, 'packages/worker-harness/contracts', name), 'utf8');
      assert.equal(bundled, canonical, `${name} drifted from its canonical source`);
    }
  });

  it('the attempt-contract schema declares no dependency edges', () => {
    const schema = JSON.parse(
      readFileSync(join(repoRoot, 'docs/raw/specs/schemas/pool-worker-attempt-contract.schema.json'), 'utf8'),
    );
    assert.equal(schema.additionalProperties, false);
    for (const key of ['depends_on', 'nodes', 'edges', 'ready_frontier']) {
      assert.equal(Object.hasOwn(schema.properties, key), false, `${key} must not be a contract property`);
    }
  });

  it('the Pi launcher composition references the sandbox broker', () => {
    const launcher = readFileSync(join(domainSourceRoot, 'pool-proof-pi-launcher.ts'), 'utf8');
    assert.ok(launcher.includes('createSandboxBroker'), 'launcher must start the sandbox broker');
    assert.ok(launcher.includes('AGENT_POOL_BROKER_SOCKET'), 'launcher must pass broker socket to Pi');
    assert.ok(launcher.includes('--no-builtin-tools'), 'launcher must disable built-in tools');
    assert.ok(launcher.includes('--tools'), 'launcher must explicitly allowlist tools');
    assert.ok(launcher.includes('--no-extensions'), 'launcher must disable ambient extension discovery');
    assert.ok(launcher.includes('--no-skills'), 'launcher must disable skill discovery');
    assert.ok(launcher.includes('--no-prompt-templates'), 'launcher must disable prompt templates');
    assert.ok(launcher.includes('--no-context-files'), 'launcher must disable context-file discovery');
    assert.ok(launcher.includes("'--mode'") && launcher.includes("'json'"), 'launcher must use JSON mode');
  });

  it('the execution-context schema binds freshness and workspace to the launcher', () => {
    const schema = JSON.parse(
      readFileSync(join(repoRoot, 'docs/raw/specs/schemas/pool-worker-execution-context.schema.json'), 'utf8'),
    );
    assert.equal(schema.properties.schema_version.const, 3);
    assert.deepEqual(schema.properties.issued_by.enum, ['agent-pool-supervisor', 'agent-pool-runtime']);
    assert.equal(schema.properties.max_age_seconds.maximum, 300);
    for (const key of ['expires_at', 'max_age_seconds', 'workspace_path', 'attempt_nonce']) {
      assert.ok(schema.required.includes(key), `${key} must be required`);
    }
  });
});
