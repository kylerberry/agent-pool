import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const domainRoot = join(__dirname, "..", "..", "src", "domains", "codebase-knowledge");

const forbidden = [
  "vector",
  "embedding",
  "semanticRAG",
  "semantic-rag",
  "pinecone",
  "chromadb",
  "launchProvider",
  "execSync",
];

const allowedRuntimeImports = /^(node:|\.\/)/;

test("domain source contains no vector, semantic-RAG, or provider launch code", () => {
  const files = readdirSync(domainRoot).filter((f) => f.endsWith(".ts"));
  for (const file of files) {
    const text = readFileSync(join(domainRoot, file), "utf8");
    for (const pattern of forbidden) {
      const re = new RegExp(pattern, "i");
      assert.equal(re.test(text), false, `${file} contains forbidden pattern: ${pattern}`);
    }
  }
});

test("domain modules only import node built-ins or local files", () => {
  const files = readdirSync(domainRoot).filter((f) => f.endsWith(".ts"));
  for (const file of files) {
    const text = readFileSync(join(domainRoot, file), "utf8");
    const imports = [...text.matchAll(/import\s+.*?\s+from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    for (const imp of imports) {
      assert.match(imp, allowedRuntimeImports, `${file} imports external package: ${imp}`);
    }
  }
});

test("graphify invocation uses only allowed argv", () => {
  const text = readFileSync(join(domainRoot, "graphify-adapter.ts"), "utf8");
  assert.ok(text.includes("graphifyPath"), "runner references trusted graphify path");
  assert.ok(text.includes("--no-viz"), "runner suppresses viz generation");
  assert.ok(text.includes("graphifyVersion"), "runner validates version");
});

test("worker contracts do not include DAG topology fields", () => {
  const text = readFileSync(join(domainRoot, "contracts.ts"), "utf8");
  assert.equal(text.includes("depends_on"), false);
  assert.equal(text.includes("siblingIds"), false);
  assert.equal(text.includes("schedule"), false);
});

test("predicted-touch type omits scheduling and worker topology", () => {
  const text = readFileSync(join(domainRoot, "contracts.ts"), "utf8");
  assert.equal(text.includes("PredictedTouchEvidence"), true);
  assert.equal(/interface\s+PredictedTouchEvidence[\s\S]*?depends_on/.test(text), false);
  assert.equal(/interface\s+PredictedTouchEvidence[\s\S]*?siblingIds/.test(text), false);
});
