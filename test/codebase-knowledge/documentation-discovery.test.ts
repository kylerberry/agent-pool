import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverDocumentation, parseMarkdownLinks, parseObsidianLinks } from "../../src/domains/codebase-knowledge/documentation-discovery.ts";
import { captureManifest } from "../../src/domains/codebase-knowledge/target-repository.ts";

function makeLinkedRepo() {
  const dir = mkdtempSync(join(tmpdir(), "ck-docs-"));
  writeFileSync(join(dir, "AGENTS.md"), "---\ncanonical_source: docs/AGENTS.md\n---\n# AGENTS\n[Wiki](docs/wiki/index.md)\n[[adr-001]]\n");
  mkdirSync(join(dir, "docs", "wiki"), { recursive: true });
  writeFileSync(join(dir, "docs", "wiki", "index.md"), "# Index\n[ADR](adr-001.md)\n[Outside](../outside.md)\n");
  writeFileSync(join(dir, "docs", "wiki", "adr-001.md"), "# ADR-001\n");
  return dir;
}

test("parseMarkdownLinks extracts repository-relative links and rejects traversal/external", () => {
  const text = "[a](src/a.md) [b](./b.md) [abs](https://example.com) [traversal](../c.md)";
  const links = parseMarkdownLinks(text, "docs/wiki/index.md");
  assert.deepEqual(links, ["docs/wiki/src/a.md", "docs/wiki/b.md"]);
});

test("parseObsidianLinks resolves to .md relative to source", () => {
  const text = "See [[adr-001]] and [[adr-002|Second ADR]].";
  const links = parseObsidianLinks(text, "docs/wiki/index.md");
  assert.deepEqual(links, ["docs/wiki/adr-001.md", "docs/wiki/adr-002.md"]);
});

test("discoverDocumentation follows index-led traversal with provenance", async () => {
  const dir = makeLinkedRepo();
  const manifest = await captureManifest({ owner: "o", name: "r" }, "HEAD", dir);
  const result = await discoverDocumentation(manifest, { sourceRoot: dir, maxPages: 10, maxDepth: 3 });
  assert.equal(result.available, true);
  const agents = result.pages.find((p) => p.sourcePath === "AGENTS.md");
  assert.ok(agents);
  assert.equal(agents?.rawSourcePath, "docs/AGENTS.md");
  assert.equal(agents?.indexPath, undefined);

  const wiki = result.pages.find((p) => p.sourcePath === "docs/wiki/index.md");
  assert.ok(wiki);
  assert.equal(wiki?.indexPath, "AGENTS.md");

  const adr = result.pages.find((p) => p.sourcePath === "docs/wiki/adr-001.md");
  assert.ok(adr);
  assert.equal(adr?.indexPath, "docs/wiki/index.md");
});

test("discoverDocumentation returns unavailable for empty repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ck-docs-empty-"));
  const manifest = await captureManifest({ owner: "o", name: "r" }, "HEAD", dir);
  const result = await discoverDocumentation(manifest, { sourceRoot: dir, maxPages: 10, maxDepth: 3 });
  assert.equal(result.available, false);
  assert.equal(result.status, "unavailable");
});

test("discoverDocumentation rejects traversal and external links", async () => {
  const dir = makeLinkedRepo();
  const manifest = await captureManifest({ owner: "o", name: "r" }, "HEAD", dir);
  const result = await discoverDocumentation(manifest, { sourceRoot: dir, maxPages: 10, maxDepth: 3 });
  const paths = result.pages.map((p) => p.sourcePath);
  assert.equal(paths.includes("outside.md"), false);
});

test("discoverDocumentation strictly enforces maxPages per level", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ck-docs-budget-"));
  writeFileSync(join(dir, "AGENTS.md"), "# AGENTS\n");
  mkdirSync(join(dir, "docs"), { recursive: true });
  for (let i = 0; i < 5; i++) {
    writeFileSync(join(dir, "docs", `page-${i}.md`), `# Page ${i}\n`);
    writeFileSync(join(dir, "AGENTS.md"), `[p${i}](docs/page-${i}.md)\n`, { flag: "a" });
  }
  const manifest = await captureManifest({ owner: "o", name: "r" }, "HEAD", dir);
  const result = await discoverDocumentation(manifest, { sourceRoot: dir, maxPages: 3, maxDepth: 3 });
  assert.equal(result.pages.length, 3);
  assert.equal(result.status, "truncated");
  assert.match(result.reason || "", /3/);
});

test("discoverDocumentation fails closed on post-manifest symlink swap", async () => {
  const dir = makeLinkedRepo();
  const manifest = await captureManifest({ owner: "o", name: "r" }, "HEAD", dir);
  const agentsPath = join(dir, "AGENTS.md");
  rmSync(agentsPath);
  symlinkSync(join(dir, "docs", "wiki", "index.md"), agentsPath);
  const result = await discoverDocumentation(manifest, { sourceRoot: dir, maxPages: 10, maxDepth: 3 });
  // AGENTS.md is now a symlink and must be skipped; only wiki pages reachable from other roots remain.
  assert.equal(result.pages.some((p) => p.sourcePath === "AGENTS.md"), false);
});
