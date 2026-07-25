#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const fail = (message) => {
  console.error(`goal-plan validation failed: ${message}`);
  process.exit(1);
};

const approvalPath = "docs/raw/plans/domain-map-approval.json";
const approval = readJson(approvalPath);
const approvalKeys = ["map_path", "map_sha256", "approved_by", "approved_at"];
if (Object.keys(approval).sort().join("|") !== approvalKeys.sort().join("|")) {
  fail("domain-map approval has missing or unknown fields");
}
if (approval.map_path !== "docs/raw/context/initial-domain-map.md") fail("domain-map path is invalid");
const mapBytes = readFileSync(resolve(root, approval.map_path));
const mapSha256 = createHash("sha256").update(mapBytes).digest("hex");
if (!/^[a-f0-9]{64}$/.test(approval.map_sha256) || approval.map_sha256 !== mapSha256) {
  fail("domain-map SHA-256 does not match approval record");
}
if (!approval.approved_by || Number.isNaN(Date.parse(approval.approved_at))) {
  fail("domain-map approval identity or timestamp is invalid");
}

const dag = readJson("docs/raw/plans/proposed-build-dag.json");
if (!Array.isArray(dag.nodes) || dag.nodes.length === 0) fail("build DAG has no nodes");
if (!dag.approval?.approved_by || Number.isNaN(Date.parse(dag.approval?.approved_at))) {
  fail("build DAG is not approved");
}
const nodeKeys = ["id", "intent", "change_spec", "acceptance_criteria", "depends_on"];
const ids = new Set();
for (const node of dag.nodes) {
  if (Object.keys(node).sort().join("|") !== [...nodeKeys].sort().join("|")) {
    fail(`node ${node.id || "<unknown>"} violates the ADR-018 field set`);
  }
  if (!node.id || ids.has(node.id)) fail(`node ID is missing or duplicated: ${node.id}`);
  ids.add(node.id);
  if (
    !node.intent || !node.change_spec || !Array.isArray(node.acceptance_criteria) ||
    node.acceptance_criteria.length === 0 ||
    node.acceptance_criteria.some((criterion) => typeof criterion !== "string" || !criterion.trim())
  ) {
    fail(`node ${node.id} has an incomplete work contract`);
  }
  if (!Array.isArray(node.depends_on) || node.depends_on.some((dependency) => typeof dependency !== "string")) {
    fail(`node ${node.id} depends_on is not a string array`);
  }
}

const incoming = new Map(dag.nodes.map((node) => [node.id, new Set(node.depends_on)]));
for (const [id, dependencies] of incoming) {
  if (dependencies.has(id)) fail(`node ${id} depends on itself`);
  for (const dependency of dependencies) {
    if (!ids.has(dependency)) fail(`node ${id} references missing dependency ${dependency}`);
  }
}
const ready = [...incoming].filter(([, dependencies]) => dependencies.size === 0).map(([id]) => id).sort();
if (ready.length === 0) fail("build DAG has no ready root");
const roots = [...ready];
const visited = [];
while (ready.length) {
  const id = ready.shift();
  visited.push(id);
  for (const [candidate, dependencies] of incoming) {
    if (!dependencies.delete(id) || dependencies.size !== 0 || visited.includes(candidate) || ready.includes(candidate)) continue;
    ready.push(candidate);
    ready.sort();
  }
}
if (visited.length !== dag.nodes.length) fail("build DAG contains a cycle");

console.log(`goal-plan validation passed: map_sha256=${mapSha256} nodes=${dag.nodes.length} roots=${roots.join(",")}`);
