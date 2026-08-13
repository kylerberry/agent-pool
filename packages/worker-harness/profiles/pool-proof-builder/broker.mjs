#!/usr/bin/env node
/**
 * Persistent in-container repository tool supervisor.
 *
 * Runs as the long-lived container entrypoint. Reads newline-delimited JSON
 * request frames from stdin, executes read/write/edit/bash inside /workspace
 * with a fresh allowlist environment per command, and writes one
 * newline-delimited JSON response frame per request. Supports best-effort
 * per-command cancellation and an orderly shutdown control frame. On stdin EOF
 * the supervisor exits, which stops the owned container.
 *
 * No dependencies; runs inside the pinned sandbox container image. Every
 * command receives a freshly built environment that never spreads caller
 * values, host HOME, provider/GitHub credentials, or Pi-private paths.
 */

import { spawn } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve, dirname } from 'node:path';

// Canonicalize the workspace root through realpath once so the containment
// check is consistent when the root path itself traverses a symlink (e.g. the
// macOS host $TMPDIR /var -> /private/var). Without this, realpathSync(target)
// resolves below WORKSPACE's string form and every read/write is rejected as
// "path outside workspace". Falls back to the raw path if it does not exist yet.
function canonicalWorkspace(raw) {
  try { return realpathSync(raw); } catch { return raw; }
}
const WORKSPACE = canonicalWorkspace(process.env.AGENT_POOL_SANDBOX_WORKSPACE ?? '/workspace');
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_TEXT_BYTES = 10 * 1024 * 1024;
const MAX_WALL_MS = 60_000;
const ALLOWED_HOME = '/workspace/.home';
const CANCEL_GRACE_MS = 2_000;

/** Fresh, allowlist-only command environment; caller-supplied env is never spread. */
function buildCommandEnv() {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: ALLOWED_HOME,
    XDG_CONFIG_HOME: `${ALLOWED_HOME}/.config`,
    XDG_CACHE_HOME: `${ALLOWED_HOME}/.cache`,
    XDG_DATA_HOME: `${ALLOWED_HOME}/.local/share`,
    LANG: 'C.UTF-8',
  };
}


// Keep at most `limit` UTF-8 bytes and never return a partial code point.
function appendBoundedUtf8(text, chunk, limit) {
  const bytes = Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from(chunk)]);
  if (bytes.length <= limit) return bytes.toString('utf8');
  let end = limit;
  while (end > 0) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)); }
    catch { end -= 1; }
  }
  return '';
}

function send(response) {
  let line = JSON.stringify(response);
  // Never emit truncated JSON: slicing mid-string produces an invalid frame that
  // the host would silently drop. If the serialized response would exceed the
  // byte budget, emit one bounded, valid terminal response instead.
  if (Buffer.byteLength(line, 'utf8') > MAX_RESPONSE_TEXT_BYTES) {
    line = JSON.stringify({
      id: typeof response.id === 'string' ? response.id : null,
      ok: false,
      error: 'response too large',
    });
  }
  process.stdout.write(line + '\n');
}

function isSafeRelativePath(path) {
  if (typeof path !== 'string') return false;
  if (/[\u0000-\u001f]/.test(path)) return false;
  if (isAbsolute(path)) return false;
  if (/^[A-Za-z]:/.test(path) || path.startsWith('\\')) return false;
  const normalized = normalize(path);
  return !normalized.split(/[/\\]/).includes('..');
}

