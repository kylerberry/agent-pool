/**
 * Trusted repository sandbox adapter.
 *
 * The sandbox creation port requires a pinned image (no :latest), non-root
 * execution, no network, no privileged mode/socket, explicit resource limits,
 * cap drop, no-new-privileges, read-only root, closed tmpfs mounts, and a
 * single workspace mount. All four repository tools execute inside the container
 * via the copied broker executable; the host adapters never touch workspace
 * files directly.
 */

import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  resolveSandboxIdentity,
  requireNonRootSandboxIdentity,
  type SandboxIdentity,
} from './sandbox-identity.ts';

export type SandboxProcess = {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly kill: (signal?: NodeJS.Signals) => boolean;
};

export type BrokerResponse =
  | { ok: true; content?: string; exitCode?: number; stdout?: string; stderr?: string }
  | { ok: false; error: string };

export type RepositorySandboxOptions = {
  readonly containerRuntime?: 'docker' | 'podman';
  /** Pinned image ID sha256:<id>. No tag is accepted. */
  readonly image: string;
  /** Actual fixture workspace path on the host. */
  readonly workspacePath: string;
  readonly cpuLimit?: string;
  readonly memoryLimit?: string;
  readonly pidsLimit?: number;
  /** Tool wall-clock timeout in milliseconds. */
  readonly toolTimeoutMs?: number;
  /** Launcher-owned sandbox UID:GID mapping. Resolved from the host when omitted. */
  readonly sandboxIdentity?: SandboxIdentity;
  readonly fake?: SandboxProcess & {
    readonly runTool?: (request: unknown) => Promise<BrokerResponse>;
  };
};

export type RepositorySandbox = {
  /** Run an arbitrary command inside the sandbox (overrides entrypoint). */
  readonly run: (args: readonly string[]) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;
  /** Spawn an arbitrary command inside the sandbox (overrides entrypoint). */
  readonly spawn: (args: readonly string[]) => SandboxProcess;
  /** Execute one tool request through the in-container broker. */
  readonly runTool: (request: unknown) => Promise<BrokerResponse>;
  readonly image: string;
};

type FakeSandbox = NonNullable<RepositorySandboxOptions['fake']>;

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

function isFake(value: unknown): value is FakeSandbox {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as SandboxProcess).pid === 'number' &&
    typeof (value as SandboxProcess).kill === 'function'
  );
}

function runContainerCommand(
  runtime: string,
  baseArgs: readonly string[],
  image: string,
  commandArgs: readonly string[],
  toolTimeoutMs: number,
  brokerRequest?: unknown,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const useDefaultEntrypoint = brokerRequest !== undefined;
    const args = useDefaultEntrypoint
      ? [...baseArgs, image]
      : [...baseArgs, '--entrypoint=', image, ...commandArgs];
    const child = spawn(runtime, args, {
      env: { PATH: '/usr/bin:/bin' },
      stdio: useDefaultEntrypoint ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {}
    }, toolTimeoutMs);
    if (useDefaultEntrypoint) {
      if (child.stdin) {
        child.stdin.write(JSON.stringify(brokerRequest) + '\n');
        child.stdin.end();
      }
    }
    child.stdout?.on('data', (data) => {
      stdout += data;
      if (Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES) {
        stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
        try {
          child.kill('SIGTERM');
        } catch {}
      }
    });
    child.stderr?.on('data', (data) => {
      stderr += data;
      if (Buffer.byteLength(stderr, 'utf8') > MAX_OUTPUT_BYTES) {
        stderr = stderr.slice(0, MAX_OUTPUT_BYTES);
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode: exitCode ?? 1, stdout, stderr, timedOut });
    });
  });
}

export function createRepositorySandbox(options: RepositorySandboxOptions): RepositorySandbox {
  if (!options.image.startsWith('sha256:')) {
    throw new Error('sandbox image must be an explicit sha256:<id> image ID');
  }
  const imageId = options.image.slice('sha256:'.length);
  if (!/^[0-9a-f]{64}$/i.test(imageId)) {
    throw new Error('sandbox image ID must be a 64-character hex sha256 digest');
  }

  if (isFake(options.fake)) {
    const fake = options.fake;
    return {
      image: options.image,
      async run(): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
        return { exitCode: 0, stdout: '', stderr: 'fake-sandbox', timedOut: false };
      },
      spawn(): SandboxProcess {
        return fake;
      },
      async runTool(request: unknown): Promise<BrokerResponse> {
        if (fake.runTool) return fake.runTool(request);
        return { ok: false, error: 'fake sandbox has no runTool handler' };
      },
    };
  }

  const runtimeName = options.containerRuntime ?? 'docker';
  const runtimePath = (() => {
    try {
      return execFileSync('command', ['-v', runtimeName], { encoding: 'utf8', shell: true }).trim();
    } catch {
      throw new Error(`container runtime executable not found: ${runtimeName}`);
    }
  })();
  const image = options.image;
  const toolTimeoutMs = options.toolTimeoutMs ?? 60_000;
  const identity = options.sandboxIdentity ?? resolveSandboxIdentity();
  requireNonRootSandboxIdentity(identity);

  // Exactly one workspace mount; no host HOME, no Docker socket, no Pi runtime.
  const baseArgs = [
    'run',
    '--rm',
    '-i',
    '--network=none',
    '--privileged=false',
    '--security-opt=no-new-privileges',
    '--cap-drop=ALL',
    '--read-only',
    '--user', `${identity.uid}:${identity.gid}`,
    '--tmpfs', '/tmp:noexec,nosuid,size=100m',
    '-v', `${options.workspacePath}:/workspace:rw`,
    '-w', '/workspace',
    '-e', 'HOME=/workspace/.home',
  ];
  if (options.cpuLimit) baseArgs.push('--cpus', options.cpuLimit);
  if (options.memoryLimit) baseArgs.push('--memory', options.memoryLimit);
  if (options.pidsLimit) baseArgs.push('--pids-limit', String(options.pidsLimit));

  return {
    image,
    async run(args): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
      return runContainerCommand(runtimePath, baseArgs, image, args, toolTimeoutMs, false);
    },
    spawn(args): SandboxProcess {
      const child: ChildProcessWithoutNullStreams = spawn(runtimePath, [...baseArgs, '--entrypoint=', image, ...args], {
        env: { PATH: '/usr/bin:/bin' },
      });
      return {
        pid: child.pid ?? 0,
        get exitCode() {
          return child.exitCode;
        },
        kill(signal) {
          return child.kill(signal);
        },
      };
    },
    async runTool(request: unknown): Promise<BrokerResponse> {
      const { exitCode, stdout, stderr, timedOut } = await runContainerCommand(
        runtimePath, baseArgs, image, [], toolTimeoutMs, request,
      );
      if (timedOut) {
        return { ok: false, error: 'sandbox tool timeout' };
      }
      if (exitCode !== 0) {
        return { ok: false, error: `broker exited ${exitCode}: ${stderr || stdout}` };
      }
      try {
        return JSON.parse(stdout) as BrokerResponse;
      } catch {
        return { ok: false, error: `broker malformed response: ${stderr || stdout}` };
      }
    },
  };
}
