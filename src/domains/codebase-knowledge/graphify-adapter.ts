import { spawn } from "node:child_process";
import { isAbsolute, resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { validateExecutablePath } from "./path-safety.ts";
import type { IndexRequest } from "./contracts.ts";

export interface GraphifyResult {
  graphPath: string;
  output: string;
}

export function buildGraphifyEnv({
  home,
  xdgConfig,
  xdgCache,
  xdgData,
  tmpdir,
}: {
  home?: string;
  xdgConfig?: string;
  xdgCache?: string;
  xdgData?: string;
  tmpdir?: string;
} = {}): Record<string, string> {
  const env: Record<string, string> = {
    LANG: "C",
    LC_ALL: "C",
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  };
  if (home) env.HOME = home;
  if (xdgConfig) env.XDG_CONFIG_HOME = xdgConfig;
  if (xdgCache) env.XDG_CACHE_HOME = xdgCache;
  if (xdgData) env.XDG_DATA_HOME = xdgData;
  if (tmpdir) env.TMPDIR = tmpdir;
  return Object.freeze(env);
}

async function graphifyVersion(graphifyPath: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(graphifyPath, ["--version"], {
      shell: false,
      env: { LANG: "C", LC_ALL: "C", PATH: process.env.PATH || "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code !== 0) reject(new Error(`graphify --version failed (${code}): ${stderr.trim()}`));
      else {
        const match = /^graphify\s+v?(\d+\.\d+\.\d+)$/m.exec(stdout.trim());
        if (!match) reject(new Error(`unexpected graphify --version output: ${stdout.trim()}`));
        else resolvePromise(match[1]);
      }
    });
  });
}

export async function runGraphify(request: IndexRequest, projectionRoot: string): Promise<GraphifyResult> {
  await validateExecutablePath(request.graphifyPath);
  if (!isAbsolute(projectionRoot)) throw new Error("projection root must be absolute");

  // Exact structural-only invocation: no generic argv extension.
  const actualVersion = await graphifyVersion(request.graphifyPath);
  if (request.graphifyVersion !== actualVersion) {
    throw new Error(
      `graphify version mismatch: expected ${request.graphifyVersion}, got ${actualVersion}`,
    );
  }

  const argv = [request.graphifyPath, projectionRoot, "--no-viz"];
  const cwd = resolve(projectionRoot, "..");
  await mkdir(cwd, { recursive: true });

  const env = buildGraphifyEnv();
  const output = await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      shell: false,
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code !== 0) reject(new Error(`graphify failed (${code}): ${stderr.trim() || stdout.trim()}`));
      else resolvePromise(stdout.trim());
    });
  });

  const graphPath = join(projectionRoot, "graphify-out", "graph.json");
  if (!existsSync(graphPath)) {
    throw new Error(`graphify did not produce expected output: ${graphPath}`);
  }
  return { graphPath, output };
}

export async function readGraphifyGraph(graphPath: string): Promise<unknown> {
  const text = await readFile(graphPath, "utf8");
  return JSON.parse(text);
}
