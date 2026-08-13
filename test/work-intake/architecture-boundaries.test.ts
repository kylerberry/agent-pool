import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { glob } from 'node:fs/promises';
import { assertNoModuleReferencePrefixes, assertNoModuleReferences, staticModuleReferences } from '../helpers/import-policy.ts';

const domainSourceRoot = fileURLToPath(new URL('../../src/domains/work-intake/', import.meta.url));

/** Remove block and line comments so source scans match code, not prose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

async function sourceFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of glob(`${domainSourceRoot}/**/*.ts`)) files.push(entry);
  return files;
}

function directIntakeModuleFiles(): string[] {
  const visited = new Set<string>();
  const queue = [join(domainSourceRoot, 'direct-intake.ts')];

  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (visited.has(current)) continue;
    visited.add(current);

    // An empty forbidden list still fails closed on computed module references,
    // which cannot establish a complete static graph policy.
    assertNoModuleReferences(current, []);
    for (const { specifier } of staticModuleReferences(current)) {
      if (specifier.startsWith('node:')) continue;
      assert.ok(
        specifier.startsWith('./') || specifier.startsWith('../'),
        `${current} reaches a non-builtin package: ${specifier}`,
      );
      const resolved = join(dirname(current), specifier);
      assert.ok(
        resolved.startsWith(domainSourceRoot),
        `${current} reaches outside the work-intake domain: ${specifier}`,
      );
      queue.push(resolved);
    }
  }

  return [...visited];
}

describe('architecture boundaries', () => {
  it('direct-intake module graph makes no decomposition model call', () => {
    const files = directIntakeModuleFiles();
    assert.ok(files.length > 0, 'expected direct-intake source files');
    for (const file of files) {
      assertNoModuleReferences(file, [
        '../model-routing-and-evaluation/model-router.ts',
        '../model-routing-and-evaluation/provider-adapters.ts',
        'craft-pool',
        'packages/worker-harness',
      ]);
    }
  });

  it('direct-intake module graph imports no other domain', () => {
    for (const file of directIntakeModuleFiles()) {
      // This graph is local-only: every parent-relative import reaches another domain.
      assertNoModuleReferencePrefixes(file, ['../']);
    }
  });

  it('the intake boundary is synchronous, so it cannot await a model call', () => {
    // Comments are stripped first: prose about awaiting is not code that awaits.
    const content = stripComments(readFileSync(join(domainSourceRoot, 'direct-intake.ts'), 'utf8'));
    assert.equal(/export\s+async\s+function/.test(content), false);
    assert.equal(/\bawait\b/.test(content), false);
  });

  it('does not dispatch nodes — dispatch belongs to Orchestration', async () => {
    for (const file of await sourceFiles()) {
      const content = readFileSync(file, 'utf8');
      assert.equal(/bullmq|BullMQ|enqueueJob|nodeQueue/.test(content), false, `${file} must not dispatch`);
    }
  });

  it('the whole module graph under direct-intake stays inside the domain', () => {
    // A model call cannot be reached from the direct boundary under any name,
    // even though the sibling decomposition boundary intentionally uses routing.
    const files = directIntakeModuleFiles();
    assert.ok(files.length >= 4, `expected to walk the direct-intake graph, saw ${files.length} modules`);
  });

  it('domain index exports narrow decomposition and direct-intake interfaces', () => {
    const content = readFileSync(join(domainSourceRoot, 'index.ts'), 'utf8');
    for (const expected of [
      'runDecomposition',
      'DecompositionJob',
      'acceptDirectTasks',
      'handleDirectTaskRequest',
      'IdempotencyStore',
      'DirectTaskUnit',
    ]) {
      assert.ok(content.includes(expected), `index must export ${expected}`);
    }
  });

  it('keeps DAG topology out of any worker-facing contract', () => {
    const content = readFileSync(join(domainSourceRoot, 'contracts.ts'), 'utf8');
    // depends_on is intake-side only; nothing here describes a worker attempt.
    assert.equal(/WorkerAttempt|AttemptContract|attempt_id/.test(content), false);
  });

  it('CLAUDE.md remains a pointer to AGENTS.md', () => {
    const content = readFileSync(join(domainSourceRoot, 'CLAUDE.md'), 'utf8');
    assert.equal(content.trim(), '@AGENTS.md');
  });
});
