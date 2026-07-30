export {
  INDEX_SCHEMA_VERSION,
  ALGORITHM_VERSION,
  makeIndexRevision,
  cacheKey,
  assertRepoIdentity,
  assertIndexRevision,
  assertCacheRecord,
  assertGraphifyGraph,
  assertIndexRequest,
} from "./contracts.ts";

export type {
  RepoIdentity,
  IndexRevision,
  IndexRequest,
  ManifestEntry,
  SourceManifest,
  GraphifyNode,
  GraphifyLink,
  GraphifyGraph,
  GraphUnit,
  GraphEdge,
  BreadthResult,
  PredictedTouchEvidence,
  DocumentationPage,
  DocumentationResult,
  CacheRecord,
  CachePolicy,
  CacheHandle,
} from "./contracts.ts";

export {
  resolveHead,
  resolveStatus,
  buildGitEnv,
  captureManifest,
  normalizeRelativePath,
  manifestDigest,
  isOutsideTarget,
} from "./target-repository.ts";

export type { GitStatus } from "./target-repository.ts";

export { buildGraphifyEnv, runGraphify, readGraphifyGraph } from "./graphify-adapter.ts";
export type { GraphifyResult } from "./graphify-adapter.ts";

export { isStructuralCodeFile, materializeProjection } from "./scratch-projection.ts";

export { openCache, readCache, writeCache, evictCache, publishBlob } from "./controller-index-cache.ts";
export type { OpenCacheOptions } from "./controller-index-cache.ts";

export { breadthRetrieval } from "./breadth-retrieval.ts";
export type { BreadthQuery } from "./breadth-retrieval.ts";

export { derivePredictedTouch } from "./predicted-touch.ts";

export {
  discoverDocumentation,
  parseMarkdownLinks,
  parseObsidianLinks,
} from "./documentation-discovery.ts";
export type { DocumentationOptions } from "./documentation-discovery.ts";

export {
  buildIndex,
  refreshIndex,
  discoverTargetDocumentation,
} from "./graph-index.ts";
export type { BuildResult } from "./graph-index.ts";
