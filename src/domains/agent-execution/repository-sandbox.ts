/**
 * Trusted persistent repository sandbox adapter.
 *
 * One fresh, internally owned repository sandbox container is created when the
 * sandbox starts, before the broker accepts any request. All runTool calls
 * reuse that same long-lived in-container supervisor. The container is never
 * reused by another attempt, capacity slot, or Pi session. Teardown is
 * idempotent and removes only the internally owned, validated container
 * identity via direct runtime argv — no host shell, no caller target.
 *
 * Security posture (enforced as direct runtime argv, asserted by tests and the
 * real-Docker proof): pinned sha256 image, non-root UID, network none,
 * privileged false, no host Docker socket, no added capabilities,
 * no-new-privileges, read-only root filesystem, explicit CPU/memory/PID/time
 * limits, exactly one workspace rw mount, and a minimal runtime environment.
 */

import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import {
  resolveSandboxIdentity,
  requireNonRootSandboxIdentity,
  type SandboxIdentity,
} from './sandbox-identity.ts';

export type BrokerResponse =
  | { ok: true; content?: string; exitCode?: number; stdout?: string; stderr?: string }
  | { ok: false; error: string };

export type RunToolOptions = {
  /** Client cancellation; aborting terminates the owned in-container command. */
  readonly signal?: AbortSignal;
};

export type RepositorySandbox = {
  readonly image: string;
  /** Create the owned persistent container and await supervisor readiness. */
  start(): Promise<void>;
  /** Execute one tool request through the persistent in-container supervisor. */
  runTool(request: unknown, options?: RunToolOptions): Promise<BrokerResponse>;
  /** Idempotently tear down the owned container. */
  stop(): Promise<void>;
};

export type RepositorySandboxOptions = {
  readonly containerRuntime?: 'docker' | 'podman';
  /** Pinned image ID sha256:<id>. No tag is accepted. */
  readonly image: string;
  /** Actual fixture workspace path on the host. */
  readonly workspacePath: string;
  readonly cpuLimit?: string;
  readonly memoryLimit?: string;
  readonly pidsLimit?: number;
  /** Per-command wall-clock timeout in milliseconds. */
  readonly toolTimeoutMs?: number;
  /** Bounded wait for orderly shutdown before forced removal (default 15s). */
  readonly shutdownGraceMs?: number;
  /** Launcher-owned sandbox UID:GID mapping. */
  readonly sandboxIdentity?: SandboxIdentity;
  /** Container driver. Defaults to the real Docker/Podman driver. */
  readonly driver?: ContainerDriver;
  /**
   * Optional launcher/proof-owned additional ownership label (validated
   * key=value) appended to the container so a proof run can count and clean up
   * ONLY its own containers, never peers that carry the generic ownership
   * label. The generic io.agent-pool.owned=true label always remains for
   * operational discovery. This is validated metadata passed as direct argv;
   * it is never a caller-selected container target.
   */
  readonly proofOwnershipLabel?: { readonly key: string; readonly value: string };
};

// ---------------------------------------------------------------------------
// Container driver abstraction
// ---------------------------------------------------------------------------

export type PersistentContainerChild = {
  readonly pid: number;
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals): boolean;
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

export type SpawnPersistentInput = {
  readonly runtimeArgs: readonly string[];
  readonly runtimeEnv: NodeJS.ProcessEnv;
  readonly cidfile: string;
};

export type ContainerDriver = {
  readonly runtimePath: string;
  spawnPersistent(input: SpawnPersistentInput): PersistentContainerChild;
  /** Remove the owned container by validated id via direct argv (idempotent). */
  removeContainer(containerId: string): Promise<{ ok: boolean; error?: string }>;
};

const CONTAINER_ID_RE = /^[0-9a-f]{6,64}$/i;

function assertOwnedContainerId(id: string): void {
  if (typeof id !== 'string' || !CONTAINER_ID_RE.test(id)) {
    throw new Error(`rejected non-owned/malformed container identity: ${String(id).slice(0, 16)}`);
  }
}

