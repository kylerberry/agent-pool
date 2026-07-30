/**
 * Codebase Knowledge — immutable request/result contracts.
 *
 * These shapes are plain objects; runtime validation is performed by the
 * functions that consume them. Keeping the contract file dependency-free lets
 * architecture tests import it without pulling in subprocess or filesystem code.
 */

export const INDEX_SCHEMA_VERSION = "1";
export const ALGORITHM_VERSION = "1";
export const SENSITIVE_PATH_POLICY_VERSION = "1";

/** Controller-owned sensitive-path policy. Versioned and independent of
 *  content-level secret scanning, which remains a deferred ADR-032 residual. */
export interface SensitivePathPolicy {
  version: string;
  patterns: string[];
}

export const DEFAULT_SENSITIVE_PATH_POLICY: SensitivePathPolicy = Object.freeze({
  version: SENSITIVE_PATH_POLICY_VERSION,
  patterns: Object.freeze([
    ".env",
    ".env.*",
    "*credentials*",
    "*secret*",
    "*private*",
    "*key*",
    "*token*",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    ".ssh/*",
    ".agent-pool/*",
  ]) as string[],
});

export function isSensitivePath(relativePath: string, policy: SensitivePathPolicy = DEFAULT_SENSITIVE_PATH_POLICY): boolean {
  if (typeof relativePath !== "string" || relativePath === "") return false;
  const normalized = relativePath.replace(/\\/g, "/");
  for (const pattern of policy.patterns) {
    if (matchSensitivePattern(normalized, pattern)) return true;
  }
  return false;
}

function matchSensitivePattern(path: string, pattern: string): boolean {
  if (pattern.includes("/")) {
    // Directory-aware prefix/glob patterns.
    const parts = pattern.split("/");
    const pathParts = path.split("/");
    return matchParts(parts, pathParts, 0, 0);
  }
  // Basename-only wildcard.
  const base = path.split("/").pop() || path;
  return globMatch(base, pattern);
}

function matchParts(patternParts: string[], pathParts: string[], pi: number, si: number): boolean {
  while (pi < patternParts.length) {
    const p = patternParts[pi];
    if (p === "*") {
      // Greedy directory wildcard: advance path index until rest matches.
      for (let i = si; i <= pathParts.length; i++) {
        if (matchParts(patternParts, pathParts, pi + 1, i)) return true;
      }
      return false;
    }
    if (si >= pathParts.length) return false;
    if (!globMatch(pathParts[si], p)) return false;
    pi++;
    si++;
  }
  return si === pathParts.length;
}

function globMatch(value: string, pattern: string): boolean {
  if (!pattern.includes("*")) return value === pattern;
  const parts = pattern.split("*");
  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === "") continue;
    const idx = value.indexOf(part, pos);
    if (idx === -1) return false;
    if (i === 0 && idx !== 0) return false;
    pos = idx + part.length;
  }
  if (parts[parts.length - 1] !== "" && pos !== value.length) return false;
  return true;
}

/** Canonical repository identity. */
export interface RepoIdentity {
  owner: string;
  name: string;
}

/** Immutable index revision metadata. */
export interface IndexRevision {
  repository: RepoIdentity;
  head: string;
  graphifyVersion: string;
  indexSchemaVersion: string;
  sensitivePathPolicyVersion: string;
  manifestDigest: string;
  indexRevision: string;
  createdAt: string;
}

/** Build/refresh request. */
export interface IndexRequest {
  repository: RepoIdentity;
  expectedHead: string;
  targetRoot: string;
  gitPath: string;
  graphifyPath: string;
  graphifyVersion: string;
  indexSchemaVersion: string;
  sensitivePathPolicy?: SensitivePathPolicy;
  scratchRoot: string;
  cacheRoot: string;
}

/** Canonical source manifest entry. */
export interface ManifestEntry {
  relativePath: string;
  type: "file";
  mode: number;
  size: number;
  digest: string;
}

/** Canonical source manifest. */
export interface SourceManifest {
  repository: RepoIdentity;
  head: string;
  entries: ManifestEntry[];
  digest: string;
}

/** A node in a Graphify graph.json output. */
export interface GraphifyNode {
  id: string;
  label?: string;
  source_file?: string;
  file_type?: string;
  community?: number;
  [key: string]: unknown;
}

