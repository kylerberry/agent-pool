import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  SANDBOX_PINNED_GID,
  SANDBOX_PINNED_UID,
  prepareWorkspaceForSandbox,
  requireNonRootSandboxIdentity,
  resolveSandboxIdentity,
} from '../../src/domains/agent-execution/index.ts';

describe('sandbox identity mapping', () => {
  it('resolves a non-root identity for the current non-root host', () => {
    const id = resolveSandboxIdentity();
    assert.ok(id.uid > 0, 'sandbox uid must be non-root');
    assert.ok(id.gid > 0, 'sandbox gid must be non-root');
    assert.equal(id.isPinned, false, 'non-root launcher must not use the pinned identity');
  });

  it('falls back to the pinned identity when the host launcher is root', () => {
    if (process.getuid?.() !== 0) {
      // Simulate a root launcher by overriding uid resolution. This is safe
      // because the function only reads process.getuid/getgid.
      const originalUid = process.getuid;
      const originalGid = process.getgid;
      Object.defineProperty(process, 'getuid', { value: () => 0, configurable: true });
      Object.defineProperty(process, 'getgid', { value: () => 0, configurable: true });
      try {
        const id = resolveSandboxIdentity();
        assert.equal(id.uid, SANDBOX_PINNED_UID);
        assert.equal(id.gid, SANDBOX_PINNED_GID);
        assert.equal(id.isPinned, true);
      } finally {
        Object.defineProperty(process, 'getuid', { value: originalUid, configurable: true });
        Object.defineProperty(process, 'getgid', { value: originalGid, configurable: true });
      }
      return;
    }
    // Running as real root: the pinned fallback should already be selected.
    const id = resolveSandboxIdentity();
    assert.equal(id.uid, SANDBOX_PINNED_UID);
    assert.equal(id.gid, SANDBOX_PINNED_GID);
    assert.equal(id.isPinned, true);
  });

  it('rejects uid 0 at container execution time', () => {
    assert.throws(
      () => requireNonRootSandboxIdentity({ uid: 0, gid: 1000, isPinned: false }),
      /uid 0 is not permitted/,
    );
  });

  it('initializes writable workspace HOME and XDG directories owned by the sandbox identity', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'sandbox-prep-'));
    try {
      const id = resolveSandboxIdentity();
      prepareWorkspaceForSandbox(workspace, id);

      for (const dir of ['.home', '.home/.config', '.home/.cache', '.home/.local/share']) {
        const st = statSync(join(workspace, dir));
        assert.ok(st.isDirectory(), `${dir} must be created`);
        assert.equal(st.uid, id.uid, `${dir} must be owned by sandbox uid`);
        assert.equal(st.gid, id.gid, `${dir} must be owned by sandbox gid`);
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('produces one consistent mapping that supports writable edit and Git commit composition', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'sandbox-git-'));
    try {
      const id = resolveSandboxIdentity();
      prepareWorkspaceForSandbox(workspace, id);
      const home = join(workspace, '.home');

      // Simulate a sandboxed edit.
      writeFileSync(join(workspace, 'src.txt'), 'hello');

      // Git requires a writable HOME for global config when no explicit env is set.
      const git = (args: readonly string[]) =>
        spawnSync('git', args, {
          cwd: workspace,
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH,
            HOME: home,
          },
        });
      mkdirSync(join(workspace, 'src'));
      writeFileSync(join(workspace, 'src', 'message.js'), 'export const msg = "world";');

      git(['init']);
      git(['config', '--global', 'user.email', 'proof@agent-pool.local']);
      git(['config', '--global', 'user.name', 'Pool Proof']);
      git(['add', '.']);
      const commit = git(['commit', '-m', 'sandbox commit', '--date', '2026-08-05T00:00:00Z']);

      assert.equal(commit.status, 0, `git commit must succeed: ${commit.stderr}`);
      assert.ok(statSync(home).isDirectory(), 'HOME directory must remain writable after Git use');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
