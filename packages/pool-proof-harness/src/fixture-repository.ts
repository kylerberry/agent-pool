/**
 * Deterministic fixture repository initialization.
 *
 * Creates a fresh local Git repository from the pinned fixture content, with a
 * reproducible base commit so the red/green transition can be verified.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export type FixtureManifest = {
  readonly schema_version: number;
  readonly fixture_name: string;
  readonly base_commit_author: string;
  readonly base_commit_message: string;
  readonly allowed_changed_paths: readonly string[];
  readonly fixture_test_command: readonly string[];
};

export type InitializedFixture = {
  readonly manifest: FixtureManifest;
  readonly fixturePath: string;
  readonly baseCommit: string;
};

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureSource = join(packageRoot, 'fixtures', 'single-worker');

export function loadFixtureManifest(): FixtureManifest {
  return JSON.parse(readFileSync(join(fixtureSource, 'fixture-manifest.json'), 'utf8')) as FixtureManifest;
}

export function initializeFixtureRepository(targetPath: string): InitializedFixture {
  if (existsSync(targetPath)) {
    rmSync(targetPath, { recursive: true, force: true });
  }
  mkdirSync(targetPath, { recursive: true });
  cpSync(fixtureSource, targetPath, { recursive: true, filter: (src) => !/(?:^|\/)\.git(?:\/|$)/.test(src) });

  const manifest = loadFixtureManifest();
  const git = (args: readonly string[]) =>
    spawnSync('git', args, {
      cwd: targetPath,
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        GIT_AUTHOR_NAME: manifest.base_commit_author.split('<')[0].trim(),
        GIT_AUTHOR_EMAIL: manifest.base_commit_author.match(/<([^>]+)>/)?.[1] ?? 'proof@agent-pool.local',
        GIT_COMMITTER_NAME: manifest.base_commit_author.split('<')[0].trim(),
        GIT_COMMITTER_EMAIL: manifest.base_commit_author.match(/<([^>]+)>/)?.[1] ?? 'proof@agent-pool.local',
      },
    });

  git(['init']);
  git(['config', 'user.name', manifest.base_commit_author.split('<')[0].trim()]);
  git(['config', 'user.email', manifest.base_commit_author.match(/<([^>]+)>/)?.[1] ?? 'proof@agent-pool.local']);
  git(['add', '.']);
  const commit = git(['commit', '-m', manifest.base_commit_message, '--date', '2026-08-05T00:00:00Z']);
  if (commit.status !== 0) {
    throw new Error(`fixture base commit failed: ${commit.stderr}`);
  }

  const baseCommit = git(['rev-parse', 'HEAD']).stdout.trim();
  return { manifest, fixturePath: targetPath, baseCommit };
}
