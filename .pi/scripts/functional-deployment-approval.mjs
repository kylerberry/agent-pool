import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export const FUNCTIONAL_DEPLOYMENT_KIND = "repository-builder-functional-pool-deployment-dag-candidate";
const SOURCE_PATH = "docs/raw/specs/functional-pool-deployment.md";
const CANDIDATE_PATH = "docs/raw/plans/functional-pool-deployment-dag.candidate.json";
const SCOPE_REVIEW_PATH = "docs/raw/plans/functional-pool-deployment-dag.scope-review.json";
const APPROVAL_PATH = "docs/raw/plans/functional-pool-deployment-approval.json";
const COMPLETED_PLAN_ARCHIVE_PATH = "docs/raw/plans/completed-pool-proof-build-dag.json";
const COMPLETED_PLAN_ARCHIVE_SHA256 = "fe62bd9b156976401f4571aea4fd60bcb512b005927b161e5d3e4610dce2d8e5";
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

function fail(message) { throw new Error(message); }
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, expected, label) {
  if (!isObject(value) || Object.keys(value).sort().join("|") !== [...expected].sort().join("|")) {
    fail(`${label} has missing or unknown fields`);
  }
}
function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function readBytes(root, relative, label) {
  const target = path.resolve(root, relative);
  if (!fs.existsSync(target)) fail(`${label} is missing: ${relative}`);
  const bytes = fs.readFileSync(target);
  if (bytes.length > MAX_ARTIFACT_BYTES) fail(`${label} exceeds size bound`);
  return bytes;
}
function readJson(root, relative, label) {
  const bytes = readBytes(root, relative, label);
  try { return { value: JSON.parse(bytes), bytes }; }
  catch (error) { fail(`${label} JSON parse error: ${error.message}`); }
}
function assertHash(actual, expected, label) {
  if (typeof expected !== "string" || !SHA256.test(expected) || actual !== expected) {
    fail(`${label} SHA-256 mismatch`);
  }
}

function isFunctionalPlan(plan) {
  return isObject(plan) && (
    plan.kind === FUNCTIONAL_DEPLOYMENT_KIND ||
    plan.source === SOURCE_PATH ||
    (Array.isArray(plan.nodes) && plan.nodes.some((node) => node?.id === "model-policy-zai-qualification"))
  );
}

export function validateFunctionalDeploymentActivation(root, plan) {
  if (!isFunctionalPlan(plan)) return { applicable: false };

  const approvalFile = path.resolve(root, APPROVAL_PATH);
  if (!fs.existsSync(approvalFile)) fail(`functional deployment detached approval is missing: ${APPROVAL_PATH}`);
  const { value: approval } = readJson(root, APPROVAL_PATH, "functional deployment detached approval");
  exactKeys(approval, [
    "schema_version",
    "candidate_path",
    "candidate_sha256",
    "source_path",
    "source_sha256",
    "scope_review_path",
    "scope_review_sha256",
    "completed_plan_archive_path",
    "completed_plan_archive_sha256",
    "approved_by",
    "approved_at",
  ], "functional deployment detached approval");
  if (approval.schema_version !== 1) fail("functional deployment detached approval schema_version must be 1");
  if (approval.candidate_path !== CANDIDATE_PATH || approval.source_path !== SOURCE_PATH || approval.scope_review_path !== SCOPE_REVIEW_PATH || approval.completed_plan_archive_path !== COMPLETED_PLAN_ARCHIVE_PATH) {
    fail("functional deployment detached approval path is invalid");
  }
  if (typeof approval.approved_by !== "string" || !approval.approved_by.trim() || approval.approved_by.length > 128 || typeof approval.approved_at !== "string" || Number.isNaN(Date.parse(approval.approved_at))) {
    fail("functional deployment detached approval identity or timestamp is invalid");
  }

  const { value: candidate, bytes: candidateBytes } = readJson(root, CANDIDATE_PATH, "functional deployment candidate");
  const { value: scopeReview, bytes: scopeBytes } = readJson(root, SCOPE_REVIEW_PATH, "functional deployment scope review");
  const sourceBytes = readBytes(root, SOURCE_PATH, "functional deployment source");
  const archiveBytes = readBytes(root, COMPLETED_PLAN_ARCHIVE_PATH, "completed Pool Proof plan archive");

  const candidateSha256 = sha256(candidateBytes);
  assertHash(candidateSha256, approval.candidate_sha256, "functional deployment candidate");
  assertHash(sha256(sourceBytes), approval.source_sha256, "functional deployment source");
  assertHash(sha256(scopeBytes), approval.scope_review_sha256, "functional deployment scope review");
  assertHash(sha256(archiveBytes), approval.completed_plan_archive_sha256, "completed Pool Proof plan archive");
  if (approval.completed_plan_archive_sha256 !== COMPLETED_PLAN_ARCHIVE_SHA256) fail("completed Pool Proof plan archive SHA-256 mismatch");

  if (!isObject(candidate) || candidate.kind !== FUNCTIONAL_DEPLOYMENT_KIND || candidate.source !== SOURCE_PATH) {
    fail("functional deployment candidate identity is invalid");
  }
  if (!isObject(scopeReview) || scopeReview.candidate_path !== CANDIDATE_PATH || scopeReview.candidate_sha256 !== candidateSha256) {
    fail("functional deployment scope review is not bound to the approved candidate");
  }
  const candidateIds = Array.isArray(candidate.nodes) ? candidate.nodes.map((node) => node?.id).sort() : [];
  const scopeIds = isObject(scopeReview.nodes) ? Object.keys(scopeReview.nodes).sort() : [];
  if (!isDeepStrictEqual(candidateIds, scopeIds)) fail("functional deployment scope review node IDs do not match candidate");

  if (!isObject(plan.approval) || plan.approval.approved_by !== approval.approved_by || plan.approval.approved_at !== approval.approved_at) {
    fail("canonical plan approval identity does not match detached approval");
  }
  const { approval: _ignored, ...withoutApproval } = plan;
  if (!isDeepStrictEqual(withoutApproval, candidate)) {
    fail("canonical plan does not equal the exact approved candidate plus approval");
  }

  return { applicable: true, candidateSha256 };
}