// Strict label-key/value patterns for the optional proof ownership label. The
// label is launcher/harness-owned validated metadata passed as a direct argv
// --label; hostile values are rejected so they can never become a runtime flag
// or arbitrary container target.
const LABEL_KEY_RE = /^[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)?$/i;
const LABEL_VALUE_RE = /^[a-zA-Z0-9._=-]+$/;
function assertValidProofLabel(label: { readonly key: string; readonly value: string }): void {
  if (
    typeof label.key !== 'string' || typeof label.value !== 'string' ||
    label.key.length === 0 || label.key.length > 128 ||
    label.value.length === 0 || label.value.length > 128 ||
    !LABEL_KEY_RE.test(label.key) || !LABEL_VALUE_RE.test(label.value)
  ) {
    throw new Error('rejected invalid proof ownership label (validated metadata only)');
  }
}

/**
 * Resolve the container runtime executable WITHOUT spawning a host shell.
 * Searches PATH directly for an executable named `name`, accepting the first
 * match with an executable bit, then realpaths it. This avoids any
 * `command -v`/`which` shell interpolation and lets tests inject PATH.
 */
export function resolveRuntimeExecutable(name: 'docker' | 'podman', pathEnv: string = process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin'): string {
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // not present/executable in this dir; continue
    }
  }
  throw new Error(`container runtime executable not found in PATH: ${name}`);
}

export type PersistentDriverOptions = {
  readonly containerRuntime: 'docker' | 'podman';
  /** Test seam: skip runtime resolution and use this exact path. */
  readonly resolvedRuntimePath?: string;
  /** Test seam: inject a removal implementation. */
  readonly removeRunner?: (containerId: string) => Promise<{ ok: boolean; error?: string }>;
};

