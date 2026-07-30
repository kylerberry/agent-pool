import { resolve, isAbsolute, join } from "node:path";
import { rm, mkdir } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { captureManifest, resolveHead, resolveStatus, isOutsideTarget, isOutsideRealTarget } from "./target-repository.ts";
import { materializeProjection } from "./scratch-projection.ts";
import { runGraphify, readGraphifyGraph } from "./graphify-adapter.ts";
import { openCache, writeCache, publishBlob } from "./controller-index-cache.ts";
import { discoverDocumentation } from "./documentation-discovery.ts";
import { breadthRetrieval, validateGraphAgainstManifest } from "./breadth-retrieval.ts";
import { derivePredictedTouch } from "./predicted-touch.ts";
import { validateExecutablePath, resolveRealAbsolutePath, isOutsideResolvedRoot } from "./path-safety.ts";
import { lstat } from "node:fs/promises";
import {
  makeIndexRevision,
  cacheKey,
  assertIndexRequest,
  INDEX_SCHEMA_VERSION,
  assertGraphifyGraph,
  DEFAULT_SENSITIVE_PATH_POLICY,
} from "./contracts.ts";
import type {
  IndexRequest,
  IndexRevision,
  SourceManifest,
  BreadthResult,
  PredictedTouchEvidence,
  DocumentationResult,
  CacheRecord,
} from "./contracts.ts";

export interface BuildResult {
  revision: IndexRevision;
  graphPath: string;
  manifest: SourceManifest;
}

async function createAttemptScratch(scratchRoot: string): Promise<string> {
  const attempt = join(scratchRoot, `attempt-${Date.now()}-${randomBytes(4).toString("hex")}`);
  await mkdir(attempt, { recursive: true, mode: 0o700 });
  return attempt;
}

async function verifyTargetIntegrity(
  gitPath: string,
  targetRoot: string,
  before: SourceManifest,
  after: SourceManifest,
): Promise<void> {
  if (before.head !== after.head) throw new Error("target head changed during indexing");
  if (before.digest !== after.digest) throw new Error("target manifest changed during indexing");
  const status = await resolveStatus(gitPath, targetRoot);
  if (!status.clean) throw new Error("target worktree is not clean");
}

export async function buildIndex(request: IndexRequest): Promise<BuildResult> {
  return indexLifecycle(request, false);
}

export async function refreshIndex(request: IndexRequest): Promise<BuildResult> {
  return indexLifecycle(request, true);
}

