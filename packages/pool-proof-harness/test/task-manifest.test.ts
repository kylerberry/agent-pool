/**
 * Strict task-manifest validator tests.
 *
 * Every hostile manifest case must be rejected with a distinct bounded failure
 * code before any runner side effect, and the validator must never create
 * filesystem state. Valid manifests yield a stable manifest_sha256 over file
 * bytes. The retained-reports tree is snapshotted before and after every test.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  parseTaskManifest,
  loadTaskManifest,
  type TaskManifest,
} from '../src/task-manifest.ts';
import { createTempRoot } from './helpers/temp-root.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = join(packageRoot, 'reports');

/** Full recursive snapshot of the retained reports tree (path -> digest). */
function snapshotReportsTree(): Map<string, string> {
  const snapshot = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      const st = statSync(full);
      if (st.isDirectory()) {
        snapshot.set(rel, 'dir');
        walk(full, rel);
      } else {
        snapshot.set(rel, createHash('sha256').update(readFileSync(full)).digest('hex'));
      }
    }
  };
  walk(reportsDir, '');
  return snapshot;
}

let reportsBaseline: Map<string, string>;
beforeEach(() => {
  reportsBaseline = snapshotReportsTree();
});
afterEach(() => {
  assert.deepEqual([...snapshotReportsTree().entries()].sort(), [...reportsBaseline.entries()].sort(),
    'retained reports/ tree must be byte-identical with zero new entries');
});

function gitInitRepo(dir: string, files: Record<string, string> = { 'src/message.js': 'export const x = 1;\n' }): { repoPath: string; baseCommit: string } {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.gitignore'), '.home/\n');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  const env = {
    PATH: '/usr/bin:/bin',
    GIT_AUTHOR_NAME: 'Task',
    GIT_AUTHOR_EMAIL: 'task@agent-pool.local',
    GIT_COMMITTER_NAME: 'Task',
    GIT_COMMITTER_EMAIL: 'task@agent-pool.local',
  };
  const run = (args: readonly string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', env });
  assert.equal(run(['init', '-q']).status, 0);
  run(['config', 'user.name', 'Task']);
  run(['config', 'user.email', 'task@agent-pool.local']);
  assert.equal(run(['add', '.']).status, 0);
  assert.equal(run(['commit', '-qm', 'base']).status, 0);
  const baseCommit = String(run(['rev-parse', 'HEAD']).stdout).trim();
  assert.match(baseCommit, /^[0-9a-f]{40}$/);
  return { repoPath: dir, baseCommit };
}

function validManifest(repoPath: string, baseCommit: string): Record<string, unknown> {
  return {
    schema_version: 1,
    task_id: 'demo-task',
    target_repo_path: repoPath,
    base_commit: baseCommit,
    intent: 'Make one approved change to the demo task repository.',
    change_spec: 'Update src/message.js so the task verification command passes.',
    acceptance_criteria: [
      { id: 'c1', text: 'Only allowed paths change.' },
      { id: 'c2', text: 'All verification commands pass after the change.' },
    ],
    allowed_changed_paths: ['src/message.js'],
    verification_commands: [
      ['node', '--test', 'test/message.test.js'],
      ['sh', '-c', 'node --test test/message.test.js'],
    ],
    model: 'moonshot/kimi-k2.7-code',
    bounds: { verification_timeout_seconds: 60 },
  };
}

function writeManifest(dir: string, manifest: Record<string, unknown>): string {
  const path = join(dir, 'task-manifest.json');
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return path;
}

