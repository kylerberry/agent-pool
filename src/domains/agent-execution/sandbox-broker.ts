/**
 * Sandbox broker for repository tool adapters.
 *
 * The broker runs as a separate Node process started by the launcher. It owns
 * the per-attempt container sandbox, validates workspace-relative paths, and
 * executes read/write/edit/bash requests from the Pi extension over a Unix
 * socket. The Pi process never has direct access to the workspace or host shell.
 *
 * Protocol: one JSON request line per connection, one JSON response line, then
 * the socket is closed. Request and response sizes and processing time are
 * bounded.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRepositorySandbox, type RepositorySandbox, type RepositorySandboxOptions } from './repository-sandbox.ts';

type BrokerRequest =
  | { tool: 'read'; path: string }
  | { tool: 'write'; path: string; content: string }
  | { tool: 'edit'; path: string; oldText: string; newText: string }
  | { tool: 'bash'; command: string; args: string[] };

type BrokerResponse =
  | { ok: true; content?: string; exitCode?: number; stdout?: string; stderr?: string }
  | { ok: false; error: string };

export type SandboxBrokerOptions = {
  readonly socketPath: string;
  readonly workspacePath: string;
  readonly containerRuntime: 'docker' | 'podman';
  readonly image: string;
  readonly cpuLimit?: string;
  readonly memoryLimit?: string;
  readonly pidsLimit?: number;
  /** Launcher-owned sandbox UID:GID mapping. Resolved from the host when omitted. */
  readonly sandboxIdentity?: RepositorySandboxOptions['sandboxIdentity'];
  /** Use the built-in fake sandbox (simple responses). */
  readonly fakeSandbox?: boolean;
  /** Inject a custom fake sandbox (tests use this to record invocations). */
  readonly fake?: RepositorySandboxOptions['fake'];
};

export type SandboxBroker = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
};

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 90_000;

export function createSandboxBroker(options: SandboxBrokerOptions): SandboxBroker {
  const socketDir = dirname(options.socketPath);
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  if (existsSync(options.socketPath)) {
    rmSync(options.socketPath);
  }

  const sandbox = createRepositorySandbox({
    containerRuntime: options.containerRuntime,
    image: options.image,
    workspacePath: options.workspacePath,
    cpuLimit: options.cpuLimit,
    memoryLimit: options.memoryLimit,
    pidsLimit: options.pidsLimit,
    sandboxIdentity: options.sandboxIdentity,
    fake: options.fake ?? (options.fakeSandbox
      ? {
          pid: 0,
          exitCode: 0,
          kill: () => true,
          async runTool(request: unknown): Promise<BrokerResponse> {
            const req = request as BrokerRequest;
            switch (req.tool) {
              case 'read':
                return { ok: true, content: `fake-read:${req.path}` };
              case 'write':
                return { ok: true };
              case 'edit':
                return { ok: true };
              case 'bash':
                return { ok: true, exitCode: 0, stdout: `fake-bash:${req.command}`, stderr: '' };
              default:
                return { ok: false, error: 'unknown tool' };
            }
          },
        }
      : undefined),
  });

  let server: Server | null = null;

  async function handleRequest(request: BrokerRequest): Promise<BrokerResponse> {
    return sandbox.runTool(request);
  }

  return {
    async start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server = createServer((socket: Socket) => {
          let buffer = '';
          let responded = false;
          const timeout = setTimeout(() => {
            if (!responded) {
              responded = true;
              socket.write(JSON.stringify({ ok: false, error: 'broker request timeout' }) + '\n', () => {
                socket.destroy();
              });
            }
          }, REQUEST_TIMEOUT_MS);

          socket.on('data', async (chunk) => {
            if (responded) return;
            buffer += chunk;
            if (Buffer.byteLength(buffer, 'utf8') > MAX_REQUEST_BYTES) {
              responded = true;
              clearTimeout(timeout);
              socket.write(JSON.stringify({ ok: false, error: 'request too large' }) + '\n', () => {
                socket.destroy();
              });
              return;
            }
            const newline = buffer.indexOf('\n');
            if (newline < 0) return;
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            responded = true;
            clearTimeout(timeout);
            try {
              const request = JSON.parse(line) as BrokerRequest;
              const response = await handleRequest(request);
              const out = JSON.stringify(response).slice(0, MAX_RESPONSE_BYTES) + '\n';
              if (socket.destroyed) return;
              socket.write(out, (err) => {
                socket.end();
                if (err) socket.destroy();
              });
            } catch (e) {
              if (socket.destroyed) return;
              socket.write(JSON.stringify({ ok: false, error: String(e) }) + '\n', () => {
                socket.end();
                socket.destroy();
              });
            }
          });
          socket.on('error', () => {
            clearTimeout(timeout);
            socket.destroy();
          });
          socket.on('end', () => {
            clearTimeout(timeout);
            if (!responded) {
              socket.write(JSON.stringify({ ok: false, error: 'no request received' }) + '\n', () => {
                socket.destroy();
              });
            }
          });
        });
        server.on('error', reject);
        server.listen(options.socketPath, () => {
          resolve();
        });
      });
    },

    async stop(): Promise<void> {
      return new Promise((resolve) => {
        if (!server) {
          resolve();
          return;
        }
        server.close(() => {
          if (existsSync(options.socketPath)) {
            rmSync(options.socketPath);
          }
          resolve();
        });
      });
    },
  };
}