/** A link/edge in a Graphify graph.json output (node-link schema). */
export interface GraphifyLink {
  source: string;
  target: string;
  relation?: string;
  label?: string;
  confidence?: string;
  [key: string]: unknown;
}

/** Raw Graphify graph.json shape (node-link). */
export interface GraphifyGraph {
  nodes: GraphifyNode[];
  links: GraphifyLink[];
  [key: string]: unknown;
}

/** Graph unit returned by breadth retrieval. */
export interface GraphUnit {
  id: string;
  label: string;
  kind: string;
  sourcePath: string;
  community?: number;
}

/** Dependency edge returned by breadth retrieval. */
export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
}

/** Breadth retrieval result. */
export interface BreadthResult {
  revision: IndexRevision;
  units: GraphUnit[];
  edges: GraphEdge[];
  truncated: boolean;
  truncationReason?: string;
}

/** Predicted-touch evidence (controller-only). */
export interface PredictedTouchEvidence {
  indexRevision: IndexRevision;
  proposedUnits: string[];
  likelyUnits: string[];
  sharedSurfaces: Array<{ unitA: string; unitB: string; surface: string }>;
  sourceProvenance: Array<{ unit: string; sourcePath: string }>;
  confidenceBasis: string;
  algorithmVersion: string;
  gate1FreezeId?: string;
}

/** Documentation page with raw-source provenance. */
export interface DocumentationPage {
  title: string;
  sourcePath: string;
  rawSourcePath: string;
  indexPath?: string;
}

/** Documentation discovery capability result. */
export interface DocumentationResult {
  available: boolean;
  status: "available" | "unavailable" | "malformed" | "truncated";
  pages: DocumentationPage[];
  reason?: string;
}

/** Cache record envelope. */
export interface CacheRecord {
  key: string;
  revision: IndexRevision;
  manifest: SourceManifest;
  graphPath: string;
  createdAt: number;
  integrity: { algorithm: string; digest: string };
}

/** Cache policy. */
export interface CachePolicy {
  maxBytes: number;
  maxAgeMs: number;
  maxEntries: number;
}

/** Opened cache handle. */
export interface CacheHandle extends CachePolicy {
  root: string;
}

export function assertRepoIdentity(value: unknown): RepoIdentity {
  if (!value || typeof value !== "object") throw new Error("repository identity must be an object");
  const obj = value as Record<string, unknown>;
  if (typeof obj.owner !== "string" || obj.owner.trim() === "") {
    throw new Error("repository owner must be a non-empty string");
  }
  if (typeof obj.name !== "string" || obj.name.trim() === "") {
    throw new Error("repository name must be a non-empty string");
  }
  return { owner: obj.owner, name: obj.name };
}

export function assertIndexRevision(value: unknown): IndexRevision {
  if (!value || typeof value !== "object") throw new Error("index revision must be an object");
  const obj = value as Record<string, unknown>;
  const repository = assertRepoIdentity(obj.repository);
  if (typeof obj.head !== "string" || !/^[0-9a-f]{40}$/.test(obj.head)) {
    throw new Error("index revision head must be a full 40-character SHA");
  }
  if (typeof obj.graphifyVersion !== "string" || obj.graphifyVersion.trim() === "") {
    throw new Error("graphify version must be a non-empty string");
  }
  if (typeof obj.indexSchemaVersion !== "string" || obj.indexSchemaVersion.trim() === "") {
    throw new Error("index schema version must be a non-empty string");
  }
  if (typeof obj.sensitivePathPolicyVersion !== "string" || obj.sensitivePathPolicyVersion.trim() === "") {
    throw new Error("sensitive path policy version must be a non-empty string");
  }
  if (typeof obj.manifestDigest !== "string" || !obj.manifestDigest.startsWith("sha256:")) {
    throw new Error("manifest digest must be a sha256-prefixed string");
  }
  if (typeof obj.indexRevision !== "string" || obj.indexRevision.trim() === "") {
    throw new Error("index revision id must be a non-empty string");
  }
  if (typeof obj.createdAt !== "string" || Number.isNaN(Date.parse(obj.createdAt))) {
    throw new Error("createdAt must be an ISO timestamp");
  }
  return {
    repository,
    head: obj.head,
    graphifyVersion: obj.graphifyVersion,
    indexSchemaVersion: obj.indexSchemaVersion,
    sensitivePathPolicyVersion: obj.sensitivePathPolicyVersion,
    manifestDigest: obj.manifestDigest,
    indexRevision: obj.indexRevision,
    createdAt: obj.createdAt,
  };
}

