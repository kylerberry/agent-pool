import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasProviderCredential, runPreflight } from '../src/preflight.ts';

describe('Preflight provider auth check', () => {
  const originalOpenai = process.env.OPENAI_API_KEY;
  const originalMoonshot = process.env.MOONSHOT_API_KEY;

  it('does not accept OPENAI_API_KEY as a valid Codex OAuth credential', () => {
    delete process.env.OPENAI_API_KEY;
    process.env.MOONSHOT_API_KEY = 'moonshot-key';
    assert.equal(hasProviderCredential('openai-codex'), false);
    process.env.OPENAI_API_KEY = 'openai-key';
    // OPENAI_API_KEY is not a Pi 0.83 auth shape for openai-codex (OAuth).
    assert.equal(hasProviderCredential('openai-codex'), false);
  });

  it('requires a moonshot credential specifically for moonshot', () => {
    delete process.env.MOONSHOT_API_KEY;
    process.env.OPENAI_API_KEY = 'openai-key';
    assert.equal(hasProviderCredential('moonshot'), false);
    process.env.MOONSHOT_API_KEY = 'moonshot-key';
    assert.equal(hasProviderCredential('moonshot'), true);
  });

  it('rejects unknown providers', () => {
    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.MOONSHOT_API_KEY = 'moonshot-key';
    assert.equal(hasProviderCredential('anthropic'), false);
  });

  // Restore environment.
  after?.(() => {
    if (originalOpenai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenai;
    if (originalMoonshot === undefined) delete process.env.MOONSHOT_API_KEY;
    else process.env.MOONSHOT_API_KEY = originalMoonshot;
  });
});