export function createPersistentContainerDriver(options: PersistentDriverOptions): ContainerDriver {
  const runtimePath =
    options.resolvedRuntimePath ??
    resolveRuntimeExecutable(options.containerRuntime);

  return {
    runtimePath,
    spawnPersistent(input: SpawnPersistentInput): PersistentContainerChild {
      const child: ChildProcessWithoutNullStreams = spawn(runtimePath, input.runtimeArgs as string[], {
        env: input.runtimeEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
        child.on('exit', (code, signal) => resolveExit({ code, signal: signal ?? null }));
        child.on('error', () => resolveExit({ code: null, signal: null }));
      });
      return {
        pid: child.pid ?? 0,
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        kill: (signal) => child.kill(signal),
        exit,
      };
    },
    async removeContainer(containerId: string): Promise<{ ok: boolean; error?: string }> {
      assertOwnedContainerId(containerId);
      if (options.removeRunner) return options.removeRunner(containerId);
      try {
        execFileSync(runtimePath, ['rm', '-f', containerId], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { PATH: '/usr/bin:/bin' },
        });
        return { ok: true };
      } catch (e) {
        // Idempotent: a missing container is success. Other failures are surfaced.
        const msg = e instanceof Error ? e.message : String(e);
        if (/no such|not found|not exist/i.test(msg)) return { ok: true };
        return { ok: false, error: msg };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Fake driver (in-process supervisor over loopback streams) for unit tests
// ---------------------------------------------------------------------------

// A stdout that delivers a pre-arrived readiness frame the instant the host
// attaches its 'data' listener, reproducing the fast-real-supervisor race in
// which a readiness frame is parsed before the readiness resolver is bound.
// Subsequent writes (tool responses) flow through the underlying PassThrough.
class FastReadyStdout extends PassThrough {
  private fastReadyFlushed = false;
  private readonly fastReadyFrame: string;
  constructor(fastReadyFrame: string) {
    super();
    this.fastReadyFrame = fastReadyFrame;
  }
  public on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    if (event === 'data' && !this.fastReadyFlushed) {
      this.fastReadyFlushed = true;
      try { listener(this.fastReadyFrame); } catch {}
    }
    return this;
  }
}

export type FakeSupervisorHandlers = {
  onCommandStart?: () => void;
  onCommandEnd?: () => void;
};

export type FakeDriverOptions = {
  /** Delay bash responses indefinitely (until cancel/timeout/kill). */
  readonly hangMs?: number;
  /** Simulate container death on the Nth tool request. */
  readonly exitOnNthRequest?: number;
  /** Emit one unmatched response frame immediately before the selected real response. */
  readonly staleResponseBeforeNthRequest?: {
    readonly requestNumber: number;
    readonly id: string;
    readonly response: BrokerResponse;
  };
  /** Ignore shutdown frames so forced removal is exercised. */
  readonly ignoreShutdown?: boolean;
  /** spawnPersistent() throws synchronously (runtime missing / spawn error). */
  readonly failSpawn?: boolean;
  /** Spawn succeeds (cidfile written) but the supervisor dies before readiness. */
  readonly neverReady?: boolean;
  /** Spawn succeeds (cidfile written) but readiness never arrives and streams stay open. */
  readonly blockReady?: boolean;
  /** removeContainer() rejects with a bounded error (forced-removal failure). */
  readonly removeRejects?: boolean;
  /**
   * Deliver the readiness frame SYNCHRONOUSLY at the moment the host attaches
   * its stdout 'data' listener (simulating a fast real supervisor whose
   * readiness has already arrived over the pipe when the host first attaches),
   * reproducing the readiness-parsed-before-resolver-bound race.
   */
  readonly fastReady?: boolean;
};

type FakeSession = {
  readonly requestFrames: unknown[];
  onCommandStart?: () => void;
  onCommandEnd?: () => void;
};

export type FakeContainerDriver = ContainerDriver & {
  readonly spawnCount: number;
  readonly lastSpawnArgs: readonly string[];
  readonly lastContainerId: string;
  readonly removedIds: readonly string[];
  readonly sessions: readonly FakeSession[];
};

export function createFakePersistentContainerDriver(opts: FakeDriverOptions = {}): FakeContainerDriver {
  let spawnCount = 0;
  let lastSpawnArgs: string[] = [];
  let lastContainerId = '';
  const removedIds: string[] = [];
  const sessions: FakeSession[] = [];

  function newContainerId(): string {
    // Validated 64-hex id unique per spawn AND per driver instance, so two
    // concurrent driver instances never produce colliding owned ids.
    const seed = (spawnCount + 1).toString(16).padStart(6, '0');
    const rand = Math.random().toString(16).slice(2).padEnd(58, '0').slice(0, 58);
    return (seed + rand).slice(0, 64);
  }

  const driver: FakeContainerDriver = {
    runtimePath: '/usr/local/bin/docker-fake',
    spawnCount: 0 as number,
    lastSpawnArgs: [] as readonly string[],
    lastContainerId: '' as string,
    removedIds: [] as readonly string[],
    sessions: sessions as readonly FakeSession[],
    spawnPersistent(input: SpawnPersistentInput): PersistentContainerChild {
      if (opts.failSpawn) {
        throw new Error('fake container runtime not found (spawn error)');
      }
      spawnCount += 1;
      lastSpawnArgs = [...input.runtimeArgs];
      lastContainerId = newContainerId();
      // Write the fake cidfile so the host can read the owned id.
      try {
        mkdirSync(input.cidfile.replace(/[/][^/]+$/, ''), { recursive: true });
        writeFileSync(input.cidfile, lastContainerId, { mode: 0o600 });
      } catch {
        // best-effort
      }

      const stdin = new PassThrough();
      const stdout = opts.fastReady
        ? new FastReadyStdout(JSON.stringify({ ready: true, pid: spawnCount }) + '\n')
        : new PassThrough();
      const stderr = new PassThrough();
      let killed = false;
      let exiting = false;

      const session: FakeSession & { onCommandStart?: () => void; onCommandEnd?: () => void } = {
        requestFrames: [],
        onCommandStart: undefined,
        onCommandEnd: undefined,
      };
      sessions.push(session);

      const hanging = new Set<() => void>();
      const wakeAll = () => { for (const w of [...hanging]) { try { w(); } catch {} } hanging.clear(); };

      let buffer = '';
      let toolCount = 0;
      let shuttingDown = false;

      function emitReady() {
        if (opts.neverReady) {
          // Supervisor died before reporting readiness: end streams so the
          // host sees EOF and settles the readiness wait boundedly.
          doShutdown(0);
          return;
        }
        if (opts.blockReady) {
          // Readiness never arrives and streams stay open; only an external
          // stop (which cancels the start readiness race) settles the sandbox.
          return;
        }
        stdout.write(JSON.stringify({ ready: true, pid: spawnCount }) + '\n');
      }

      async function handleLine(line: string) {
        if (shuttingDown) return;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(line) as Record<string, unknown>;
        } catch {
          stdout.write(JSON.stringify({ id: null, ok: false, error: 'malformed frame' }) + '\n');
          return;
        }
        if ('control' in frame) {
          if (frame.control === 'shutdown') {
            if (!opts.ignoreShutdown) {
              stdout.write(JSON.stringify({ id: frame.id ?? null, ok: true, control: 'shutdown' }) + '\n');
              doShutdown(0);
            }
            return;
          }
          if (frame.control === 'cancel') {
            wakeAll();
            stdout.write(JSON.stringify({ id: frame.id ?? null, ok: false, error: 'cancelled', cancelled: true }) + '\n');
            return;
          }
          stdout.write(JSON.stringify({ id: frame.id ?? null, ok: false, error: 'unknown control' }) + '\n');
          return;
        }
        session.requestFrames.push(frame);
        const id = typeof frame.id === 'string' ? frame.id : null;
        const tool = frame.tool;
        toolCount += 1;
        if (opts.exitOnNthRequest !== undefined && toolCount === opts.exitOnNthRequest) {
          // Container dies mid-request.
          doShutdown(0);
          return;
        }
        if (tool === 'bash' && opts.hangMs) {
          session.onCommandStart?.();
          const w = new Promise<void>((resolveHang) => {
            hanging.add(resolveHang);
            setTimeout(resolveHang, opts.hangMs);
          });
          await w;
          session.onCommandEnd?.();
          // If we got here via cancel/timeout, the host already gave up; settle silently.
          stdout.write(JSON.stringify({ id, ok: false, error: 'cancelled', cancelled: true }) + '\n');
          return;
        }
        session.onCommandStart?.();
        let resp: Record<string, unknown>;
        switch (tool) {
          case 'read': resp = { id, ok: true, content: `fake-read:${String(frame.path ?? '')}` }; break;
          case 'write': resp = { id, ok: true }; break;
          case 'edit': resp = { id, ok: true }; break;
          case 'bash': resp = { id, ok: true, exitCode: 0, stdout: `fake-bash:${String(frame.command ?? '')}`, stderr: '' }; break;
          default: resp = { id, ok: false, error: 'unknown tool' };
        }
        session.onCommandEnd?.();
        if (opts.staleResponseBeforeNthRequest?.requestNumber === toolCount) {
          stdout.write(JSON.stringify({ id: opts.staleResponseBeforeNthRequest.id, ...opts.staleResponseBeforeNthRequest.response }) + '\n');
        }
        stdout.write(JSON.stringify(resp) + '\n');
      }

      function doShutdown(code: number) {
        if (shuttingDown || exiting) return;
        shuttingDown = true;
        exiting = true;
        wakeAll();
        // Flush then end the streams so the host sees EOF.
        setImmediate(() => {
          try { stdin.end(); } catch {}
          try { stdout.end(); } catch {}
          try { stderr.end(); } catch {}
        });
      }

      stdin.on('data', (chunk: Buffer | string) => {
        if (shuttingDown) return;
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (line.length > 0) void handleLine(line);
        }
      });
      stdin.on('end', () => doShutdown(0));
      stdin.on('error', () => doShutdown(1));

      // Readiness is emitted asynchronously so the host's read loop attaches
      // first, unless fastReady delivers it synchronously on attach.
      if (!opts.fastReady) setImmediate(emitReady);

      const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
        const finish = () => resolveExit({ code: killed ? 137 : 0, signal: killed ? 'SIGKILL' : null });
        stdout.on('end', finish);
        stdout.on('close', finish);
      });

      return {
        pid: 1000 + spawnCount,
        stdin,
        stdout,
        stderr,
        kill: (signal) => { killed = true; wakeAll(); try { stdin.destroy(); } catch {} try { stdout.destroy(); } catch {} try { stderr.destroy(); } catch {} return true; },
        exit,
      };
    },
    async removeContainer(containerId: string): Promise<{ ok: boolean; error?: string }> {
      assertOwnedContainerId(containerId);
      if (opts.removeRejects) {
        return { ok: false, error: 'fake forced removal failed' };
      }
      removedIds.push(containerId);
      return { ok: true };
    },
  };

  // Expose live getters via Object.defineProperty so the snapshot fields reflect mutations.
  Object.defineProperties(driver, {
    spawnCount: { get: () => spawnCount },
    lastSpawnArgs: { get: () => lastSpawnArgs },
    lastContainerId: { get: () => lastContainerId },
    removedIds: { get: () => removedIds },
    sessions: { get: () => sessions },
  });

  return driver;
}

