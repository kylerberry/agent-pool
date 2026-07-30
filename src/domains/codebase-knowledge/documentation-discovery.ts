import { lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { normalizeRelativePath } from "./target-repository.ts";
import { readFileNoFollow } from "./path-safety.ts";
import { dirname, join, extname, basename } from "node:path";
import type { SourceManifest, DocumentationPage, DocumentationResult, ManifestEntry } from "./contracts.ts";

const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;
const OBSIDIAN_LINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const ROOT_INDEX_NAMES = new Set(["AGENTS.md", "README.md", "readme.md"]);
const DOC_EXTENSIONS = new Set([".md"]);

export interface DocumentationOptions {
  sourceRoot: string;
  maxPages?: number;
  maxDepth?: number;
}

interface QueueItem {
  path: string;
  depth: number;
  indexPath?: string;
}

function isDocumentationPath(relativePath: string): boolean {
  const base = basename(relativePath);
  if (ROOT_INDEX_NAMES.has(base)) return true;
  return DOC_EXTENSIONS.has(extname(base).toLowerCase());
}

function isRootIndex(relativePath: string): boolean {
  const base = basename(relativePath);
  return ROOT_INDEX_NAMES.has(base);
}

function resolveLink(raw: string, sourcePath: string): string | undefined {
  // Strip fragment and query.
  let cleaned = raw.split("#")[0].split("?")[0];
  if (!cleaned) return undefined;
  // Reject external URLs and traversal.
  if (
    cleaned.startsWith("http://") ||
    cleaned.startsWith("https://") ||
    cleaned.startsWith("mailto:") ||
    cleaned.startsWith("file://")
  ) {
    return undefined;
  }
  // Reject any relative-path parent traversal before normalization.
  if (cleaned.includes("..")) return undefined;
  try {
    const base = dirname(sourcePath);
    const joined = base === "." ? cleaned : `${base}/${cleaned}`;
    return normalizeRelativePath(joined);
  } catch {
    return undefined;
  }
}

function parseFrontmatter(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return result;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return result;
  const body = text.slice(4, end);
  for (const line of body.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function parseTitle(text: string): string | undefined {
  const fm = parseFrontmatter(text);
  if (fm.title) return fm.title;
  const match = text.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : undefined;
}

function parseMarkdownLinks(text: string, sourcePath: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  MARKDOWN_LINK_RE.lastIndex = 0;
  while ((match = MARKDOWN_LINK_RE.exec(text)) !== null) {
    const resolved = resolveLink(match[2], sourcePath);
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      links.push(resolved);
    }
  }
  return links;
}

function parseObsidianLinks(text: string, sourcePath: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  OBSIDIAN_LINK_RE.lastIndex = 0;
  while ((match = OBSIDIAN_LINK_RE.exec(text)) !== null) {
    const target = match[1].split("#")[0].split("|")[0].trim();
    if (!target) continue;
    const resolved = resolveLink(target.endsWith(".md") ? target : `${target}.md`, sourcePath);
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      links.push(resolved);
    }
  }
  return links;
}

function discoverLinks(text: string, sourcePath: string): string[] {
  return [...parseMarkdownLinks(text, sourcePath), ...parseObsidianLinks(text, sourcePath)];
}

function entryDigest(entry: ManifestEntry, data: Buffer): string {
  const hash = createHash("sha256");
  hash.update(data);
  return `sha256:${hash.digest("hex")}`;
}

export { parseMarkdownLinks, parseObsidianLinks };

export async function discoverDocumentation(
  manifest: SourceManifest,
  options: DocumentationOptions,
): Promise<DocumentationResult> {
  const maxDepth = options.maxDepth ?? 3;
  const maxPages = options.maxPages ?? 100;
  const root = options.sourceRoot;
  if (!root) throw new Error("sourceRoot is required");

  const entriesByPath = new Map(manifest.entries.map((e) => [e.relativePath, e]));
  const pages: DocumentationPage[] = [];
  const visited = new Set<string>();
  let queue: QueueItem[] = [];

  // Seed with manifest-approved top-level instruction files only.
  const roots = manifest.entries
    .filter((e) => isRootIndex(e.relativePath))
    .sort((a, b) => {
      const aName = basename(a.relativePath);
      const bName = basename(b.relativePath);
      // AGENTS.md first, then README.md/readme.md.
      return (aName === "AGENTS.md" ? 0 : 1) - (bName === "AGENTS.md" ? 0 : 1);
    })
    .map((e) => ({ path: e.relativePath, depth: 0, indexPath: undefined }));

  queue.push(...roots);

  let truncated = false;
  while (queue.length > 0) {
    const level = queue;
    queue = [];
    for (const { path, depth, indexPath } of level) {
      if (pages.length >= maxPages) {
        truncated = true;
        break;
      }
      if (visited.has(path)) continue;
      visited.add(path);
      const entry = entriesByPath.get(path);
      if (!entry) continue;
      if (!isDocumentationPath(path)) continue;

      const fullPath = join(root, path);

      // Re-validate the file is still a regular file (no symlink swap).
      let info;
      try {
        info = await lstat(fullPath);
      } catch {
        continue;
      }
      if (!info.isFile() || info.isSymbolicLink()) continue;

      let text: string;
      let data: Buffer;
      try {
        data = await readFileNoFollow(fullPath) as Buffer;
        text = data.toString("utf8");
      } catch {
        continue;
      }

      // Revalidate digest against the manifest to detect post-capture mutation.
      if (entryDigest(entry, data) !== entry.digest) continue;

      const fm = parseFrontmatter(text);
      const rawSourcePath = fm.canonical_source || fm.source || path;

      pages.push({
        title: parseTitle(text) || path,
        sourcePath: path,
        rawSourcePath: normalizeRelativePath(rawSourcePath),
        indexPath,
      });

      if (depth < maxDepth) {
        for (const link of discoverLinks(text, path)) {
          if (!visited.has(link) && entriesByPath.has(link)) {
            queue.push({ path: link, depth: depth + 1, indexPath: path });
          }
        }
      }
    }
    if (truncated) break;
  }

  if (pages.length === 0) {
    return {
      available: false,
      status: "unavailable",
      pages: [],
      reason: "no documentation indexes found in manifest",
    };
  }

  return {
    available: true,
    status: truncated ? "truncated" : "available",
    pages,
    reason: truncated ? `page budget ${maxPages} reached` : undefined,
  };
}
