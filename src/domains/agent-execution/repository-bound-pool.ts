import { lstatSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import { isApprovedModelId, type ApprovedModelId } from '../model-routing-and-evaluation/approved-models.ts';
import { deepFreeze, isPlainObject } from './contracts.ts';

export type RepositoryBoundPoolConfig = {
  readonly poolHome: string;
  readonly runtimeRoot: string;
  readonly repositoryRoot: string;
  /** Persistent host-owned checkout used to surface review output; may be repositoryRoot itself. */
  readonly persistentReviewCheckout: string;
  readonly baseRef: string;
  readonly allowedChangedPaths: readonly string[];
  readonly verificationCommands: readonly (readonly string[])[];
  readonly model: ApprovedModelId;
  readonly bounds: {
    readonly verificationTimeoutSeconds: number;
    readonly launchTimeoutSeconds: number;
  };
};

export type RepositoryBoundTaskContent = {
  readonly taskId: string;
  readonly intent: string;
  readonly changeSpec: string;
  readonly acceptanceCriteria: readonly { readonly id: string; readonly text: string }[];
};

export type RepositoryBoundExecution = Readonly<RepositoryBoundPoolConfig & {
  readonly baseCommit: string;
  readonly task: RepositoryBoundTaskContent;
}>;

const CREDENTIAL = /(?:token|secret|password|credential|api[_-]?key|github|openai|moonshot|zai)/i;
const REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const SHA = /^[0-9a-f]{40}$/;
const inside = (root: string, child: string) => {
  const r = relative(root, child);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};
function fail(message: string): never { throw new Error(`REPOSITORY_BOUND_POOL_INVALID: ${message}`); }
function privateDirectory(value: unknown, name: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) fail(`${name} must be an absolute directory`);
  let real: string; let stat: ReturnType<typeof statSync>;
  try { if (lstatSync(value).isSymbolicLink()) fail(`${name} must not be a symlink`); real = realpathSync(value); stat = statSync(real); } catch { fail(`${name} is not accessible`); }
  if (!stat!.isDirectory() || stat!.uid !== process.getuid?.() || (stat!.mode & 0o077) !== 0) fail(`${name} must be a private owner-only directory`);
  return real!;
}
function boundedText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.includes('\0')) fail(`${name} is invalid`);
  return value;
}
function strictKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key) || CREDENTIAL.test(key)) fail(`${name} contains an unsupported field`);
  for (const key of keys) if (!(key in value)) fail(`${name} is incomplete`);
}
function paths(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) fail('allowedChangedPaths is invalid');
  return value.map((item) => {
    const path = boundedText(item, 'allowedChangedPaths entry', 512);
    if (path.startsWith('/') || path.split('/').some((part) => part === '..' || part === '.git')) fail('allowedChangedPaths entry is invalid');
    return path;
  });
}
function commands(value: unknown): readonly (readonly string[])[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) fail('verificationCommands is invalid');
  return value.map((argv) => {
    if (!Array.isArray(argv) || argv.length < 1 || argv.length > 8) fail('verificationCommands entry is invalid');
    const checked = argv.map((item) => boundedText(item, 'verificationCommands argument', 256));
    if (checked[0]!.includes('/') || checked.some((item) => item.includes('\n') || item.includes('\r'))) fail('verificationCommands entry is invalid');
    return checked;
  });
}

