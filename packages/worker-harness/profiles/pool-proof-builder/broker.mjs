#!/usr/bin/env node
/**
 * In-sandbox tool broker.
 *
 * Reads one JSON request from stdin, performs the requested read/write/edit/bash
 * operation inside /workspace, writes one JSON response to stdout, and exits.
 * No dependencies; runs inside the pinned sandbox container image.
 */

import { spawn } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve, dirname } from 'node:path';

const WORKSPACE = '/workspace';
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_TEXT_BYTES = 10 * 1024 * 1024;
const MAX_WALL_MS = 60_000;
const ALLOWED_HOME = '/workspace/.home';

function send(response) {
  const line = JSON.stringify(response);
  process.stdout.write(line.slice(0, MAX_RESPONSE_TEXT_BYTES) + '\n');
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

async function runCommand(command, args) {
  if (typeof command !== 'string' || command.length === 0) {
    return { ok: true, exitCode: 1, stdout: '', stderr: 'empty command' };
  }
  const safeArgs = Array.isArray(args) ? args.map(String) : [];
  if (safeArgs.some((a) => /[\u0000-\u001f]/.test(a))) {
    return { ok: true, exitCode: 1, stdout: '', stderr: 'invalid command argument' };
  }
  return new Promise((resolve) => {
    const child = spawn(command, safeArgs, {
      cwd: WORKSPACE,
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: ALLOWED_HOME,
        XDG_CONFIG_HOME: `${ALLOWED_HOME}/.config`,
        XDG_CACHE_HOME: `${ALLOWED_HOME}/.cache`,
        XDG_DATA_HOME: `${ALLOWED_HOME}/.local/share`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let resolved = false;
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {}
    }, MAX_WALL_MS);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > MAX_RESPONSE_TEXT_BYTES) {
        stdout = stdout.slice(0, MAX_RESPONSE_TEXT_BYTES);
        try {
          child.kill('SIGTERM');
        } catch {}
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, 'utf8') > MAX_RESPONSE_TEXT_BYTES) {
        stderr = stderr.slice(0, MAX_RESPONSE_TEXT_BYTES);
      }
    });
    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ ok: true, exitCode: 1, stdout: '', stderr: err.message });
    });
    child.on('close', (exitCode) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({
        ok: true,
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

async function handle(request) {
  const bounds = checkRequestBounds(request);
  if (bounds) return bounds;

  switch (request.tool) {
    case 'read': {
      const target = resolveWorkspacePath(request.path);
      if (target === null) return { ok: false, error: 'path outside workspace' };
      if (isSpecialFile(target)) return { ok: false, error: 'not a regular file' };
      try {
        return { ok: true, content: readFileSync(target, 'utf8').slice(0, MAX_RESPONSE_TEXT_BYTES) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    case 'write': {
      const target = resolveWorkspacePath(request.path);
      if (target === null) return { ok: false, error: 'path outside workspace' };
      const parent = dirname(target);
      if (isSymlinkOrSpecialInPath(parent)) return { ok: false, error: 'parent path contains symlink or special file' };
      try {
        mkdirSync(parent, { recursive: true });
        writeFileSync(target, String(request.content ?? ''), 'utf8');
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    case 'edit': {
      const target = resolveWorkspacePath(request.path);
      if (target === null) return { ok: false, error: 'path outside workspace' };
      if (isSpecialFile(target)) return { ok: false, error: 'not a regular file' };
      const parent = dirname(target);
      if (isSymlinkOrSpecialInPath(parent)) return { ok: false, error: 'parent path contains symlink or special file' };
      try {
        const existing = readFileSync(target, 'utf8');
        const oldText = String(request.oldText ?? '');
        if (!existing.includes(oldText)) return { ok: false, error: 'oldText not found' };
        writeFileSync(target, existing.replace(oldText, String(request.newText ?? '')), 'utf8');
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    case 'bash': {
      return runCommand(request.command, request.args);
    }
    default:
      return { ok: false, error: 'unknown tool' };
  }
}

async function main() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, 'utf8') > MAX_REQUEST_BYTES) {
      send({ ok: false, error: 'request too large' });
      process.exit(0);
    }
  });
  process.stdin.on('end', async () => {
    const newline = buffer.indexOf('\n');
    const line = newline >= 0 ? buffer.slice(0, newline) : buffer;
    try {
      const request = JSON.parse(line);
      send(await handle(request));
    } catch (e) {
      send({ ok: false, error: e.message });
    }
  });
}

main();
