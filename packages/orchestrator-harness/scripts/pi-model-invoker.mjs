#!/usr/bin/env node
/**
 * Pi-backed DecompositionModelInvoker adapter.
 *
 * Bridges the deterministic runDecomposition harness to the canonical Pi
 * launcher. In production the adapter invokes the package's spec-decomposer
 * agent with the already-sanitized prompt and the exact router-selected model
 * produced by runDecomposition; the untrusted decomposition job never reaches
 * the agent directly.
 */

import { spawn } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  lstatSync,
  realpathSync,
  openSync,
  writeSync,
  closeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { trustedInterpreter, trustedPath } from "./trusted-spawn.mjs";
import { verifyPiIdentity } from "./pi-identity.mjs";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function isContained(parent, child) {
  const realParent = realpathSync(parent);
  const realChild = realpathSync(child);
  const prefix = realParent.endsWith("/") ? realParent : `${realParent}/`;
  return realChild === realParent || realChild.startsWith(prefix);
}

function assertRegularDirectory(path, label) {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) {
    throw new Error(`${label} is not a directory`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink`);
  }
}

function assertContained(parent, child, label) {
  if (!isContained(parent, child)) {
    throw new Error(`${label} is not contained in the runtime parent`);
  }
}

function assertRegularFile(path, label) {
  const stat = lstatSync(path);
  if (!stat.isFile()) {
    throw new Error(`${label} is not a regular file`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink`);
  }
}

function writePromptFile(inputFile, prompt) {
  // Open with O_NOFOLLOW so a symlink swap of the file itself fails instead of
  // writing through the link. The containing directory was already validated.
  const flags = process.constants?.O_NOFOLLOW
    ? 0o100 | 0o1 | process.constants.O_NOFOLLOW // O_CREAT | O_WRONLY | O_NOFOLLOW
    : "wx";
  const fd = openSync(inputFile, flags, FILE_MODE);
  try {
    writeSync(fd, prompt, "utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * @typedef {object} ModelInvocation
 * @property {string} prompt
 * @property {string} model
 * @property {number} deadlineMs
 * @property {number} maxOutputTokens
 */

/**
 * @typedef {object} DecompositionModelInvoker
 * @property {(invocation: ModelInvocation, abortSignal: AbortSignal) => Promise<string>} invoke
 */

/**
 * Create a Pi-backed model invoker.
 *
 * @param {{path:string, version:string, digest:string}} piExecutable - Verified Pi executable identity.
 * @param {string} runtimeParent - Launcher-owned private runtime parent.
 * @returns {DecompositionModelInvoker}
 */
export function createPiModelInvoker(piExecutable, runtimeParent) {
  if (!piExecutable || !resolve(piExecutable.path).startsWith("/")) {
    throw new Error("Pi executable path must be absolute");
  }
  if (!runtimeParent || !resolve(runtimeParent).startsWith("/")) {
    throw new Error("runtime parent must be absolute");
  }
  assertRegularDirectory(runtimeParent, "runtime parent");

  const promptDir = join(runtimeParent, "prompts");
  mkdirSync(promptDir, { recursive: true, mode: DIR_MODE });
  assertContained(runtimeParent, promptDir, "prompt directory");

  return {
    /**
     * Invoke the model selected by runDecomposition.
     *
     * @param {ModelInvocation} invocation
     * @param {AbortSignal} abortSignal
     * @returns {Promise<string>}
     */
    async invoke(invocation, abortSignal) {
      // Reverify the actual Pi executable immediately before every spawn.
      // The digest comparison happens before any Pi bytes execute.
      const verified = verifyPiIdentity(piExecutable.path, trustedInterpreter(), piExecutable.digest);
      if (verified.digest !== piExecutable.digest) {
        throw new Error("Pi executable identity changed since preflight");
      }

      // Revalidate the runtime parent and prompt directory on every invoke to
      // detect symlink races or containment violations after construction.
      assertRegularDirectory(runtimeParent, "runtime parent");
      assertRegularDirectory(promptDir, "prompt directory");
      assertContained(runtimeParent, promptDir, "prompt directory");

      const tmpDir = mkdtempSync(join(promptDir, "prompt-"));
      assertContained(promptDir, tmpDir, "prompt temporary directory");
      assertRegularDirectory(tmpDir, "prompt temporary directory");
      const inputFile = join(tmpDir, "prompt.txt");
      try {
        writePromptFile(inputFile, invocation.prompt);
        assertContained(promptDir, inputFile, "prompt file");
        assertRegularFile(inputFile, "prompt file");

        const args = [
          "--package", process.env.AGENT_POOL_PACKAGE_ROOT,
          "--settings", process.env.AGENT_POOL_SETTINGS_PATH,
          "--agent-dir", process.env.AGENT_POOL_AGENT_DIR,
          "--skill-dir", process.env.AGENT_POOL_SKILL_DIR,
          "--no-plugins",
          "--no-auto-discover",
          "--model", invocation.model,
          "run", "spec-decomposer",
          "--input", inputFile,
        ];

        return await new Promise((resolvePromise, rejectPromise) => {
          const child = spawn(trustedInterpreter(), [piExecutable.path, ...args], {
            env: {
              AGENT_POOL_PACKAGE_ROOT: process.env.AGENT_POOL_PACKAGE_ROOT,
              AGENT_POOL_SETTINGS_PATH: process.env.AGENT_POOL_SETTINGS_PATH,
              AGENT_POOL_AGENT_DIR: process.env.AGENT_POOL_AGENT_DIR,
              AGENT_POOL_SKILL_DIR: process.env.AGENT_POOL_SKILL_DIR,
              AGENT_POOL_HOME: process.env.AGENT_POOL_HOME,
              AGENT_POOL_XDG_CONFIG_HOME: process.env.AGENT_POOL_XDG_CONFIG_HOME,
              HOME: process.env.HOME,
              XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
              PATH: trustedPath(),
            },
            stdio: ["ignore", "pipe", "pipe"],
          });

          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (data) => { stdout += data; });
          child.stderr.on("data", (data) => { stderr += data; });

          const timeout = setTimeout(() => {
            child.kill();
            rejectPromise(new Error("TIMEOUT"));
          }, invocation.deadlineMs);

          child.on("exit", (code) => {
            clearTimeout(timeout);
            if (code !== 0) {
              rejectPromise(new Error(`Pi model invocation failed: ${stderr || "unknown error"}`));
            } else {
              resolvePromise(stdout);
            }
          });

          if (abortSignal) {
            abortSignal.addEventListener("abort", () => {
              child.kill();
              clearTimeout(timeout);
              rejectPromise(new Error("ABORTED"));
            }, { once: true });
          }
        });
      } finally {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup.
        }
      }
    },
  };
}
