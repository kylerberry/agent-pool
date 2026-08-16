#!/usr/bin/env node
import { resolve } from "node:path";
import { validatePlan } from "./goal-plan.mjs";

// Generic local Repository Builder plan validation: one verified repository-file snapshot of the
// canonical plan, structural validation, one non-empty human-attributed approval, and conditional
// domain-map approval/hash validation only when the plan-level domain_boundaries_changed signal is
// explicitly true. No detached candidate/source/scope/archive authorization is consulted.
const root = resolve(import.meta.dirname, "../..");
const fail = (message) => {
  console.error(`goal-plan validation failed: ${message}`);
  process.exit(1);
};

const dagPath = "docs/raw/plans/proposed-build-dag.json";
try {
  const { plan: dag, sha: dagSha } = validatePlan(root, dagPath);
  const roots = dag.nodes.filter((node) => node.depends_on.length === 0).map((node) => node.id);
  console.log(`goal-plan validation passed: dag_sha256=${dagSha} nodes=${dag.nodes.length} roots=${roots.join(",")} domain_boundaries_changed=${dag.domain_boundaries_changed === true}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
