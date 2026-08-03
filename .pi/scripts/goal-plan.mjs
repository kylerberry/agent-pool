import crypto from "node:crypto";
import fs from "node:fs";

export const PLAN_SCHEMA_VERSION = 1;

const PLAN_BOUNDS = {
  max_plan_bytes: 10 * 1024 * 1024,
  max_nodes: 256,
  max_id_length: 128,
  max_string_field: 16384,
  max_criteria: 256,
  max_criterion_length: 4096,
  max_approver_length: 256,
  max_approval_context_length: 4096,
  max_depth: 32,
  max_values: 100_000,
  max_array_length: 4096,
  max_string_length: 100_000,
};

function fail(message) { throw new Error(message); }
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function assertBound(value, min, max, label) { if (value < min || value > max) fail(`${label} is out of bounds`); }
function validDate(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) fail(`${label} must be a date-time`);
}
function safeSegment(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) fail(`${label} must be a safe path segment`);
  return value;
}
function stringArray(value, label, { unique = false, nonEmpty = false } = {}) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) fail(`${label} must be a string array`);
  if (unique && new Set(value).size !== value.length) fail(`${label} must contain unique values`);
  if (nonEmpty && value.length === 0) fail(`${label} must be non-empty`);
}

function validateJsonBounds(value, bounds, label) {
  function visit(item, depth) {
    if (typeof item === "string") {
      if (item.length > bounds.max_string_length) fail(`${label} string exceeds maximum length`);
      return;
    }
    if (typeof item === "number" || typeof item === "boolean" || item === null) return;
    if (Array.isArray(item)) {
      if (depth > bounds.max_depth) fail(`${label} exceeds maximum nesting depth`);
      if (item.length > bounds.max_array_length) fail(`${label} array exceeds maximum length`);
      for (const element of item) visit(element, depth + 1);
      return;
    }
    if (isObject(item)) {
      if (depth > bounds.max_depth) fail(`${label} exceeds maximum nesting depth`);
      for (const [key, child] of Object.entries(item)) {
        if (key.length > bounds.max_string_length) fail(`${label} object key exceeds maximum length`);
        visit(child, depth + 1);
      }
      return;
    }
    fail(`${label} contains an unsupported JSON value`);
  }
  let values = 0;
  function count(item) {
    values += 1;
    if (values > bounds.max_values) fail(`${label} exceeds maximum value count`);
    if (Array.isArray(item)) for (const element of item) count(element);
    else if (isObject(item)) for (const child of Object.values(item)) count(child);
  }
  visit(value, 0);
  count(value);
}

function exactKeys(value, required, label) {
  if (!isObject(value)) fail(`${label} is not an object`);
  const keys = Object.keys(value).sort().join("|");
  const expected = [...required].sort().join("|");
  if (keys !== expected) fail(`${label} has missing or unknown fields`);
}

function exactKeysOptional(value, required, optional, label) {
  if (!isObject(value)) fail(`${label} is not an object`);
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (!required.every((key) => keys.includes(key)) || keys.some((key) => !allowed.has(key))) {
    fail(`${label} has missing or unknown fields`);
  }
}

export function hashPlanBytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function validatePlanObject(plan, byteLength) {
  if (byteLength > PLAN_BOUNDS.max_plan_bytes) fail("plan exceeds size bound");
  validateJsonBounds(plan, PLAN_BOUNDS, "plan");
  if (!isObject(plan.approval)) fail("plan approval is required");
  exactKeysOptional(plan, ["schema_version", "nodes", "approval"], ["kind", "source"], "plan");
  if (plan.schema_version !== PLAN_SCHEMA_VERSION) fail("plan schema_version must be 1");
  if (plan.kind !== undefined && (typeof plan.kind !== "string" || plan.kind.length > PLAN_BOUNDS.max_string_field)) fail("plan kind is invalid");
  if (plan.source !== undefined && (typeof plan.source !== "string" || plan.source.length > PLAN_BOUNDS.max_string_field)) fail("plan source is invalid");
  if (!Array.isArray(plan.nodes) || !plan.nodes.length) fail("plan nodes are invalid");

  exactKeysOptional(plan.approval, ["approved_by", "approved_at"], ["notes"], "plan approval");
  if (typeof plan.approval.approved_by !== "string" || !plan.approval.approved_by || plan.approval.approved_by.length > PLAN_BOUNDS.max_approver_length) {
    fail("plan approval.approved_by is invalid");
  }
  validDate(plan.approval.approved_at, "plan approval.approved_at");
  if (plan.approval.notes !== undefined && (typeof plan.approval.notes !== "string" || plan.approval.notes.length > PLAN_BOUNDS.max_approval_context_length)) {
    fail("plan approval.notes is invalid");
  }

  if (plan.nodes.length > PLAN_BOUNDS.max_nodes) fail("plan has too many nodes");
  if (!isObject(plan.approval)) fail("plan approval is required");

  const required = ["id", "intent", "change_spec", "acceptance_criteria", "depends_on"];
  const ids = new Set();
  for (const node of plan.nodes) {
    exactKeys(node, required, `plan node ${node.id || "<unknown>"}`);
    safeSegment(node.id, "plan node ID");
    if (ids.has(node.id)) fail(`plan node ID is duplicated: ${node.id}`);
    ids.add(node.id);
    if (typeof node.intent !== "string" || typeof node.change_spec !== "string") fail(`plan node ${node.id} contract is invalid`);
    stringArray(node.acceptance_criteria, `plan node ${node.id} acceptance_criteria`, { nonEmpty: true });
    stringArray(node.depends_on, `plan node ${node.id} depends_on`);
    if (node.id.length > PLAN_BOUNDS.max_id_length || node.intent.length > PLAN_BOUNDS.max_string_field || node.change_spec.length > PLAN_BOUNDS.max_string_field) {
      fail(`node ${node.id} field is out of bounds`);
    }
    for (const criterion of node.acceptance_criteria) {
      if (!criterion.trim() || criterion.length > PLAN_BOUNDS.max_criterion_length) fail(`node ${node.id} criterion is invalid`);
    }
  }

  const incoming = new Map(plan.nodes.map((node) => [node.id, new Set(node.depends_on)]));
  for (const [id, dependencies] of incoming) {
    for (const dependency of dependencies) {
      if (dependency === id || !ids.has(dependency)) fail(`plan node ${id} has invalid dependency ${dependency}`);
    }
  }

  const ready = [...incoming].filter(([, dependencies]) => dependencies.size === 0).map(([id]) => id);
  const visited = [];
  while (ready.length) {
    const id = ready.shift();
    visited.push(id);
    for (const [candidate, dependencies] of incoming) {
      if (!dependencies.delete(id) || dependencies.size !== 0 || visited.includes(candidate) || ready.includes(candidate)) continue;
      ready.push(candidate);
    }
  }
  if (visited.length !== plan.nodes.length) fail("plan contains a cycle");
  return plan;
}

export function validatePlan(planPath) {
  if (!fs.existsSync(planPath)) fail(`plan not found: ${planPath}`);
  const raw = fs.readFileSync(planPath);
  let plan;
  try { plan = JSON.parse(raw); } catch (error) { fail(`plan JSON parse error: ${error.message}`); }
  validatePlanObject(plan, raw.length);
  return { plan, sha: hashPlanBytes(raw) };
}