describe('task-manifest strict validation', () => {
  it('accepts a valid manifest and computes a stable sha256 over file bytes', (t) => {
    const tmpRoot = createTempRoot(t, 'task-manifest-valid-');
    const { repoPath, baseCommit } = gitInitRepo(join(tmpRoot, 'repo'));
    const manifestPath = writeManifest(tmpRoot, validManifest(repoPath, baseCommit));

    const first = loadTaskManifest(manifestPath);
    assert.equal(first.ok, true, first.ok ? '' : `${first.code}: ${first.reason}`);
    const second = loadTaskManifest(manifestPath);
    assert.equal(second.ok, true);
    const expected = createHash('sha256').update(readFileSync(manifestPath)).digest('hex');
    assert.equal(first.ok && first.manifest_sha256, expected);
    assert.equal(second.ok && second.manifest_sha256, first.ok && first.manifest_sha256);

    // A one-byte change must change the identity hash.
    writeFileSync(manifestPath, JSON.stringify(validManifest(repoPath, baseCommit), null, 2) + '\n');
    const third = loadTaskManifest(manifestPath);
    assert.equal(third.ok, true);
    assert.notEqual(third.ok && third.manifest_sha256, expected);
  });

  it('matches the declared contract schema: valid manifest accepted, unknown field and path escape rejected', async (t) => {
    const tmpRoot = createTempRoot(t, 'task-manifest-schema-');
    const { repoPath, baseCommit } = gitInitRepo(join(tmpRoot, 'repo'));
    // @ts-expect-error worker-harness JSON schema validator has no type declarations
    const { validateInstance } = await import('../../worker-harness/lib/json-schema-subset.mjs');
    const schema = JSON.parse(readFileSync(join(packageRoot, 'contracts', 'task-manifest.schema.json'), 'utf8'));
    const valid = validManifest(repoPath, baseCommit);
    assert.deepEqual(validateInstance(schema, valid), [], 'contract schema must accept a valid manifest');
    assert.ok(validateInstance(schema, { ...valid, extra_field: 1 }).length > 0, 'unknown field rejected');
    assert.ok(validateInstance(schema, { ...valid, allowed_changed_paths: ['/abs'] }).length > 0, 'absolute path rejected');
    assert.ok(validateInstance(schema, { ...valid, allowed_changed_paths: ['.git/config'] }).length > 0, '.git path rejected');
    assert.ok(validateInstance(schema, { ...valid, base_commit: 'main' }).length > 0, 'mutable revision rejected');
  });

  it('rejects unknown top-level fields with MANIFEST_UNKNOWN_FIELD', (t) => {
    const tmpRoot = createTempRoot(t, 'task-manifest-unknown-');
    const { repoPath, baseCommit } = gitInitRepo(join(tmpRoot, 'repo'));
    const manifest = { ...validManifest(repoPath, baseCommit), extra_field: 'nope' };
    const result = parseTaskManifest(manifest);
    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.code, 'MANIFEST_UNKNOWN_FIELD');
    assert.ok(result.ok ? '' : result.reason.includes('extra_field'));
  });

  it('rejects unknown bounds fields with MANIFEST_UNKNOWN_FIELD', (t) => {
    const tmpRoot = createTempRoot(t, 'task-manifest-unknown-bounds-');
    const { repoPath, baseCommit } = gitInitRepo(join(tmpRoot, 'repo'));
    const manifest = { ...validManifest(repoPath, baseCommit), bounds: { verification_timeout_seconds: 60, output_cap: 9999 } };
    const result = parseTaskManifest(manifest);
    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.code, 'MANIFEST_UNKNOWN_FIELD');
  });

  it('rejects missing required fields with MANIFEST_MISSING_FIELD', (t) => {
    const tmpRoot = createTempRoot(t, 'task-manifest-missing-');
    const { repoPath, baseCommit } = gitInitRepo(join(tmpRoot, 'repo'));
    for (const field of ['task_id', 'target_repo_path', 'base_commit', 'intent', 'change_spec', 'acceptance_criteria', 'allowed_changed_paths', 'verification_commands', 'model', 'bounds', 'schema_version']) {
      const manifest = { ...validManifest(repoPath, baseCommit) } as Record<string, unknown>;
      delete manifest[field];
      const result = parseTaskManifest(manifest);
      assert.equal(result.ok, false, `${field} must be required`);
      assert.equal(result.ok ? '' : result.code, 'MANIFEST_MISSING_FIELD', `${field} rejection code`);
      assert.ok(result.ok ? '' : result.reason.includes(field), `${field} named in reason`);
    }
  });

  it('rejects wrong-typed fields with MANIFEST_FIELD_TYPE', (t) => {
    const tmpRoot = createTempRoot(t, 'task-manifest-type-');
    const { repoPath, baseCommit } = gitInitRepo(join(tmpRoot, 'repo'));
    const cases: Array<[string, unknown]> = [
      ['task_id', 123],
      ['intent', ['not', 'a', 'string']],
      ['change_spec', null],
      ['allowed_changed_paths', 'src/message.js'],
      ['verification_commands', 'node --test'],
      ['model', 42],
      ['base_commit', { sha: 'x' }],
      ['bounds', 'fast'],
    ];
    for (const [field, value] of cases) {
      const manifest = { ...validManifest(repoPath, baseCommit), [field]: value };
      const result = parseTaskManifest(manifest);
      assert.equal(result.ok, false, `${field}=${JSON.stringify(value)} must be rejected`);
      assert.equal(result.ok ? '' : result.code, 'MANIFEST_FIELD_TYPE', `${field} type code`);
    }
  });

  it('rejects mutable and malformed revisions with BASE_COMMIT_NOT_40HEX_SHA1', (t) => {
    const tmpRoot = createTempRoot(t, 'task-manifest-base-');
    const { repoPath, baseCommit } = gitInitRepo(join(tmpRoot, 'repo'));
    const hostile = ['main', 'HEAD~1', 'v1.0', baseCommit.slice(0, 7), '0'.repeat(64), 'master', 'origin/main'];
    for (const value of hostile) {
      const manifest = { ...validManifest(repoPath, baseCommit), base_commit: value };
      const result = parseTaskManifest(manifest);
      assert.equal(result.ok, false, `base_commit ${value} must be rejected`);
      assert.equal(result.ok ? '' : result.code, 'BASE_COMMIT_NOT_40HEX_SHA1');
    }
  });

  it('rejects path escapes and git-internal allowed paths', (t) => {
    const tmpRoot = createTempRoot(t, 'task-manifest-paths-');
    const { repoPath, baseCommit } = gitInitRepo(join(tmpRoot, 'repo'));
    const escapes: Array<[string, string]> = [
      ['../x', 'ALLOWED_PATH_NOT_REPO_RELATIVE'],
      ['/abs/path', 'ALLOWED_PATH_NOT_REPO_RELATIVE'],
      ['src/../../escape', 'ALLOWED_PATH_NOT_REPO_RELATIVE'],
      ['.git/config', 'ALLOWED_PATH_GIT_PREFIX'],
      ['.git', 'ALLOWED_PATH_GIT_PREFIX'],
      ['src/.git/hooks/pre-commit', 'ALLOWED_PATH_GIT_PREFIX'],
      ['', 'ALLOWED_PATH_EMPTY'],
    ];
    for (const [value, code] of escapes) {
      const manifest = { ...validManifest(repoPath, baseCommit), allowed_changed_paths: [value] };
      const result = parseTaskManifest(manifest);
      assert.equal(result.ok, false, `allowed path ${JSON.stringify(value)} must be rejected`);
      assert.equal(result.ok ? '' : result.code, code, `path ${JSON.stringify(value)}`);
    }
    const count: Array<[string[] | number, string]> = [
      [[], 'ALLOWED_PATH_COUNT_INVALID'],
      [Array.from({ length: 65 }, (_, i) => `f${i}.txt`), 'ALLOWED_PATH_COUNT_INVALID'],
    ];
    for (const [value, code] of count) {
      const manifest = { ...validManifest(repoPath, baseCommit), allowed_changed_paths: value };
      const result = parseTaskManifest(manifest);
      assert.equal(result.ok, false);
      assert.equal(result.ok ? '' : result.code, code);
    }
  });

  it('rejects credential-like values anywhere in the manifest', (t) => {
    const tmpRoot = createTempRoot(t, 'task-manifest-creds-');
    const { repoPath, baseCommit } = gitInitRepo(join(tmpRoot, 'repo'));
    const hostile: Array<[string, Record<string, unknown>, string]> = [
      ['argv', { ...validManifest(repoPath, baseCommit), verification_commands: [['node', '--api-key=sk-test1234567890abcdef0000']] }, 'argv'],
      ['intent', { ...validManifest(repoPath, baseCommit), intent: 'Use GITHUB_TOKEN=ghp_0123456789abcdefghijklmnop to work' }, 'intent'],
      ['change_spec', { ...validManifest(repoPath, baseCommit), change_spec: 'password: hunter2000secret must be honored' }, 'change_spec'],
      ['criterion text', { ...validManifest(repoPath, baseCommit), acceptance_criteria: [{ id: 'c1', text: 'secret_token=deadbeefdeadbeef is required' }] }, 'criterion'],
      ['path', { ...validManifest(repoPath, baseCommit), allowed_changed_paths: ['sk-test1234567890abcdef00'] }, 'path'],
    ];
    for (const [name, manifest] of hostile) {
      const result = parseTaskManifest(manifest);
      assert.equal(result.ok, false, `${name} credential must be rejected`);
      assert.equal(result.ok ? '' : result.code, 'CREDENTIAL_LIKE_VALUE', name);
    }
  });

  it('rejects unbounded verification commands', (t) => {
    const tmpRoot = createTempRoot(t, 'task-manifest-cmds-');
    const { repoPath, baseCommit } = gitInitRepo(join(tmpRoot, 'repo'));
    const cases: Array<[string, unknown, string]> = [
      ['zero commands', [], 'VERIFICATION_COMMAND_COUNT_INVALID'],
      ['five commands', [['a'], ['b'], ['c'], ['d'], ['e']], 'VERIFICATION_COMMAND_COUNT_INVALID'],
      ['empty argv', [[]], 'VERIFICATION_ARGV_EMPTY'],
      ['nine elements', [['n', '1', '2', '3', '4', '5', '6', '7', '8']], 'VERIFICATION_ARGV_TOO_LONG'],
      ['element over 256 chars', [['n', 'x'.repeat(257)]], 'VERIFICATION_ARG_TOO_LONG'],
      ['newline in element', [['n', 'a\nb']], 'VERIFICATION_ARG_INVALID_CHARS'],
      ['NUL in element', [['n', 'a\0b']], 'VERIFICATION_ARG_INVALID_CHARS'],
      ['empty element', [['n', '']], 'VERIFICATION_ARG_INVALID_CHARS'],
      ['path argv0', [['/usr/bin/node']], 'VERIFICATION_ARG0_NOT_BARE'],
      ['slash argv0', [['./node']], 'VERIFICATION_ARG0_NOT_BARE'],
    ];
    for (const [name, value, code] of cases) {
      const manifest = { ...validManifest(repoPath, baseCommit), verification_commands: value };
      const result = parseTaskManifest(manifest);
      assert.equal(result.ok, false, `${name} must be rejected`);
      assert.equal(result.ok ? '' : result.code, code, name);
    }
  });

  it('rejects unqualified or unapproved models with MODEL_NOT_APPROVED', (t) => {
    const tmpRoot = createTempRoot(t, 'task-manifest-model-');
    const { repoPath, baseCommit } = gitInitRepo(join(tmpRoot, 'repo'));
    for (const model of ['gpt-4', 'unapproved/model', 'openai-codex/gpt-4o', '', 'moonshot/kimi-k2.7-code/typo']) {
      const manifest = { ...validManifest(repoPath, baseCommit), model };
      const result = parseTaskManifest(manifest);
      assert.equal(result.ok, false, `model ${model} must be rejected`);
      assert.equal(result.ok ? '' : result.code, 'MODEL_NOT_APPROVED');
    }
  });

  it('rejects bad task ids, text bounds, and acceptance criteria', (t) => {
    const tmpRoot = createTempRoot(t, 'task-manifest-text-');
    const { repoPath, baseCommit } = gitInitRepo(join(tmpRoot, 'repo'));
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['empty task id', { task_id: '' }, 'TASK_ID_INVALID'],
      ['slash task id', { task_id: 'task/one' }, 'TASK_ID_INVALID'],
      ['long task id', { task_id: 'a'.repeat(129) }, 'TASK_ID_INVALID'],
      ['empty intent', { intent: '' }, 'TEXT_FIELD_INVALID'],
      ['oversize intent', { intent: 'i'.repeat(2049) }, 'TEXT_FIELD_INVALID'],
      ['empty change spec', { change_spec: '' }, 'TEXT_FIELD_INVALID'],
      ['oversize change spec', { change_spec: 'c'.repeat(8193) }, 'TEXT_FIELD_INVALID'],
      ['zero criteria', { acceptance_criteria: [] }, 'ACCEPTANCE_CRITERIA_INVALID'],
      ['nine criteria', { acceptance_criteria: Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, text: 'ok' })) }, 'ACCEPTANCE_CRITERIA_INVALID'],
      ['duplicate ids', { acceptance_criteria: [{ id: 'c1', text: 'a' }, { id: 'c1', text: 'b' }] }, 'ACCEPTANCE_CRITERIA_INVALID'],
      ['criterion missing text', { acceptance_criteria: [{ id: 'c1' }] }, 'ACCEPTANCE_CRITERIA_INVALID'],
    ];
    for (const [name, patch, code] of cases) {
      const manifest = { ...validManifest(repoPath, baseCommit), ...patch };
      const result = parseTaskManifest(manifest);
      assert.equal(result.ok, false, `${name} must be rejected`);
      assert.equal(result.ok ? '' : result.code, code, name);
    }
  });

  it('rejects relative and unresolvable target repo paths', (t) => {
    const tmpRoot = createTempRoot(t, 'task-manifest-target-');
    const { repoPath, baseCommit } = gitInitRepo(join(tmpRoot, 'repo'));
    const relative = { ...validManifest(repoPath, baseCommit), target_repo_path: 'relative/repo' };
    const relativeResult = parseTaskManifest(relative);
    assert.equal(relativeResult.ok, false);
    assert.equal(relativeResult.ok ? '' : relativeResult.code, 'TARGET_REPO_PATH_NOT_ABSOLUTE');

    const missing = join(tmpRoot, 'does-not-exist');
    const unresolvable = { ...validManifest(repoPath, baseCommit), target_repo_path: missing };
    const missingResult = parseTaskManifest(unresolvable);
    assert.equal(missingResult.ok, false);
    assert.equal(missingResult.ok ? '' : missingResult.code, 'TARGET_REPO_PATH_UNRESOLVABLE');
    assert.equal(existsSync(missing), false, 'rejection must not create the path');

    const file = join(tmpRoot, 'plain-file');
    writeFileSync(file, 'not a directory');
    const fileResult = parseTaskManifest({ ...validManifest(repoPath, baseCommit), target_repo_path: file });
    assert.equal(fileResult.ok, false);
    assert.equal(fileResult.ok ? '' : fileResult.code, 'TARGET_REPO_PATH_UNRESOLVABLE');
  });

  it('rejects out-of-range verification timeouts', (t) => {
    const tmpRoot = createTempRoot(t, 'task-manifest-timeout-');
    const { repoPath, baseCommit } = gitInitRepo(join(tmpRoot, 'repo'));
    for (const value of [59, 901, 0, -60, 900.5, '120', null]) {
      const manifest = { ...validManifest(repoPath, baseCommit), bounds: { verification_timeout_seconds: value } };
      const result = parseTaskManifest(manifest);
      assert.equal(result.ok, false, `timeout ${JSON.stringify(value)} must be rejected`);
      assert.equal(result.ok ? '' : result.code, 'VERIFICATION_TIMEOUT_OUT_OF_RANGE');
    }
    for (const value of [60, 300, 900]) {
      const manifest = { ...validManifest(repoPath, baseCommit), bounds: { verification_timeout_seconds: value } };
      const result = parseTaskManifest(manifest);
      assert.equal(result.ok, true, `timeout ${value} must be accepted`);
    }
  });

  it('rejects unreadable and malformed manifest files with bounded codes', (t) => {
    const tmpRoot = createTempRoot(t, 'task-manifest-load-');
    const missing = loadTaskManifest(join(tmpRoot, 'nope.json'));
    assert.equal(missing.ok, false);
    assert.equal(missing.ok ? '' : missing.code, 'MANIFEST_UNREADABLE');

    const malformedPath = join(tmpRoot, 'bad.json');
    writeFileSync(malformedPath, '{not json');
    const malformed = loadTaskManifest(malformedPath);
    assert.equal(malformed.ok, false);
    assert.equal(malformed.ok ? '' : malformed.code, 'MANIFEST_INVALID_JSON');

    const arrayPath = join(tmpRoot, 'array.json');
    writeFileSync(arrayPath, '[]');
    const arrayResult = loadTaskManifest(arrayPath);
    assert.equal(arrayResult.ok, false);
    assert.equal(arrayResult.ok ? '' : arrayResult.code, 'MANIFEST_NOT_OBJECT');
  });

  it('leaves no filesystem effects on rejection', (t) => {
    const tmpRoot = createTempRoot(t, 'task-manifest-effects-');
    const { repoPath, baseCommit } = gitInitRepo(join(tmpRoot, 'repo'));
    const manifest = { ...validManifest(repoPath, baseCommit), extra: true };
    const manifestPath = writeManifest(tmpRoot, manifest);
    const owned = (dir: string): string[] => readdirSync(dir).filter((name) => /^task-manifest-validator-/.test(name)).sort();
    const before = owned(tmpRoot);
    const result = loadTaskManifest(manifestPath);
    assert.equal(result.ok, false);
    assert.deepEqual(owned(tmpRoot), before, 'validator must not create filesystem state');
    assert.equal(existsSync(join(tmpRoot, 'does-not-exist')), false);
    void repoPath;
    void baseCommit;
    rmSync(manifestPath, { force: true });
  });
});
