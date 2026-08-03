#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validatePlan } from "./goal-plan.mjs";

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

const dagPath = resolve(root, "docs/raw/plans/proposed-build-dag.json");
const { plan: dag, sha: dagSha } = validatePlan(dagPath);

const roots = dag.nodes.filter((node) => node.depends_on.length === 0).map((node) => node.id);
console.log(`goal-plan validation passed: map_sha256=${mapSha256} dag_sha256=${dagSha} nodes=${dag.nodes.length} roots=${roots.join(",")}`);