// ---------------------------------------------------------------------------
// Persistent sandbox implementation
// ---------------------------------------------------------------------------

type SandboxState = 'created' | 'starting' | 'started' | 'stopping' | 'stopped' | 'terminal';

const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 15_000;
const READINESS_TIMEOUT_MS = 30_000;
const CANCEL_GRACE_MS = 2_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

type Waiter = {
  readonly id: string;
  readonly resolve: (response: BrokerResponse) => void;
  readonly dispose: () => void;
};

function mapResponse(raw: Record<string, unknown>): BrokerResponse {
  if (raw.ok === true) return raw as unknown as BrokerResponse;
  return { ok: false, error: typeof raw.error === 'string' ? raw.error : 'sandbox error' };
}

function makeId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function createRepositorySandbox(options: RepositorySandboxOptions): RepositorySandbox {
  if (!options.image.startsWith('sha256:')) {
    throw new Error('sandbox image must be an explicit sha256:<id> image ID');
  }
  const imageId = options.image.slice('sha256:'.length);
  if (!/^[0-9a-f]{64}$/i.test(imageId)) {
    throw new Error('sandbox image ID must be a 64-character hex sha256 digest');
  }

  const identity = options.sandboxIdentity ?? resolveSandboxIdentity();
  requireNonRootSandboxIdentity(identity);

  // Optional proof/launcher-owned ownership label: validated metadata appended
  // as a direct argv --label so a proof run can scope cleanup to its own
  // containers. Never a caller-selected container target.
  if (options.proofOwnershipLabel) assertValidProofLabel(options.proofOwnershipLabel);
  const proofLabel = options.proofOwnershipLabel ?? null;

  const toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const runtimeName = options.containerRuntime ?? 'docker';
  const driver = options.driver ?? createPersistentContainerDriver({ containerRuntime: runtimeName });

  let state: SandboxState = 'created';
  let child: PersistentContainerChild | null = null;
  let ownedContainerId = '';
  let cidfile = '';
  let intakeClosed = false;

  // A single start promise is shared by concurrent start() callers so a later
  // caller can never resolve before the container is actually ready, and so
  // stop() can await/force-settle exactly one in-flight start.
  let startPromise: Promise<void> | null = null;
  let startController: AbortController | null = null;

  const waiters = new Map<string, Waiter>();
  let readyResolver: ((ok: boolean) => void) | null = null;
  // Latch: once a readiness frame has been observed it is never lost, even if
  // the readiness resolver is not yet bound when a fast supervisor's frame is
  // parsed. Bounds the readiness promise so the timer and the consumer both
  // resolve to the observed truth.
  let readySeen = false;
  let lineBuffer = Buffer.alloc(0);

  function buildCreateArgs(): string[] {
    const args = [
      'run',
      // PID 1 is an init/reaper (docker-init/tini) so orphaned grandchildren
      // and zombies from a killed process group are reaped by the container,
      // not left for the long-lived Node supervisor to ignore.
      '--init',
      '-i',
      '--cidfile', cidfile,
      '--network=none',
      '--privileged=false',
      '--security-opt=no-new-privileges',
      '--cap-drop=ALL',
      '--read-only',
      '--user', `${identity.uid}:${identity.gid}`,
      '--label', 'io.agent-pool.owned=true',
      // Proof/launcher-owned scoping label (validated metadata) so a proof run
      // can count and clean up only its own containers, never peers.
      ...(proofLabel ? ['--label', `${proofLabel.key}=${proofLabel.value}`] : []),
      '--tmpfs', '/tmp:noexec,nosuid,size=100m',
      '-v', `${options.workspacePath}:/workspace:rw`,
      '-w', '/workspace',
      '-e', 'HOME=/workspace/.home',
    ];
    if (options.cpuLimit) args.push('--cpus', options.cpuLimit);
    if (options.memoryLimit) args.push('--memory', options.memoryLimit);
    if (options.pidsLimit) args.push('--pids-limit', String(options.pidsLimit));
    args.push(options.image);
    return args;
  }

  function settleWaitersAndTerminal(error: Error): void {
    state = 'terminal';
    intakeClosed = true;
    for (const w of [...waiters.values()]) {
      waiters.delete(w.id);
      try { w.resolve({ ok: false, error: error.message }); } catch {}
    }
    if (readyResolver) {
      const r = readyResolver;
      readyResolver = null;
      r(false);
    }
  }

  function routeLine(line: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // ignore non-JSON noise
    }
    if (parsed.ready === true) {
      readySeen = true;
      if (readyResolver) {
        const r = readyResolver;
        readyResolver = null;
        r(true);
      }
      return;
    }
    const id = typeof parsed.id === 'string' ? parsed.id : null;
    if (id && waiters.has(id)) {
      const w = waiters.get(id)!;
      waiters.delete(id);
      w.resolve(mapResponse(parsed));
    }
    // Frames without a matching waiter (stray/late) are dropped boundedly.
  }

  function attachStdout(childProc: PersistentContainerChild): void {
    childProc.stdout.on('data', (chunk: Buffer | string) => {
      // Bound the undecoded wire bytes, rather than UTF-16 code units. Frames
      // are decoded only after a complete newline-delimited byte sequence.
      lineBuffer = Buffer.concat([lineBuffer, Buffer.from(chunk)]);
      if (lineBuffer.length > MAX_RESPONSE_BYTES) {
        lineBuffer = lineBuffer.subarray(lineBuffer.length - MAX_RESPONSE_BYTES);
      }
      let idx: number;
      while ((idx = lineBuffer.indexOf(0x0a)) >= 0) {
        const line = lineBuffer.subarray(0, idx).toString('utf8');
        lineBuffer = lineBuffer.subarray(idx + 1);
        if (line.length > 0) routeLine(line);
      }
    });
    childProc.stdout.on('end', () => settleWaitersAndTerminal(new Error('sandbox supervisor exited')));
    childProc.stdout.on('error', () => settleWaitersAndTerminal(new Error('sandbox supervisor stream error')));
    childProc.exit.then(() => {
      // If exit happens before stdout end, still settle.
      settleWaitersAndTerminal(new Error('sandbox container exited'));
    });
  }

  function writeFrame(frame: Record<string, unknown>): void {
    if (!child || intakeClosed) return;
    try {
      child.stdin.write(JSON.stringify(frame) + '\n');
    } catch {
      // stdin closed; subsequent reads will settle the waiter as terminal.
    }
  }

  async function readContainerId(): Promise<string> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        if (existsSync(cidfile)) {
          const raw = readFileSync(cidfile, 'utf8').trim();
          if (raw) {
            assertOwnedContainerId(raw);
            return raw;
          }
        }
      } catch {
        // not yet
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('sandbox owned container id was not captured within the readiness window');
  }

  let chain: Promise<unknown> = Promise.resolve();
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // One memoized cleanup promise per owned id: attempts runtime removal at
  // most once across start rollback, stop, terminal cleanup, and repeated
  // stop. This keeps teardown idempotent and deterministic — the exact owned
  // id is removed exactly once, never a second time and never a foreign
  // target. A second caller awaits the in-flight/already-resolved promise
  // rather than issuing a duplicate removal.
  let removeOwnedPromise: Promise<void> | null = null;
  function removeOwnedOnce(): Promise<void> {
    if (removeOwnedPromise) return removeOwnedPromise;
    const id = ownedContainerId;
    if (!id) return Promise.resolve();
    removeOwnedPromise = (async () => {
      try {
        const result = await driver.removeContainer(id);
        if (!result.ok) throw new Error(result.error ?? 'runtime removal failed');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`sandbox cleanup failed: ${message.slice(0, 256)}`);
      }
    })();
    return removeOwnedPromise;
  }

  async function doStart(): Promise<void> {
    state = 'starting';
    startController = new AbortController();
    const startSignal = startController.signal;
    cidfile = join(mkdtempSync(join(tmpdir(), 'sandbox-cid-')), 'container.id');

    const createArgs = buildCreateArgs();
    try {
      child = driver.spawnPersistent({
        runtimeArgs: createArgs,
        runtimeEnv: { PATH: '/usr/bin:/bin' },
        cidfile,
      });
    } catch (spawnErr) {
      // Create/spawn failure (runtime missing): settle deterministically.
      // There is no child and no captured owned id to remove; only clean the
      // cidfile and mark the sandbox terminal so no command is accepted.
      try { if (existsSync(cidfile)) rmSync(cidfile); } catch {}
      state = 'terminal';
      intakeClosed = true;
      throw spawnErr;
    }
    // Create and bind the readiness resolver BEFORE attaching stdout so a fast
    // real supervisor readiness frame cannot be parsed and dropped in the
    // window between attaching the read consumer and assigning the resolver.
    // The readySeen latch additionally guarantees readiness is never lost
    // regardless of listener scheduling.
    readySeen = false;
    const ready = new Promise<boolean>((resolveReady) => {
      readyResolver = resolveReady;
    });
    attachStdout(child);
    const readyTimer = setTimeout(() => {
      if (readyResolver) {
        const r = readyResolver;
        readyResolver = null;
        r(readySeen);
      }
    }, READINESS_TIMEOUT_MS);

    // A stop-during-start cancels this readiness wait so stop can settle one
    // start boundedly instead of waiting for the readiness deadline.
    const startCancelled = new Promise<never>((_, rejectCancel) => {
      if (startSignal.aborted) rejectCancel(new Error('sandbox start cancelled during stop'));
      else startSignal.addEventListener('abort', () => rejectCancel(new Error('sandbox start cancelled during stop')), { once: true });
    });

    try {
      ownedContainerId = await readContainerId();
      const ok = (await Promise.race([ready, startCancelled])) || readySeen;
      clearTimeout(readyTimer);
      if (!ok) {
        throw new Error('sandbox supervisor did not report readiness');
      }
      state = 'started';
    } catch (e) {
      clearTimeout(readyTimer);
      // Best-effort cleanup of a half-started container: kill the child and
      // remove the exact captured owned id, never another target.
      try { child?.kill('SIGKILL'); } catch {}
      await removeOwnedOnce();
      state = 'terminal';
      intakeClosed = true;
      throw e;
    }
  }

  let stopPromise: Promise<void> | null = null;

  return {
    image: options.image,

    start(): Promise<void> {
      // Already started (or starting and shared) — never resolve before ready.
      if (startPromise) return startPromise;
      if (state === 'started') return Promise.resolve();
      if (state !== 'created') {
        return Promise.reject(new Error(`sandbox cannot start from state ${state}`));
      }
      startPromise = doStart().finally(() => {
        startPromise = null;
        startController = null;
      });
      return startPromise;
    },

    runTool(request, runOptions): Promise<BrokerResponse> {
      if (state !== 'started') {
        return Promise.reject(new Error(`sandbox not started (state: ${state})`));
      }
      const task = async (): Promise<BrokerResponse> => {
        const id = makeId();
        const frame: Record<string, unknown> = { id, ...(request as Record<string, unknown>) };

        return new Promise<BrokerResponse>((resolveResp) => {
          let settled = false;
          let commandTimer: ReturnType<typeof setTimeout> | null = null;
          let graceTimer: ReturnType<typeof setTimeout> | null = null;
          const dispose = () => {
            if (commandTimer) clearTimeout(commandTimer);
            if (graceTimer) clearTimeout(graceTimer);
            // Remove the abort listener on settlement so a late abort can never
            // emit a stale cancel frame after this command already settled.
            if (signal) {
              try { signal.removeEventListener('abort', onAbort); } catch {}
            }
          };
          const finish = (response: BrokerResponse) => {
            if (settled) return;
            settled = true;
            dispose();
            waiters.delete(id);
            resolveResp(response);
          };

          commandTimer = setTimeout(() => {
            // Best-effort cancel of the owned command; resolve on a bounded grace.
            writeFrame({ id: makeId(), control: 'cancel', targetId: id });
            graceTimer = setTimeout(() => finish({ ok: false, error: 'sandbox tool timeout' }), CANCEL_GRACE_MS);
          }, toolTimeoutMs);

          const signal = runOptions?.signal;
          const onAbort = () => {
            writeFrame({ id: makeId(), control: 'cancel', targetId: id });
            graceTimer = setTimeout(() => finish({ ok: false, error: 'sandbox tool cancelled' }), CANCEL_GRACE_MS);
          };
          // A pre-aborted signal must not emit a cancel for an unregistered
          // target. Register and dispatch first, then cancel that exact id.
          waiters.set(id, { id, resolve: finish, dispose });
          writeFrame(frame);
          if (signal) {
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          }
        });
      };
      return serialize(task);
    },

    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
      // If start is still in flight, force it to settle (cancel its readiness
      // wait) and await it so stop can never resolve while the child later
      // becomes started. A half-started owned id is removed inside doStart.
      if (startPromise) {
        try { startController?.abort(); } catch {}
        try { await startPromise; } catch {}
      }
      if (state === 'stopped' || state === 'terminal') {
        // Still ensure any owned container is removed (idempotent, crash-safe).
        await removeOwnedOnce();
        return;
      }
      const previousState = state;
      state = 'stopping';
      intakeClosed = true;

      if (previousState === 'started' && child) {
        // Orderly shutdown is stdin EOF; intake is already closed, so no control
        // frame can be sent while teardown is in progress.
        try { child.stdin.end(); } catch {}
        // Bounded wait for the run child to exit.
        await Promise.race([
          child.exit,
          new Promise<void>((r) => setTimeout(r, shutdownGraceMs)),
        ]);
      }
      // Forced removal is attempted exactly once. Preserve its deterministic
      // failure for the stop caller, but finish local settlement first.
      let cleanupError: unknown = null;
      try { await removeOwnedOnce(); } catch (error) { cleanupError = error; }
      try { if (cidfile && existsSync(cidfile)) rmSync(cidfile); } catch {}
      // Settle any still-pending waiters with a bounded terminal response.
      for (const w of [...waiters.values()]) {
        waiters.delete(w.id);
        try { w.dispose(); w.resolve({ ok: false, error: 'sandbox stopped' }); } catch {}
      }
      state = 'stopped';
      if (cleanupError) throw cleanupError;
      })();
      return stopPromise;
    },
  };
}
