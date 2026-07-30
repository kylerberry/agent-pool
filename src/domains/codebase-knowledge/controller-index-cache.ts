import { mkdir, writeFile, readFile, readdir, rm, stat, rename, lstat } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { resolve, isAbsolute, join, dirname, relative } from "node:path";
import type { CacheHandle, CacheRecord, CachePolicy, IndexRevision } from "./contracts.ts";
import { assertCacheRecord, assertIndexRevision, cacheKey } from "./contracts.ts";
import { resolveRealAbsolutePath, isOutsideResolvedRoot } from "./path-safety.ts";

export type { CacheHandle };

const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024; // 1 GiB
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_MAX_ENTRIES = 100;

export interface OpenCacheOptions extends Partial<CachePolicy> {
  targetRoot?: string;
}

async function assertSafeRoot(root: string, targetRoot?: string): Promise<string> {
  if (typeof root !== "string" || root === "") throw new Error("cache root is required");
  if (!isAbsolute(root)) throw new Error("cache root must be absolute");
  const resolved = await resolveRealAbsolutePath(root);
  const lower = resolved.toLowerCase();
  if (lower.includes("/.agent-pool/") || lower.endsWith("/.agent-pool")) {
    throw new Error("forbidden cache root: must not live under .agent-pool");
  }
  if (lower.includes("/docs/") || lower.endsWith("/docs")) {
    throw new Error("forbidden cache root: must not live under product documentation");
  }
  if (targetRoot) {
    const target = await resolveRealAbsolutePath(targetRoot);
    if (resolved === target || !isOutsideResolvedRoot(target, resolved)) {
      throw new Error("forbidden cache root: must not reside inside target repository");
    }
  }
  return resolved;
}

function recordDir(root: string, key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return join(root, hash.slice(0, 2), hash.slice(2));
}

function recordPath(root: string, key: string): string {
  return join(recordDir(root, key), "record.json");
}

export async function openCache(root: string, options: OpenCacheOptions = {}): Promise<CacheHandle> {
  const safeRoot = await assertSafeRoot(root, options.targetRoot);
  await mkdir(safeRoot, { recursive: true, mode: 0o700 });
  return {
    root: safeRoot,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    maxAgeMs: options.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
    maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
  };
}

interface EntryInfo {
  recordPath: string;
  recordDir: string;
  mtime: number;
  recordSize: number;
  blobPath: string;
  blobSize: number;
}

interface OrphanBlob {
  path: string;
  size: number;
  mtime: number;
}

async function listBlobs(root: string): Promise<Map<string, { size: number; mtime: number }>> {
  const blobs = new Map<string, { size: number; mtime: number }>();
  const blobsDir = join(root, "blobs");
  let names: string[];
  try {
    names = await readdir(blobsDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return blobs;
    throw err;
  }
  for (const name of names) {
    const path = join(blobsDir, name);
    try {
      const st = await stat(path);
      if (st.isFile()) blobs.set(path, { size: st.size, mtime: st.mtime.getTime() });
    } catch { /* ignore */ }
  }
  return blobs;
}

async function listEntries(root: string): Promise<EntryInfo[]> {
  const entries: EntryInfo[] = [];
  let topNames: string[];
  try {
    topNames = await readdir(root);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }
  for (const top of topNames) {
    const topPath = join(root, top);
    const topStat = await stat(topPath);
    if (!topStat.isDirectory() || top === "blobs") continue;
    for (const mid of await readdir(topPath)) {
      const midPath = join(topPath, mid);
      const midStat = await stat(midPath);
      if (!midStat.isDirectory()) continue;
      const recFile = join(midPath, "record.json");
      try {
        const st = await stat(recFile);
        let blobPath = "";
        let blobSize = 0;
        try {
          const raw = await readFile(recFile, "utf8");
          const parsed = JSON.parse(raw) as CacheRecord;
          blobPath = parsed.graphPath;
          const blobStat = await stat(blobPath);
          blobSize = blobStat.size;
        } catch {
          // If record or blob is unreadable, count only record size.
        }
        entries.push({
          recordPath: recFile,
          recordDir: midPath,
          mtime: st.mtime.getTime(),
          recordSize: st.size,
          blobPath,
          blobSize,
        });
      } catch { /* ignore */ }
    }
  }
  return entries;
}

async function scanCache(root: string): Promise<{ entries: EntryInfo[]; orphans: OrphanBlob[]; totalBytes: number }> {
  const entries = await listEntries(root);
  const blobs = await listBlobs(root);
  const referenced = new Set<string>();
  let totalBytes = 0;
  for (const e of entries) {
    if (e.blobPath) referenced.add(e.blobPath);
    totalBytes += e.recordSize + e.blobSize;
  }
  const orphans: OrphanBlob[] = [];
  for (const [path, { size, mtime }] of blobs) {
    if (!referenced.has(path)) {
      orphans.push({ path, size, mtime });
      totalBytes += size;
    }
  }
  return { entries, orphans, totalBytes };
}

export async function readCache(cache: CacheHandle, key: string): Promise<CacheRecord | undefined> {
  if (!cache || !cache.root) throw new Error("cache not opened");
  const path = recordPath(cache.root, key);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw err;
  }
  let record: CacheRecord;
  try {
    record = assertCacheRecord(JSON.parse(raw));
  } catch {
    return undefined;
  }
  if (record.key !== key) return undefined;

  const now = Date.now();
  if (now - record.createdAt > cache.maxAgeMs) return undefined;

  // Validate graphPath containment: must be inside cache root.
  const graphReal = await resolveRealAbsolutePath(record.graphPath);
  const rootReal = cache.root;
  if (isOutsideResolvedRoot(rootReal, graphReal)) return undefined;

  try {
    const graphData = await readFile(record.graphPath);
    const graphDigest = createHash("sha256").update(graphData).digest("hex");
    if (graphDigest !== record.integrity.digest) return undefined;
  } catch {
    return undefined;
  }

  return record;
}