/** Validates owner-supplied programmatic startup data; it never reads a config file. */
export function createRepositoryBoundPool(raw: unknown, gitTopLevel: (repositoryRoot: string) => string): RepositoryBoundPoolConfig {
  if (!isPlainObject(raw)) fail('config must be an object');
  strictKeys(raw, ['poolHome', 'runtimeRoot', 'repositoryRoot', 'persistentReviewCheckout', 'baseRef', 'allowedChangedPaths', 'verificationCommands', 'model', 'bounds'], 'config');
  const poolHome = privateDirectory(raw.poolHome, 'poolHome');
  const runtimeRoot = privateDirectory(raw.runtimeRoot, 'runtimeRoot');
  if (runtimeRoot === poolHome || !inside(poolHome, runtimeRoot)) fail('runtimeRoot must be a strict poolHome descendant');
  const repositoryRoot = privateDirectory(raw.repositoryRoot, 'repositoryRoot');
  const persistentReviewCheckout = privateDirectory(raw.persistentReviewCheckout, 'persistentReviewCheckout');
  let topLevel: string;
  try { topLevel = resolve(gitTopLevel(repositoryRoot)); } catch { fail('repositoryRoot is not a Git worktree'); }
  if (topLevel !== repositoryRoot) fail('repositoryRoot must be the canonical Git top-level');
  if (persistentReviewCheckout !== repositoryRoot) {
    let reviewTopLevel: string;
    try { reviewTopLevel = resolve(gitTopLevel(persistentReviewCheckout)); } catch { fail('persistentReviewCheckout is not a Git worktree'); }
    if (reviewTopLevel !== persistentReviewCheckout) fail('persistentReviewCheckout must be the canonical Git top-level');
    if (inside(repositoryRoot, persistentReviewCheckout) || inside(persistentReviewCheckout, repositoryRoot)) fail('persistentReviewCheckout and repositoryRoot must be disjoint when distinct');
  }
  if (inside(repositoryRoot, poolHome) || inside(poolHome, repositoryRoot) || inside(repositoryRoot, runtimeRoot)) fail('repositoryRoot and pool storage must be disjoint');
  if (inside(persistentReviewCheckout, poolHome) || inside(poolHome, persistentReviewCheckout) || inside(persistentReviewCheckout, runtimeRoot) || inside(runtimeRoot, persistentReviewCheckout)) fail('persistentReviewCheckout and pool storage must be disjoint');
  if (typeof raw.baseRef !== 'string' || !REF.test(raw.baseRef)) fail('baseRef must be a restricted local branch ref');
  if (!isApprovedModelId(raw.model)) fail('model is not approved');
  if (!isPlainObject(raw.bounds)) fail('bounds is invalid');
  strictKeys(raw.bounds, ['verificationTimeoutSeconds', 'launchTimeoutSeconds'], 'bounds');
  const verificationTimeoutSeconds = raw.bounds.verificationTimeoutSeconds;
  const launchTimeoutSeconds = raw.bounds.launchTimeoutSeconds;
  if (typeof verificationTimeoutSeconds !== 'number' || !Number.isInteger(verificationTimeoutSeconds) || verificationTimeoutSeconds < 60 || verificationTimeoutSeconds > 900) fail('verificationTimeoutSeconds is invalid');
  if (typeof launchTimeoutSeconds !== 'number' || !Number.isInteger(launchTimeoutSeconds) || launchTimeoutSeconds < 60 || launchTimeoutSeconds > 900) fail('launchTimeoutSeconds is invalid');
  return deepFreeze({ poolHome, runtimeRoot, repositoryRoot, persistentReviewCheckout, baseRef: raw.baseRef, allowedChangedPaths: paths(raw.allowedChangedPaths), verificationCommands: commands(raw.verificationCommands), model: raw.model, bounds: { verificationTimeoutSeconds, launchTimeoutSeconds } });
}

export function createRepositoryBoundTaskContent(raw: unknown): RepositoryBoundTaskContent {
  if (!isPlainObject(raw)) fail('task content must be an object');
  strictKeys(raw, ['taskId', 'intent', 'changeSpec', 'acceptanceCriteria'], 'task content');
  if (!Array.isArray(raw.acceptanceCriteria) || raw.acceptanceCriteria.length < 1 || raw.acceptanceCriteria.length > 8) fail('acceptanceCriteria is invalid');
  const ids = new Set<string>();
  const acceptanceCriteria = raw.acceptanceCriteria.map((item) => {
    if (!isPlainObject(item)) fail('acceptanceCriteria entry is invalid');
    strictKeys(item, ['id', 'text'], 'acceptanceCriteria entry');
    const id = boundedText(item.id, 'criterion id', 128); const text = boundedText(item.text, 'criterion text', 1024);
    if (ids.has(id)) fail('criterion ids must be unique'); ids.add(id); return { id, text };
  });
  return deepFreeze({ taskId: boundedText(raw.taskId, 'taskId', 128), intent: boundedText(raw.intent, 'intent', 2048), changeSpec: boundedText(raw.changeSpec, 'changeSpec', 8192), acceptanceCriteria });
}

/** The resolver is the harness-owned hardened Git adapter; only its SHA result crosses this boundary. */
export function createRepositoryBoundExecution(pool: RepositoryBoundPoolConfig, task: RepositoryBoundTaskContent, resolveBaseCommit: (repositoryRoot: string, baseRef: string) => string): RepositoryBoundExecution {
  const commit = resolveBaseCommit(pool.repositoryRoot, pool.baseRef);
  if (typeof commit !== 'string' || !SHA.test(commit)) fail('baseRef did not resolve to an immutable commit');
  return deepFreeze({ ...pool, baseCommit: commit, task });
}
