import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initializeFixtureRepository } from '../src/fixture-repository.ts';

test('fixture starts red through its named acceptance command without mutating source', () => {
  const fixturePath = mkdtempSync(join(tmpdir(), 'pool-proof-fixture-red-'));
  try {
    const { manifest } = initializeFixtureRepository(fixturePath);
    assert.deepEqual(manifest.fixture_test_command, ['npm', 'run', 'test:acceptance']);
    const result = spawnSync(manifest.fixture_test_command[0], manifest.fixture_test_command.slice(1), {
      cwd: fixturePath,
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    assert.notEqual(result.status, 0, `fixture acceptance unexpectedly passed: ${result.stdout}${result.stderr}`);
  } finally {
    rmSync(fixturePath, { recursive: true, force: true });
  }
});