function resolveWorkspacePath(path) {
  if (!isSafeRelativePath(path)) return null;
  const target = resolve(WORKSPACE, path);
  const rel = relative(WORKSPACE, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  try {
    const real = realpathSync(target);
    const realRel = relative(WORKSPACE, real);
    if (realRel.startsWith('..') || isAbsolute(realRel)) return null;
  } catch {
    // target may not exist yet
  }
  return target;
}

function isSpecialFile(target) {
  try {
    const st = lstatSync(target);
    return st.isSymbolicLink() || !(st.isFile() || st.isDirectory());
  } catch {
    return false;
  }
}

function isSymlinkOrSpecialInPath(targetPath) {
  let current = targetPath;
  while (current !== WORKSPACE) {
    try {
      const st = lstatSync(current);
      if (st.isSymbolicLink() || !(st.isDirectory() || st.isFile())) return true;
    } catch {
      // component may not exist yet
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

let inFlight = null; // { id, child, timer, killed, settled, reason, resolveCmd }

function killInFlight(reason) {
  const cur = inFlight;
  if (!cur || cur.killed) return false;
  cur.killed = true;
  cur.reason = reason;
  try { clearTimeout(cur.timer); } catch {}
  // Kill the whole process group (the command plus any descendants it
  // spawned) so cancellation/timeout/output-overflow cannot leave orphaned
  // grandchildren.
  try { process.kill(-cur.child.pid, 'SIGKILL'); } catch {}
  return true;
}

function runCommand(id, command, args) {
  return new Promise((resolveCmd) => {
    if (typeof command !== 'string' || command.length === 0) {
      resolveCmd({ id, ok: true, exitCode: 1, stdout: '', stderr: 'empty command' });
      return;
    }
    const safeArgs = Array.isArray(args) ? args.map(String) : [];
    if (safeArgs.some((a) => /[\u0000-\u001f]/.test(a))) {
      resolveCmd({ id, ok: true, exitCode: 1, stdout: '', stderr: 'invalid command argument' });
      return;
    }
    const child = spawn(command, safeArgs, {
      cwd: WORKSPACE,
      env: buildCommandEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    const cur = { id, child, timer: null, killed: false, settled: false, reason: null, resolveCmd };
    const settle = (resp) => {
      if (cur.settled) return;
      cur.settled = true;
      try { clearTimeout(cur.timer); } catch {}
      inFlight = null;
      resolveCmd(resp);
    };
    cur.timer = setTimeout(() => { killInFlight('timeout'); }, MAX_WALL_MS);
    inFlight = cur;
    child.stdout.on('data', (chunk) => {
      stdout = appendBoundedUtf8(stdout, chunk, MAX_RESPONSE_TEXT_BYTES);
      if (Buffer.byteLength(stdout, 'utf8') >= MAX_RESPONSE_TEXT_BYTES) {
        killInFlight('overflow');
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendBoundedUtf8(stderr, chunk, MAX_RESPONSE_TEXT_BYTES);
    });
    child.on('error', (err) => settle({ id, ok: true, exitCode: 1, stdout: '', stderr: err.message }));
    child.on('close', (exitCode) => {
      // A killed command (cancel/timeout/overflow) yields ONE bounded terminal
      // response carrying the command id, so the host always receives a
      // deterministic settlement instead of a racing exit-code frame.
      if (cur.reason === 'client-cancel') settle({ id, ok: false, error: 'cancelled', cancelled: true });
      else if (cur.reason === 'timeout') settle({ id, ok: false, error: 'command timeout' });
      else if (cur.reason === 'overflow') settle({ id, ok: false, error: 'output overflow' });
      else settle({
        id, ok: true,
        exitCode: exitCode ?? 1,
        stdout: stdout.slice(0, MAX_RESPONSE_TEXT_BYTES),
        stderr: stderr.slice(0, MAX_RESPONSE_TEXT_BYTES),
      });
    });
  });
}

function checkRequestBounds(request) {
  if (!request || typeof request !== 'object') return { ok: false, error: 'invalid request' };
  const size = Buffer.byteLength(JSON.stringify(request), 'utf8');
  if (size > MAX_REQUEST_BYTES) return { ok: false, error: 'request too large' };
  return null;
}

async function handleTool(id, request) {
  const bounds = checkRequestBounds(request);
  if (bounds) return { id, ...bounds };

  switch (request.tool) {
    case 'read': {
      const target = resolveWorkspacePath(request.path);
      if (target === null) return { id, ok: false, error: 'path outside workspace' };
      if (isSpecialFile(target)) return { id, ok: false, error: 'not a regular file' };
      try {
        return { id, ok: true, content: readFileSync(target, 'utf8').slice(0, MAX_RESPONSE_TEXT_BYTES) };
      } catch (e) {
        return { id, ok: false, error: e.message };
      }
    }
    case 'write': {
      const target = resolveWorkspacePath(request.path);
      if (target === null) return { id, ok: false, error: 'path outside workspace' };
      const parent = dirname(target);
      if (isSymlinkOrSpecialInPath(parent)) return { id, ok: false, error: 'parent path contains symlink or special file' };
      try {
        mkdirSync(parent, { recursive: true });
        writeFileSync(target, String(request.content ?? ''), 'utf8');
        return { id, ok: true };
      } catch (e) {
        return { id, ok: false, error: e.message };
      }
    }
    case 'edit': {
      const target = resolveWorkspacePath(request.path);
      if (target === null) return { id, ok: false, error: 'path outside workspace' };
      if (isSpecialFile(target)) return { id, ok: false, error: 'not a regular file' };
      const parent = dirname(target);
      if (isSymlinkOrSpecialInPath(parent)) return { id, ok: false, error: 'parent path contains symlink or special file' };
      try {
        const existing = readFileSync(target, 'utf8');
        const oldText = String(request.oldText ?? '');
        if (!existing.includes(oldText)) return { id, ok: false, error: 'oldText not found' };
        writeFileSync(target, existing.replace(oldText, String(request.newText ?? '')), 'utf8');
        return { id, ok: true };
      } catch (e) {
        return { id, ok: false, error: e.message };
      }
    }
    case 'bash': {
      return runCommand(id, request.command, request.args);
    }
    default:
      return { id, ok: false, error: 'unknown tool' };
  }
}

async function handleFrame(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send({ id: null, ok: false, error: 'malformed frame' });
    return;
  }
  // Control frames.
  if (request && typeof request === 'object' && 'control' in request) {
    if (request.control === 'shutdown') {
      send({ id: request.id ?? null, ok: true, control: 'shutdown' });
      shutdown(0);
      return;
    }
    if (request.control === 'cancel') {
      // A cancel must target EXACTLY the current in-flight command id. A stale
      // or foreign cancel (wrong/absent targetId, or no command in flight)
      // must never kill the current command; it resolves as a no-such-target.
      const target = request.targetId;
      const matches = typeof target === 'string' && inFlight !== null && inFlight.id === target;
      const cancelled = matches ? killInFlight('client-cancel') : false;
      send({ id: request.id ?? null, ok: false, error: cancelled ? 'cancelled' : 'no-such-target', cancelled });
      return;
    }
    send({ id: request.id ?? null, ok: false, error: 'unknown control' });
    return;
  }
  const id = (request && typeof request === 'object' && typeof request.id === 'string') ? request.id : null;
  const response = await handleTool(id, request);
  send(response);
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { killInFlight('shutdown'); } catch {}
  // Give in-flight I/O a bounded moment to flush, then exit.
  setTimeout(() => process.exit(code), 50).unref();
}

async function main() {
  // Readiness frame: the host awaits this before issuing requests.
  send({ ready: true, pid: process.pid });

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (shuttingDown) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer, 'utf8') > MAX_REQUEST_BYTES * 4) {
      send({ id: null, ok: false, error: 'input buffer too large' });
      buffer = '';
    }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        handleFrame(line).catch((e) => send({ id: null, ok: false, error: `supervisor error: ${e instanceof Error ? e.message : String(e)}` }));
      }
    }
  });
  process.stdin.on('end', () => shutdown(0));
  process.stdin.on('error', () => shutdown(1));
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
}

main();
