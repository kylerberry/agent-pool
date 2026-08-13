import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hasProviderCredential } from '../src/preflight.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = join(packageRoot, 'reports');

describe('Preflight provider auth check', () => {
  it('does not accept OPENAI_API_KEY as a valid Codex OAuth credential', () => {
    assert.equal(hasProviderCredential('openai-codex', { MOONSHOT_API_KEY: 'moonshot-key' }), false);
    assert.equal(hasProviderCredential('openai-codex', { OPENAI_API_KEY: 'openai-key', MOONSHOT_API_KEY: 'moonshot-key' }), false);
  });

  it('requires a moonshot credential specifically for moonshot', () => {
    assert.equal(hasProviderCredential('moonshot', { OPENAI_API_KEY: 'openai-key' }), false);
    assert.equal(hasProviderCredential('moonshot', { MOONSHOT_API_KEY: 'moonshot-key' }), true);
  });

  it('rejects unknown providers', () => {
    assert.equal(hasProviderCredential('anthropic', { OPENAI_API_KEY: 'openai-key', MOONSHOT_API_KEY: 'moonshot-key' }), false);
  });

  it('writes failed preflight evidence only to a temporary candidate and preserves retained report bytes', () => {
    const manifest = JSON.parse(readFileSync(join(reportsDir, 'manifest.json'), 'utf8')) as { reports: Record<string, unknown> };
    const retainedPaths = ['manifest.json', ...Object.keys(manifest.reports)];
    const before = new Map(retainedPaths.map((name) => [name, readFileSync(join(reportsDir, name))]));
    const result = spawnSync(process.execPath, ['--experimental-strip-types', 'src/preflight.ts'], {
      cwd: packageRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    const candidate = /candidate evidence: (.+)$/m.exec(result.stderr)?.[1];
    assert.ok(candidate, `expected candidate evidence path in stderr: ${result.stderr}`);
    assert.ok(existsSync(candidate));
    try {
      const evidence = JSON.parse(readFileSync(candidate, 'utf8'));
      assert.equal(evidence.stage, 'sandbox_image');
    } finally {
      rmSync(dirname(candidate), { recursive: true, force: true });
    }
    for (const [name, bytes] of before) {
      assert.deepEqual(readFileSync(join(reportsDir, name)), bytes, `${name} retained bytes changed after failed preflight`);
    }
  });
});
