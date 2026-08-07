/**
 * Trusted bootstrap extension for the Pool Proof builder profile.
 *
 * This is a real Pi extension loaded explicitly via `-e`. It:
 * - captures the launcher-verified execution context once at startup and deep-freezes it;
 * - registers parameterless actor_identity and custom read/write/edit/bash tools;
 * - disables ambient discovery by relying on the launcher's CLI flags;
 * - proxies repository operations to the sandbox broker via a Unix socket;
 * - never rereads a mutable workspace marker after startup.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';

export type ActorIdentity = {
  actor: 'pool-worker';
  authority: 'single-attempt-execution';
  node_id: string;
  attempt_id: string;
  target_repo: string;
  target_branch: string;
  context_source: 'launcher-verified';
  can_modify_pool_policy: false;
};

type BrokerResponse =
  | { ok: true; content?: string; exitCode?: number; stdout?: string; stderr?: string }
  | { ok: false; error: string };

function renderIdentityCapsule(context: Record<string, unknown>): string {
  return [
    'ACTOR: Pool Worker',
    'AUTHORITY: Execute exactly one supplied attempt contract',
    `ATTEMPT: ${String(context.attempt_id ?? '')}`,
    `TARGET: ${String(context.target_repo ?? '')}@${String(context.target_branch ?? '')}`,
    'NOT AUTHORIZED: Pool design, supervisor policy, DAG mutation, or other attempts',
  ].join('\n');
}

function deepFreeze<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function buildIdentity(context: Record<string, unknown>): ActorIdentity {
  return {
    actor: 'pool-worker',
    authority: 'single-attempt-execution',
    node_id: String(context.node_id ?? ''),
    attempt_id: String(context.attempt_id ?? ''),
    target_repo: String(context.target_repo ?? ''),
    target_branch: String(context.target_branch ?? ''),
    context_source: 'launcher-verified',
    can_modify_pool_policy: false,
  };
}

function loadContext(): Record<string, unknown> {
  const markerPath = process.env.AGENT_POOL_EXECUTION_CONTEXT;
  if (!markerPath) throw new Error('missing AGENT_POOL_EXECUTION_CONTEXT');
  return JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
}

const capturedContext = deepFreeze(loadContext());

// Emit the launcher-verified identity capsule into startup diagnostics. It is
// derived from the captured context, not from workspace files or prompt text.
console.error(renderIdentityCapsule(capturedContext));

export function actor_identity(): ActorIdentity {
  return buildIdentity(capturedContext);
}

async function brokerRequest(socketPath: string, request: unknown): Promise<BrokerResponse> {
  return new Promise((resolve, reject) => {
    const client = connect(socketPath);
    let buffer = '';
    let resolved = false;
    client.on('data', (chunk) => {
      if (resolved) return;
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      resolved = true;
      const line = buffer.slice(0, newline);
      client.end();
      try {
        resolve(JSON.parse(line) as BrokerResponse);
      } catch (e) {
        reject(e);
      }
    });
    client.on('error', (err) => {
      if (!resolved) reject(err);
    });
    client.on('close', () => {
      if (!resolved) {
        resolved = true;
        try {
          resolve(JSON.parse(buffer) as BrokerResponse);
        } catch (e) {
          reject(e);
        }
      }
    });
    client.write(JSON.stringify(request) + '\n');
  });
}

export default function trustedBootstrap(pi: ExtensionAPI) {
  const identity = Object.freeze(buildIdentity(capturedContext));
  const brokerSocket = process.env.AGENT_POOL_BROKER_SOCKET ?? '';

  pi.registerTool({
    name: 'actor_identity',
    label: 'Actor Identity',
    description: 'Return the launcher-verified Pool Worker actor identity. Parameterless.',
    parameters: { type: 'object', properties: {}, required: [] } as const,
    async execute() {
      return {
        content: [{ type: 'text', text: JSON.stringify(identity) }],
        details: identity,
      };
    },
  });

  pi.registerTool({
    name: 'read',
    label: 'Read',
    description: 'Read a workspace-relative file through the sandbox broker.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path' },
      },
      required: ['path'],
    } as const,
    async execute(_toolCallId, params) {
      const response = await brokerRequest(brokerSocket, { tool: 'read', path: params.path });
      if (!response.ok) return { content: [{ type: 'text', text: response.error }], isError: true, details: response };
      return { content: [{ type: 'text', text: response.content ?? '' }], details: response };
    },
  });

  pi.registerTool({
    name: 'write',
    label: 'Write',
    description: 'Write content to a workspace-relative file through the sandbox broker.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path' },
        content: { type: 'string', description: 'File content' },
      },
      required: ['path', 'content'],
    } as const,
    async execute(_toolCallId, params) {
      const response = await brokerRequest(brokerSocket, { tool: 'write', path: params.path, content: params.content });
      if (!response.ok) return { content: [{ type: 'text', text: response.error }], isError: true, details: response };
      return { content: [{ type: 'text', text: 'ok' }], details: response };
    },
  });

  pi.registerTool({
    name: 'edit',
    label: 'Edit',
    description: 'Replace oldText with newText in a workspace-relative file through the sandbox broker.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path' },
        oldText: { type: 'string', description: 'Text to replace' },
        newText: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'oldText', 'newText'],
    } as const,
    async execute(_toolCallId, params) {
      const response = await brokerRequest(brokerSocket, {
        tool: 'edit',
        path: params.path,
        oldText: params.oldText,
        newText: params.newText,
      });
      if (!response.ok) return { content: [{ type: 'text', text: response.error }], isError: true, details: response };
      return { content: [{ type: 'text', text: 'ok' }], details: response };
    },
  });

  pi.registerTool({
    name: 'bash',
    label: 'Bash',
    description: 'Run a repository command through the sandbox broker. Environment is set by the broker; callers may not inject variables.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to run' },
        args: { type: 'array', items: { type: 'string' }, description: 'Command arguments' },
      },
      required: ['command'],
    } as const,
    async execute(_toolCallId, params) {
      const response = await brokerRequest(brokerSocket, {
        tool: 'bash',
        command: params.command,
        args: params.args ?? [],
      });
      if (!response.ok) return { content: [{ type: 'text', text: response.error }], isError: true, details: response };
      return {
        content: [{ type: 'text', text: response.stdout ?? '' }],
        details: response,
      };
    },
  });
}
