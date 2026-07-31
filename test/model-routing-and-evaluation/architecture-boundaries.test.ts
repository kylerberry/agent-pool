import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { glob } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const domainSourceRoot = join(__dirname, '../../src/domains/model-routing-and-evaluation');
const workerFixturePath = join(__dirname, '../../packages/worker-harness/config/model-routing.bootstrap.json');
const orchestratorFixturePath = join(__dirname, '../../packages/orchestrator-harness/config/model-routing.bootstrap.json');

describe('architecture boundaries', () => {
  it('worker bootstrap fixture has no decomposition row', () => {
    const fixture = JSON.parse(readFileSync(workerFixturePath, 'utf8'));
    assert.equal(fixture.roles.decomposition, undefined);
    assert.ok(Object.keys(fixture.roles).length > 0);
  });

  it('orchestrator bootstrap fixture owns decomposition only', () => {
    const fixture = JSON.parse(readFileSync(orchestratorFixturePath, 'utf8'));
    assert.ok(fixture.roles.decomposition);
    const nonDecompositionRoles = Object.keys(fixture.roles).filter((r) => r !== 'decomposition');
    assert.deepEqual(nonDecompositionRoles, []);
    assert.equal(fixture.actor, 'orchestrator-control-plane');
  });

  it('model-routing source has no craft-pool or DAG-control dependency', async () => {
    const sourceFiles: string[] = [];
    for await (const entry of glob(`${domainSourceRoot}/**/*.ts`)) {
      sourceFiles.push(entry);
    }
    assert.ok(sourceFiles.length > 0, 'expected domain source files');
    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf8');
      assert.equal(
        content.includes('craft-pool'),
        false,
        `${file} must not reference craft-pool`,
      );
      assert.equal(
        content.includes('dag-control'),
        false,
        `${file} must not reference dag-control`,
      );
      // bootstrap-policy.ts owns the trusted source-bound fixture paths;
      // it must not import executable modules from the worker package.
      if (file.endsWith('bootstrap-policy.ts')) continue;
      assert.equal(
        content.includes('packages/worker-harness'),
        false,
        `${file} must not reference packages/worker-harness`,
      );
    }
  });

  it('bootstrap loaders do not import executable modules from packages/worker-harness', async () => {
    const bootstrapSourcePath = join(domainSourceRoot, 'bootstrap-policy.ts');
    const content = readFileSync(bootstrapSourcePath, 'utf8');
    assert.equal(/from\s+['"]packages\/worker-harness/.test(content), false);
    assert.equal(/import\s+.*packages\/worker-harness/.test(content), false);
  });

  it('domain index exports only narrow interfaces', async () => {
    const indexPath = join(domainSourceRoot, 'index.ts');
    const content = readFileSync(indexPath, 'utf8');
    assert.ok(content.includes('RoutingPolicy'));
    assert.ok(content.includes('RoutingDecision'));
    assert.ok(content.includes('AdapterRegistry'));
  });

  it('source-bound loaders bind to actor-owned fixture paths', () => {
    const content = readFileSync(join(domainSourceRoot, 'bootstrap-policy.ts'), 'utf8');
    assert.equal(content.includes("packages/worker-harness/config/model-routing.bootstrap.json"), true);
    assert.equal(content.includes("packages/orchestrator-harness/config/model-routing.bootstrap.json"), true);
  });
});