export async function writeCache(cache: CacheHandle, record: CacheRecord): Promise<void> {
  if (!cache || !cache.root) throw new Error("cache not opened");
  if (cache.root !== (await resolveRealAbsolutePath(cache.root))) {
    throw new Error("cache root must be a real path");
  }
  assertCacheRecord(record);
  const expectedKey = cacheKey(record.revision);
  if (record.key !== expectedKey) {
    throw new Error(`cache record key does not match derived key: ${record.key} !== ${expectedKey}`);
  }

  // Ensure the referenced blob is inside the cache root.
  const blobReal = await resolveRealAbsolutePath(record.graphPath);
  if (isOutsideResolvedRoot(cache.root, blobReal)) {
    throw new Error("cache record graphPath must reside inside cache root");
  }

  const dir = recordDir(cache.root, record.key);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "record.json");
  const payload = JSON.stringify(record);
  const tmp = join(dir, `.record.json.tmp.${randomBytes(8).toString("hex")}`);
  await writeFile(tmp, payload, { mode: 0o600 });
  await rename(tmp, path);
  await evictCache(cache);
}

export async function publishBlob(cache: CacheHandle, revision: IndexRevision, graphData: Buffer | string): Promise<string> {
  if (!cache || !cache.root) throw new Error("cache not opened");
  if (cache.root !== (await resolveRealAbsolutePath(cache.root))) {
    throw new Error("cache root must be a real path");
  }
  assertIndexRevision(revision);
  const dir = join(cache.root, "blobs");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const blobPath = join(dir, `${revision.indexRevision}.json`);
  const tmp = `${blobPath}.tmp.${randomBytes(8).toString("hex")}`;
  await writeFile(tmp, graphData, { mode: 0o600 });
  await rename(tmp, blobPath);
  return blobPath;
}

export async function evictCache(cache: CacheHandle): Promise<void> {
  const { entries, orphans, totalBytes: initialBytes } = await scanCache(cache.root);
  const now = Date.now();
  let totalBytes = initialBytes;

  // Sort oldest first.
  entries.sort((a, b) => a.mtime - b.mtime);

  for (const entry of entries) {
    const stale = now - entry.mtime > cache.maxAgeMs;
    const overSize = totalBytes > cache.maxBytes;
    const overCount = entries.length > cache.maxEntries;
    if (!stale && !overSize && !overCount) break;
    try {
      await rm(entry.recordDir, { recursive: true, force: true });
      if (entry.blobPath) {
        try {
          await rm(entry.blobPath, { force: true });
        } catch { /* ignore */ }
      }
      totalBytes -= entry.recordSize + entry.blobSize;
      entries.splice(entries.indexOf(entry), 1);
    } catch { /* ignore */ }
  }

  // Remove orphan blobs that are not referenced by any record.
  // Expired orphans are evicted even when byte/entry budgets are under budget.
  orphans.sort((a, b) => a.mtime - b.mtime);
  for (const orphan of orphans) {
    const stale = now - orphan.mtime > cache.maxAgeMs;
    const overSize = totalBytes > cache.maxBytes;
    const overCount = entries.length > cache.maxEntries;
    if (!stale && !overSize && !overCount) break;
    try {
      await rm(orphan.path, { force: true });
      totalBytes -= orphan.size;
    } catch { /* ignore */ }
  }
}