export function makeIndexRevision(
  repository: RepoIdentity,
  head: string,
  graphifyVersion: string,
  indexSchemaVersion: string,
  manifestDigest: string,
  sensitivePathPolicy: SensitivePathPolicy = DEFAULT_SENSITIVE_PATH_POLICY,
): IndexRevision {
  const payload = JSON.stringify([
    repository.owner,
    repository.name,
    head,
    graphifyVersion,
    indexSchemaVersion,
    sensitivePathPolicy.version,
    manifestDigest,
  ]);
  const indexRevision = Buffer.from(payload).toString("base64url");
  return {
    repository,
    head,
    graphifyVersion,
    indexSchemaVersion,
    sensitivePathPolicyVersion: sensitivePathPolicy.version,
    manifestDigest,
    indexRevision,
    createdAt: new Date().toISOString(),
  };
}

export function cacheKey(revision: IndexRevision): string {
  return [
    revision.repository.owner,
    revision.repository.name,
    revision.head,
    revision.graphifyVersion,
    revision.indexSchemaVersion,
    revision.sensitivePathPolicyVersion,
    revision.manifestDigest,
  ].join(":");
}

export function assertCacheRecord(value: unknown): CacheRecord {
  if (!value || typeof value !== "object") throw new Error("cache record must be an object");
  const obj = value as Record<string, unknown>;
  if (typeof obj.key !== "string" || obj.key.trim() === "") throw new Error("cache record key is required");
  const revision = assertIndexRevision(obj.revision);
  if (!obj.manifest || typeof obj.manifest !== "object") throw new Error("cache record manifest is required");
  if (typeof obj.graphPath !== "string") throw new Error("cache record graphPath is required");
  if (typeof obj.createdAt !== "number") throw new Error("cache record createdAt is required");
  const integrity = obj.integrity as Record<string, unknown> | undefined;
  if (!integrity || integrity.algorithm !== "sha256" || typeof integrity.digest !== "string") {
    throw new Error("cache record integrity must be sha256 digest");
  }
  return {
    key: obj.key,
    revision,
    manifest: obj.manifest as SourceManifest,
    graphPath: obj.graphPath,
    createdAt: obj.createdAt,
    integrity: { algorithm: "sha256", digest: integrity.digest },
  };
}

export function assertGraphifyGraph(value: unknown): GraphifyGraph {
  if (!value || typeof value !== "object") throw new Error("graph must be an object");
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.nodes)) throw new Error("graph.nodes must be an array");
  if (!Array.isArray(obj.links)) throw new Error("graph.links must be an array");
  return { nodes: obj.nodes as GraphifyNode[], links: obj.links as GraphifyLink[] };
}

export function assertIndexRequest(value: unknown): IndexRequest {
  if (!value || typeof value !== "object") throw new Error("request must be an object");
  const obj = value as Record<string, unknown>;
  const repository = assertRepoIdentity(obj.repository);
  if (typeof obj.expectedHead !== "string") throw new Error("expectedHead is required");
  if (typeof obj.targetRoot !== "string") throw new Error("targetRoot is required");
  if (typeof obj.graphifyPath !== "string") throw new Error("graphifyPath is required");
  if (typeof obj.gitPath !== "string") throw new Error("gitPath is required");
  if (typeof obj.graphifyVersion !== "string") throw new Error("graphifyVersion is required");
  if (typeof obj.indexSchemaVersion !== "string") throw new Error("indexSchemaVersion is required");
  if (typeof obj.scratchRoot !== "string") throw new Error("scratchRoot is required");
  if (typeof obj.cacheRoot !== "string") throw new Error("cacheRoot is required");
  return {
    repository,
    expectedHead: obj.expectedHead,
    targetRoot: obj.targetRoot,
    gitPath: obj.gitPath,
    graphifyPath: obj.graphifyPath,
    graphifyVersion: obj.graphifyVersion,
    indexSchemaVersion: obj.indexSchemaVersion,
    sensitivePathPolicy: obj.sensitivePathPolicy as SensitivePathPolicy | undefined,
    scratchRoot: obj.scratchRoot,
    cacheRoot: obj.cacheRoot,
  };
}
