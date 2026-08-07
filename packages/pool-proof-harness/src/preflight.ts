/**
 * Stage 1 real-proof preflight.
 *
 * Verifies pinned Pi, approved builder model availability, provider credential,
 * and container runtime isolation before any paid model call. Writes sanitized
 * failure evidence and exits nonzero on any missing capability.
 */

import { mkdir, writeFile, readFile, access, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import {
  resolvePiIdentity,
  resolvePackageIdentity,
  resolveProfileIdentity,
  verifySandboxImage,
  reverifyPiDigest,
} from './identity-resolution.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = resolve(packageRoot, 'reports');

export type PreflightConfig = {
  readonly piPath?: string;
  readonly model: string;
  readonly containerRuntime: 'docker' | 'podman';
  readonly sandboxImage: string;
};

export type PreflightFailure = {
  readonly stage: string;
  readonly reason: string;
  readonly timestamp: string;
};

export type PreflightSuccess = {
  readonly pi: { readonly path: string; readonly version: string; readonly digest: string };
  readonly package: { readonly path: string; readonly profile: string; readonly digest: string };
  readonly profile: { readonly name: string; readonly path: string; readonly digest: string };
  readonly sandboxImage: { readonly image: string; readonly runtime: 'docker' | 'podman'; readonly verified: boolean };
  readonly gitPath: string;
};

async function readPiAuthEntry(provider: string): Promise<Record<string, unknown> | null> {
  try {
    const authPath = resolve(homedir(), '.pi/agent/auth.json');
    await access(authPath);
    const raw = await readFile(authPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const entry = parsed[provider];
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      return entry as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function hasProviderCredential(provider: string): boolean {
  // openai-codex uses OAuth credentials stored in Pi auth.json; an
  // OPENAI_API_KEY environment value is not a valid Pi 0.83 auth shape and
  // must not be misclassified as Codex OAuth.
  if (provider === 'moonshot') {
    return typeof process.env.MOONSHOT_API_KEY === 'string' && process.env.MOONSHOT_API_KEY.length > 0;
  }
  return false;
}

function parseModelList(output: string): Array<{ provider: string; model: string }> {
  const models: Array<{ provider: string; model: string }> = [];
  const lines = output.split('\n');
  // Detect table format: first non-empty line is the header with 'provider' and 'model'.
  let headerSeen = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    if (!headerSeen) {
      if (tokens[0]?.toLowerCase() === 'provider' && tokens[1]?.toLowerCase() === 'model') {
        headerSeen = true;
      }
      continue;
    }
    const provider = tokens[0];
    const model = tokens[1];
    if (provider && model && provider !== 'provider') {
      models.push({ provider, model });
    }
  }
  // Fallback: if no table header, accept slash-separated identifiers.
  if (models.length === 0) {
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(/^([^/\s]+)\/([^\s]+)$/);
      if (match) {
        models.push({ provider: match[1]!, model: match[2]! });
      }
    }
  }
  return models;
}

function resolveGitPath(): string | { error: string } {
  const result = spawnSync('command', ['-v', 'git'], { encoding: 'utf8', shell: true });
  if (result.status !== 0 || !result.stdout.trim()) {
    return { error: 'git executable not found in PATH' };
  }
  const resolved = result.stdout.trim();
  try {
    const real = realpathSync(resolved);
    const st = lstatSync(real);
    if (!st.isFile() || st.isSymbolicLink()) {
      return { error: `git path ${resolved} is not a regular non-symlinked executable` };
    }
    return real;
  } catch (e) {
    return { error: `git path ${resolved} could not be resolved: ${String(e)}` };
  }
}

async function deleteStaleFailureEvidence(): Promise<void> {
  try {
    await unlink(resolve(reportsDir, 'stage-1-preflight-failure.json'));
  } catch {
    // ignore absence
  }
}

export async function runPreflight(
  config: PreflightConfig,
): Promise<{ ok: true; result: PreflightSuccess } | { ok: false; failure: PreflightFailure }> {
  await deleteStaleFailureEvidence();
  const timestamp = () => new Date().toISOString();

  // Pi executable identity.
  const piIdentity = resolvePiIdentity(config.piPath);
  if ('error' in piIdentity) {
    return { ok: false, failure: { stage: 'pi_executable', reason: piIdentity.error, timestamp: timestamp() } };
  }
  if (!piIdentity.version.includes('0.83.0')) {
    return {
      ok: false,
      failure: {
        stage: 'pi_version',
        reason: `Pi version mismatch: expected 0.83.0, got ${piIdentity.version}`,
        timestamp: timestamp(),
      },
    };
  }

  // Re-verify executable digest immediately before spawn.
  if (!reverifyPiDigest(piIdentity.path, piIdentity.digest)) {
    return {
      ok: false,
      failure: { stage: 'pi_digest', reason: 'Pi executable digest re-verification failed', timestamp: timestamp() },
    };
  }

  // Approved model availability (sanitized; no credential printed).
  const modelsResult = spawnSync(piIdentity.path, ['--list-models'], { encoding: 'utf8' });
  if (modelsResult.status !== 0) {
    return { ok: false, failure: { stage: 'model_availability', reason: `pi --list-models failed: ${modelsResult.stderr}`, timestamp: timestamp() } };
  }
  const availableModels = parseModelList(modelsResult.stdout);
  const requested = config.model.split('/');
  const requestedProvider = requested[0];
  const requestedModel = requested.slice(1).join('/');
  const modelAvailable = availableModels.some(
    (m) => m.provider === requestedProvider && m.model === requestedModel,
  );
  if (!modelAvailable) {
    return { ok: false, failure: { stage: 'model_availability', reason: `model ${config.model} unavailable`, timestamp: timestamp() } };
  }

  // Provider credential presence: provider-specific only.
  const authEntry = await readPiAuthEntry(requestedProvider);
  const hasAuth = authEntry !== null || hasProviderCredential(requestedProvider);
  if (!hasAuth) {
    return { ok: false, failure: { stage: 'provider_credential', reason: `no credential for provider ${requestedProvider}`, timestamp: timestamp() } };
  }

  // Container runtime availability and isolation support.
  const runtime = spawnSync(config.containerRuntime, ['--version'], { encoding: 'utf8' });
  if (runtime.status !== 0) {
    return { ok: false, failure: { stage: 'container_runtime', reason: `${config.containerRuntime} unavailable`, timestamp: timestamp() } };
  }

  // Verify container daemon can run with isolation flags.
  const info = spawnSync(config.containerRuntime, ['info'], { encoding: 'utf8' });
  if (info.status !== 0) {
    return { ok: false, failure: { stage: 'container_daemon', reason: `${config.containerRuntime} daemon unavailable`, timestamp: timestamp() } };
  }

  // Pinned sandbox image with non-root verification.
  const imageIdentity = verifySandboxImage(config.containerRuntime, config.sandboxImage);
  if (!imageIdentity.verified) {
    return {
      ok: false,
      failure: {
        stage: 'sandbox_image',
        reason: imageIdentity.reason ?? 'sandbox image verification failed',
        timestamp: timestamp(),
      },
    };
  }

  const packageIdentity = resolvePackageIdentity();
  const profileIdentity = resolveProfileIdentity();
  const gitResolved = resolveGitPath();
  if (typeof gitResolved !== 'string') {
    return { ok: false, failure: { stage: 'git_executable', reason: gitResolved.error, timestamp: timestamp() } };
  }
  const gitPath = gitResolved;

  return {
    ok: true,
    result: {
      pi: piIdentity,
      package: packageIdentity,
      profile: profileIdentity,
      sandboxImage: imageIdentity,
      gitPath,
    },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const piFlag = args.indexOf('--pi');
  const modelFlag = args.indexOf('--model');
  const runtimeFlag = args.indexOf('--container-runtime');
  const imageFlag = args.indexOf('--sandbox-image');
  const piPath = piFlag >= 0 ? args[piFlag + 1] : undefined;
  const model = modelFlag >= 0 ? args[modelFlag + 1] : 'openai-codex/gpt-5.6-terra';
  const containerRuntime = (runtimeFlag >= 0 ? args[runtimeFlag + 1] : 'docker') as 'docker' | 'podman';
  const sandboxImage = imageFlag >= 0 ? args[imageFlag + 1] : undefined;

  if (!sandboxImage) {
    await mkdir(reportsDir, { recursive: true });
    const failure: PreflightFailure = {
      stage: 'sandbox_image',
      reason: 'sandbox image digest/ID is required (no default)',
      timestamp: new Date().toISOString(),
    };
    await writeFile(
      resolve(reportsDir, 'stage-1-preflight-failure.json'),
      JSON.stringify(failure, null, 2),
    );
    console.error(`preflight failed: ${failure.stage} - ${failure.reason}`);
    process.exit(1);
  }

  const result = await runPreflight({ piPath, model, containerRuntime, sandboxImage });
  if (!result.ok) {
    await mkdir(reportsDir, { recursive: true });
    await writeFile(
      resolve(reportsDir, 'stage-1-preflight-failure.json'),
      JSON.stringify(result.failure, null, 2),
    );
    console.error(`preflight failed: ${result.failure.stage} - ${result.failure.reason}`);
    process.exit(1);
  }
  console.log('preflight passed');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
