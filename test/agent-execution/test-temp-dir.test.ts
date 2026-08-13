import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createTestTempDir } from './test-temp-dir.ts';

describe('test temporary directories', () => {
  it('removes each test-owned root after its nested test settles', async (t) => {
    let path = '';
    await t.test('owns a root', (child) => {
      path = createTestTempDir(child, 'agent-pool-test-cleanup-');
      assert.equal(existsSync(path), true);
    });
    assert.equal(existsSync(path), false, 'test-owned temporary root leaked');
  });
});
