import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoModuleReferences } from '../helpers/import-policy.ts';

const SRC = fileURLToPath(new URL('../../src/domains/orchestration/', import.meta.url));

describe('architecture boundaries', () => {
  it('orchestration CLAUDE.md is pointer-only', () => {
    const text = readFileSync(join(SRC, 'CLAUDE.md'), 'utf8').trim();
    assert.equal(text, '@AGENTS.md');
  });

  it('orchestration source never imports craft-pool', () => {
    const source = fileURLToPath(new URL('../../src/domains/orchestration/index.ts', import.meta.url));
    assertNoModuleReferences(source, ['craft-pool']);
  });

  it('orchestration source never emits DAG topology in worker contract', () => {
    const text = readFileSync(join(SRC, 'attempt-dispatch.ts'), 'utf8');
    const forbidden = ['depends_on', 'sibling', 'frontier', 'topology', 'prediction'];
    for (const key of forbidden) {
      assert.equal(text.includes(key), false, `attempt-dispatch must not mention ${key}`);
    }
  });

  it('does not hard-code a confidence threshold in the store or frontier', () => {
    const store = readFileSync(join(SRC, 'sqlite-store.ts'), 'utf8');
    const frontier = readFileSync(join(SRC, 'ready-frontier.ts'), 'utf8');
    assert.equal(store.includes('0.75'), false, 'store must not contain an intuitive threshold');
    assert.equal(frontier.includes('0.75'), false, 'frontier must not contain an intuitive threshold');
    assert.equal(store.includes('minConfidence'), false, 'store must not reference a hard-coded threshold constant');
  });
});
