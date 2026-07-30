import { spawn } from "node:child_process";
import { stat, lstat, readdir, readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, isAbsolute, relative, normalize } from "node:path";
import { validateExecutablePath, isOutsideResolvedRoot, resolveRealAbsolutePath } from "./path-safety.ts";
import type { RepoIdentity, SourceManifest, ManifestEntry } from "./contracts.ts";

const GIT_BASE_ENV: Record<string, string> = {
  LANG: "C",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
};

const EXCLUDED_NAMES = new Set([".git", ".agent-pool", "node_modules", "graphify-out"]);

function gitArgv(gitPath: string, targetRoot: string, subCmd: string, subArgs: string[]): string[] {
  return [
    gitPath,
    "--no-pager",
    "--no-optional-locks",
    "-C",
    targetRoot,
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "credential.helper=",
    "-c",
    "core.sshCommand=false",
    "-c",
    "protocol.allow=never",
    subCmd,
    ...subArgs,
  ];
}

async function runGit(argv: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      shell: false,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code !== 0) reject(new Error(`git failed (${code}): ${stderr.trim()}`));
      else resolvePromise(stdout.trim());
    });
  });
}

export interface GitStatus {
  entries: Array<{ line: string; path: string }>;
  clean: boolean;
}

export function buildGitEnv({ home, xdgConfig }: { home?: string; xdgConfig?: string } = {}): Record<string, string> {
  const env = { ...GIT_BASE_ENV };
  if (home) env.HOME = home;
  if (xdgConfig) env.XDG_CONFIG_HOME = xdgConfig;
  return Object.freeze(env);
}

async function assertContainedTargetRoot(targetRoot: string): Promise<string> {
  if (!isAbsolute(targetRoot)) throw new Error("target root must be absolute");
  const resolved = resolve(targetRoot);
  let info;
  try {
    info = await stat(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error("target root does not exist");
    throw err;
  }
  if (!info.isDirectory()) throw new Error("target root is not a directory");
  const real = await realpath(resolved);
  if (!isAbsolute(real)) throw new Error("target root resolved to a non-absolute path");
  return real;
}

export async function resolveHead(gitPath: string, targetRoot: string): Promise<string> {
  await validateExecutablePath(gitPath);
  const root = await assertContainedTargetRoot(targetRoot);
  const argv = gitArgv(gitPath, root, "rev-parse", ["--verify", "HEAD^{commit}"]);
  const head = await runGit(argv, buildGitEnv());
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("git returned an invalid head SHA");
  return head;
}

export async function resolveStatus(gitPath: string, targetRoot: string): Promise<GitStatus> {
  await validateExecutablePath(gitPath);
  const root = await assertContainedTargetRoot(targetRoot);
  const argv = gitArgv(gitPath, root, "status", [
    "--porcelain=v2",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);
  const output = await runGit(argv, buildGitEnv());
  const entries = output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      return { line, path: parts[parts.length - 1] };
    });
  return { entries, clean: entries.length === 0 };
}

export function normalizeRelativePath(raw: string): string {
  if (typeof raw !== "string" || raw === "") throw new Error("relative path must be a non-empty string");
  if (raw.includes("\0")) throw new Error("relative path contains NUL");
  const cleaned = normalize(raw).replace(/^\.\//, "").replace(/\/+/g, "/");
  if (cleaned.startsWith("/")) throw new Error("relative path must not be absolute");
  if (cleaned.startsWith("..") || cleaned.includes("/../")) throw new Error("relative path outside target root");
  return cleaned;
}

export function manifestDigest(entries: ManifestEntry[]): string {
  const hash = createHash("sha256");
  const sorted = [...entries].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  for (const e of sorted) {
    hash.update(e.relativePath);
    hash.update("\0");
    hash.update(String(e.mode));
    hash.update("\0");
    hash.update(String(e.size));
    hash.update("\0");
    hash.update(e.digest);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  const data = await readFile(path);
  hash.update(data);
  return `sha256:${hash.digest("hex")}`;
}

async function walk(root: string, current: string, entries: ManifestEntry[]): Promise<void> {
  const names = await readdir(current);
  for (const name of names) {
    if (EXCLUDED_NAMES.has(name)) continue;
    const full = resolve(current, name);
    const info = await lstat(full);
    const rel = normalizeRelativePath(relative(root, full));
    if (info.isSymbolicLink()) {
      continue;
    } else if (info.isDirectory()) {
      await walk(root, full, entries);
    } else if (info.isFile()) {
      entries.push({
        relativePath: rel,
        type: "file",
        mode: info.mode,
        size: info.size,
        digest: await fileDigest(full),
      });
    }
  }
}

export async function captureManifest(repository: RepoIdentity, head: string, targetRoot: string): Promise<SourceManifest> {
  if (!isAbsolute(targetRoot)) throw new Error("target root must be absolute");
  const root = await resolveRealAbsolutePath(targetRoot);
  const entries: ManifestEntry[] = [];
  await walk(root, root, entries);
  const digest = manifestDigest(entries);
  return { repository, head, entries, digest };
}

/**
 * @deprecated Use {@link isOutsideRealRoot} for runtime containment checks.
 * Kept for callers that already have resolved realpaths.
 */
export function isOutsideTarget(targetRoot: string, candidate: string): boolean {
  const target = resolve(targetRoot);
  const real = resolve(candidate);
  // Ensure candidate is not equal to target and not inside target.
  if (real === target) return false;
  const prefix = `${target}/`;
  return !real.startsWith(prefix);
}

/** Return true if `candidate` is outside `targetRoot` after realpath resolution. */
export async function isOutsideRealTarget(targetRoot: string, candidate: string): Promise<boolean> {
  const targetReal = await resolveRealAbsolutePath(targetRoot);
  const candidateReal = await resolveRealAbsolutePath(candidate);
  return isOutsideResolvedRoot(targetReal, candidateReal);
}