async function indexLifecycle(request: IndexRequest, _refresh: boolean): Promise<BuildResult> {
  assertIndexRequest(request);
  if (!isAbsolute(request.targetRoot)) throw new Error("target root must be absolute");
  if (!isAbsolute(request.scratchRoot)) throw new Error("scratch root must be absolute");
  if (!isAbsolute(request.cacheRoot)) throw new Error("cache root must be absolute");

  await validateExecutablePath(request.gitPath);
  await validateExecutablePath(request.graphifyPath);

  const targetRoot = await resolveRealAbsolutePath(request.targetRoot);

  // Fast lexical containment check before creating anything. Rejects obvious
  // containment violations even when the path does not yet exist.
  if (!isOutsideTarget(targetRoot, request.scratchRoot)) {
    throw new Error("scratch root must be outside target repository");
  }
  if (!isOutsideTarget(targetRoot, request.cacheRoot)) {
    throw new Error("cache root must be outside target repository");
  }

  // Create roots and realpath them to catch symlinked parent directories.
  // Reject if the final path component is itself a symlink (target-controlled).
  await mkdir(request.scratchRoot, { recursive: true, mode: 0o700 });
  await mkdir(request.cacheRoot, { recursive: true, mode: 0o700 });
  if ((await lstat(request.scratchRoot)).isSymbolicLink()) {
    throw new Error("scratch root must not be a symlink");
  }
  if ((await lstat(request.cacheRoot)).isSymbolicLink()) {
    throw new Error("cache root must not be a symlink");
  }
  const scratchRoot = await resolveRealAbsolutePath(request.scratchRoot);
  const cacheRoot = await resolveRealAbsolutePath(request.cacheRoot);

  if (!(await isOutsideRealTarget(targetRoot, scratchRoot))) {
    throw new Error("scratch root must be outside target repository");
  }
  if (!(await isOutsideRealTarget(targetRoot, cacheRoot))) {
    throw new Error("cache root must be outside target repository");
  }

  const policy = request.sensitivePathPolicy ?? DEFAULT_SENSITIVE_PATH_POLICY;
  const gitPath = request.gitPath;
  const scratch = await createAttemptScratch(scratchRoot);
  const cache = await openCache(cacheRoot, { targetRoot });

  try {
    const beforeHead = await resolveHead(gitPath, targetRoot);
    if (request.expectedHead !== "HEAD" && beforeHead !== request.expectedHead) {
      throw new Error(`head mismatch: expected ${request.expectedHead}, got ${beforeHead}`);
    }

    const beforeManifest = await captureManifest(request.repository, beforeHead, targetRoot);

    // Re-check head after manifest capture to detect mid-build races.
    const recheckHead = await resolveHead(gitPath, targetRoot);
    if (recheckHead !== beforeHead) throw new Error("target head changed between capture and projection");

    const projectionRoot = await materializeProjection(beforeManifest, targetRoot, scratch, { policy });
    const { graphPath: rawGraphPath } = await runGraphify(request, projectionRoot);

    // Resolve HEAD again after Graphify completes to ensure no repository mutation occurred.
    const afterHead = await resolveHead(gitPath, targetRoot);
    const afterManifest = await captureManifest(request.repository, afterHead, targetRoot);
    await verifyTargetIntegrity(gitPath, targetRoot, beforeManifest, afterManifest);

    const rawGraph = await readGraphifyGraph(rawGraphPath);
    assertGraphifyGraph(rawGraph);
    // Pre-publish validation: nodes and links must be consistent with the manifest.
    await validateGraphPrePublish(rawGraph, beforeManifest);

    const revision = makeIndexRevision(
      request.repository,
      afterHead,
      request.graphifyVersion,
      request.indexSchemaVersion,
      beforeManifest.digest,
      policy,
    );

    const graphData = JSON.stringify(rawGraph);
    const graphDigest = createHash("sha256").update(graphData).digest("hex");
    const blobPath = await publishBlob(cache, revision, graphData);

    const record: CacheRecord = {
      key: cacheKey(revision),
      revision,
      manifest: beforeManifest,
      graphPath: blobPath,
      createdAt: Date.now(),
      integrity: { algorithm: "sha256", digest: graphDigest },
    };

    await writeCache(cache, record);

    return { revision, graphPath: blobPath, manifest: beforeManifest };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function validateGraphPrePublish(graph: unknown, manifest: SourceManifest): void {
  // Validate before cache publication so bad graphs never become cache records.
  const typed = assertGraphifyGraph(graph);
  validateGraphAgainstManifest(typed, manifest);
}

export async function discoverTargetDocumentation(
  request: IndexRequest,
  options: { maxPages?: number; maxDepth?: number } = {},
): Promise<DocumentationResult> {
  assertIndexRequest(request);
  if (!isAbsolute(request.targetRoot)) throw new Error("target root must be absolute");
  const gitPath = request.gitPath;
  await validateExecutablePath(gitPath);
  const targetRoot = await resolveRealAbsolutePath(request.targetRoot);
  const head = await resolveHead(gitPath, targetRoot);
  const manifest = await captureManifest(request.repository, head, targetRoot);
  return discoverDocumentation(manifest, {
    sourceRoot: targetRoot,
    maxPages: 100,
    maxDepth: 3,
    ...options,
  });
}

export { breadthRetrieval, derivePredictedTouch, INDEX_SCHEMA_VERSION };
