/**
 * Persistent attempt sandbox broker.
 *
 * Starts one persistent repository sandbox when the broker starts (before
 * accepting requests), proxies read/write/edit/bash from the Pi extension over
 * a Unix socket to the long-lived in-container supervisor, supports client
 * disconnect cancellation, bounds request/response/time, and tears the sandbox
 * down idempotently on stop. Each broker instance owns its own sandbox; cross-
 * attempt brokers never share a container.
 *
 * Protocol: one JSON request line per connection, one JSON response line, then
 * the socket is closed. Request and response sizes and processing time are
 * bounded.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  createRepositorySandbox,
  type RepositorySandbox,
  type RepositorySandboxOptions,
  type ContainerDriver,
  type BrokerResponse,
} from './repository-sandbox.ts';

type BrokerRequest =
  | { tool: 'read'; path: string }
  | { tool: 'write'; path: string; content: string }
  | { tool: 'edit'; path: string; oldText: string; newText: string }
  | { tool: 'bash'; command: string; args: string[] };

export type SandboxBrokerOptions = {
  readonly socketPath: string;
  readonly workspacePath: string;
  readonly containerRuntime: 'docker' | 'podman';
  readonly image: string;
  readonly cpuLimit?: string;
  readonly memoryLimit?: string;
  readonly pidsLimit?: number;
  readonly sandboxIdentity?: RepositorySandboxOptions['sandboxIdentity'];
  readonly toolTimeoutMs?: number;
  readonly shutdownGraceMs?: number;
  /** Per-connection broker request timeout (default 90s). */
  readonly brokerRequestTimeoutMs?: number;
  /** Container driver. Defaults to the real Docker/Podman driver. */
  readonly driver?: ContainerDriver;
  /**
   * Test-only seam. When set, start() simulates a post-listen server failure
   * (as if the listening socket died) immediately after listen succeeds, so a
   * focused test can prove terminalFailure resolves and the owned container is
   * torn down. Production never sets this.
   */
  readonly _testOnlyFailAfterListen?: Error;
};

export type SandboxBroker = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  /** Resolves after a post-listen server failure has begun owned teardown. */
  readonly terminalFailure: Promise<Error>;
};

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;

export function createSandboxBroker(options: SandboxBrokerOptions): SandboxBroker {
  const socketDir = dirname(options.socketPath);
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  if (existsSync(options.socketPath)) {
    rmSync(options.socketPath);
  }

  const sandbox: RepositorySandbox = createRepositorySandbox({
    containerRuntime: options.containerRuntime,
    image: options.image,
    workspacePath: options.workspacePath,
    cpuLimit: options.cpuLimit,
    memoryLimit: options.memoryLimit,
    pidsLimit: options.pidsLimit,
    sandboxIdentity: options.sandboxIdentity,
    toolTimeoutMs: options.toolTimeoutMs,
    shutdownGraceMs: options.shutdownGraceMs,
    driver: options.driver,
  });

  let server: Server | null = null;
  let stopped = false;
  let stopPromise: Promise<void> | null = null;
  let resolveTerminalFailure!: (error: Error) => void;
  const terminalFailure = new Promise<Error>((resolve) => { resolveTerminalFailure = resolve; });
  let listening = false;
  function failAfterListen(error: Error): void {
    if (!listening || stopped) return;
    resolveTerminalFailure(error);
    void stop();
  }
  function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopped = true;
      listening = false;
      await new Promise<void>((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
      });
      await sandbox.stop();
      if (existsSync(options.socketPath)) rmSync(options.socketPath);
    })();
    return stopPromise;
  }

  async function handleRequest(request: BrokerRequest, signal: AbortSignal): Promise<BrokerResponse> {
    return sandbox.runTool(request, { signal });
  }

  return {
    terminalFailure,
    async start(): Promise<void> {
      // Start the persistent sandbox before accepting any client request.
      await sandbox.start();
      try {
        await new Promise<void>((resolveListen, rejectListen) => {
          server = createServer((socket: Socket) => {
          let buffer = '';
          let responded = false;
          const controller = new AbortController();
          const requestTimeout = options.brokerRequestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
          const timeout = setTimeout(() => {
            if (!responded) {
              controller.abort();
            }
          }, requestTimeout);

          // Client disconnect cancels the owned in-container command.
          const onDisconnect = () => {
            if (!responded) controller.abort();
          };
          socket.on('close', onDisconnect);

          function reply(payload: BrokerResponse | { ok: false; error: string }): void {
            if (responded) return;
            responded = true;
            clearTimeout(timeout);
            try {
              controller.signal.removeEventListener('abort', onDisconnectAbort);
            } catch {}
            // Never emit truncated JSON: slicing the serialized response can cut
            // mid-string and yield an invalid frame. If it would exceed the byte
            // budget, emit one bounded, valid terminal response instead.
            let out = JSON.stringify(payload);
            if (Buffer.byteLength(out, 'utf8') > MAX_RESPONSE_BYTES) {
              out = JSON.stringify({ ok: false, error: 'response too large' });
            }
            out += '\n';
            if (socket.destroyed) return;
            socket.write(out, () => {
              try { socket.end(); } catch {}
            });
          }
          const onDisconnectAbort = () => reply({ ok: false, error: 'client disconnected' });
          controller.signal.addEventListener('abort', onDisconnectAbort, { once: true });

          socket.on('data', async (chunk) => {
            if (responded) return;
            buffer += chunk;
            if (Buffer.byteLength(buffer, 'utf8') > MAX_REQUEST_BYTES) {
              // Reply (which half-closes the socket) and stop processing. Do
              // not hard-destroy or pause: a destroy RSTs the peer while its
              // write is still draining (client EPIPE); a pause deadlocks it.
              // Subsequent chunks are ignored once `responded` is true.
              reply({ ok: false, error: 'request too large' });
              return;
            }
            const newline = buffer.indexOf('\n');
            if (newline < 0) return;
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            try {
              const request = JSON.parse(line) as BrokerRequest;
              if (controller.signal.aborted) {
                reply({ ok: false, error: 'client disconnected' });
                return;
              }
              const response = await handleRequest(request, controller.signal);
              reply(response);
            } catch (e) {
              reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
            }
          });
          socket.on('error', () => {
            onDisconnect();
            try { socket.destroy(); } catch {}
          });
          socket.on('end', () => {
            if (!responded) {
              // Allow an in-flight command to be cancelled; the abort listener replies.
              controller.abort();
            }
          });
        });
          server.on('error', (error) => {
            if (listening) failAfterListen(error);
            else rejectListen(error);
          });
          server.on('close', () => failAfterListen(new Error('sandbox broker server closed')));
          server.listen(options.socketPath, () => {
            listening = true;
            if (options._testOnlyFailAfterListen) {
              // Simulate a fatal post-listen server error so the terminalFailure
              // channel and owned teardown can be exercised deterministically.
              failAfterListen(options._testOnlyFailAfterListen);
            }
            resolveListen();
          });
        });
      } catch (listenErr) {
        // Roll back: if listening failed the caller never receives the broker,
        // so the owned container must be torn down now rather than leaked. The
        // rollback is best-effort: a removal failure must not mask the original
        // listen error that caused the rollback.
        try { await sandbox.stop(); } catch { /* best-effort rollback */ }
        throw listenErr;
      }
    },

    stop,
  };
}
