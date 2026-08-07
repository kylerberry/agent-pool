/**
 * Resolve and verify real executable/package/profile/image identities for Pool Proof.
 *
 * All identities are pinned. The harness fails closed if any required identity
 * cannot be verified, including a missing or :latest container image.
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, statSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '..', '..');

export type PiIdentity = {
  readonly path: string;
  readonly version: string;
  readonly digest: string;
};

export type PackageIdentity = {
  readonly path: string;
  readonly profile: string;
  readonly digest: string;
};

export type ProfileIdentity = {
  readonly name: string;
  readonly path: string;
  readonly digest: string;
};

export type SandboxImageIdentity = {
  readonly image: string;
  readonly runtime: 'docker' | 'podman';
  readonly verified: boolean;
  readonly reason?: string;
};

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sha256DirectoryText(paths: string[]): string {
  const hash = createHash('sha256');
  for (const path of paths.sort()) {
    // Use a stable relative path framing so the digest is portable across
    // checkout locations. The framing delimiter prevents path-segment collisions.
    const rel = path.replace(repoRoot, '').replace(/^\//, '');
    hash.update(`\x00${rel}\x00`).update(readFileSync(path));
  }
  return hash.digest('hex');
}

function collectFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      result.push(...collectFiles(full));
    } else if (st.isFile()) {
      result.push(full);
    }
  }
  return result;
}

function isRegularNonSymlinkFile(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isFile() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function resolveExecutablePath(path?: string): string | null {
  if (path) {
    try {
      const real = realpathSync(path);
      return real;
    } catch {
      return null;
    }
  }
  const result = spawnSync('command', ['-v', 'pi'], { encoding: 'utf8', shell: true });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  try {
    return realpathSync(result.stdout.trim());
  } catch {
    return null;
  }
}

export function resolvePiIdentity(piPath?: string): PiIdentity | { readonly error: string } {
  const resolved = resolveExecutablePath(piPath);
  if (!resolved || !isRegularNonSymlinkFile(resolved)) {
    return { error: `Pi executable not found or is not a regular file: ${piPath ?? 'pi in PATH'}` };
  }
  const versionResult = spawnSync(resolved, ['--version'], { encoding: 'utf8' });
  if (versionResult.status !== 0) {
    return { error: `Pi --version failed: ${versionResult.stderr || versionResult.stdout}` };
  }
  const version = versionResult.stdout.trim();
  return { path: resolved, version, digest: sha256File(resolved) };
}

export function listPackageIdentityFiles(): string[] {
  const path = resolve(repoRoot, 'packages/worker-harness');
  return Array.from(
    new Set([
      resolve(path, 'package.json'),
      resolve(path, 'Dockerfile'),
      resolve(path, 'scripts/preflight.mjs'),
      ...collectFiles(resolve(path, 'lib')),
      ...collectFiles(resolve(path, 'config')),
      ...collectFiles(resolve(path, 'contracts')),
    ]),
  ).filter(existsSync);
}

export function resolvePackageIdentity(): PackageIdentity {
  const path = resolve(repoRoot, 'packages/worker-harness');
  const files = listPackageIdentityFiles();
  const digest = sha256DirectoryText(files);
  return { path, profile: 'pool-proof-builder', digest };
}

export function listProfileIdentityFiles(): string[] {
  const path = resolve(repoRoot, 'packages/worker-harness/profiles/pool-proof-builder');
  return Array.from(
    new Set([
      resolve(path, 'profile.json'),
      resolve(path, 'settings.json'),
      resolve(path, 'Dockerfile'),
      resolve(path, 'broker.mjs'),
      resolve(path, 'README.md'),
      resolve(path, 'agents/pool-proof-builder.md'),
      resolve(path, 'extensions/trusted-bootstrap.ts'),
      ...collectFiles(resolve(path, 'agents')),
      ...collectFiles(resolve(path, 'extensions')),
    ]),
  ).filter(existsSync);
}

export function resolveProfileIdentity(): ProfileIdentity {
  const path = resolve(repoRoot, 'packages/worker-harness/profiles/pool-proof-builder');
  const files = listProfileIdentityFiles();
  const digest = sha256DirectoryText(files);
  return { name: 'pool-proof-builder', path, digest };
}

export function verifySandboxImage(
  runtime: 'docker' | 'podman',
  image: string,
): SandboxImageIdentity {
  if (image.endsWith(':latest') || image === 'latest' || !image.includes('sha256:')) {
    return { image, runtime, verified: false, reason: 'image reference must be an explicit sha256:<id> image ID' };
  }
  const id = image.replace(/^sha256:/, '');
  if (!/^[0-9a-f]{64}$/i.test(id)) {
    return { image, runtime, verified: false, reason: 'image reference must be a 64-character hex sha256 image ID' };
  }
  const inspectId = spawnSync(runtime, ['image', 'inspect', '--format={{.Id}}', image], { encoding: 'utf8' });
  if (inspectId.status !== 0 || !inspectId.stdout.trim()) {
    return { image, runtime, verified: false, reason: `image not available locally: ${inspectId.stderr || inspectId.stdout}` };
  }
  const inspected = inspectId.stdout.trim();
  if (inspected !== image) {
    return { image, runtime, verified: false, reason: `supplied image reference ${image} does not match inspected ID ${inspected}` };
  }
  const config = spawnSync(runtime, ['image', 'inspect', '--format={{.Config.User}}', image], { encoding: 'utf8' });
  const user = config.stdout.trim();
  if (!user || user === 'root' || user === '0') {
    return { image, runtime, verified: false, reason: 'image must be configured to run as a non-root user' };
  }
  return { image, runtime, verified: true };
}

export function reverifyPiDigest(piPath: string, expectedDigest: string): boolean {
  const identity = resolvePiIdentity(piPath);
  return !('error' in identity) && identity.digest === expectedDigest;
}
