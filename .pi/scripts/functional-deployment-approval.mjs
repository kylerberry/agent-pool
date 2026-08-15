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
export const TRUSTED_ACTIVE_PLAN_SHA256 = COMPLETED_PLAN_ARCHIVE_SHA256;

function fail(message) { throw new Error(message); }
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, expected, label) {
  if (!isObject(value) || Object.keys(value).sort().join("|") !== [...expected].sort().join("|")) {
    fail(`${label} has missing or unknown fields`);
  }
}
function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
// Governing artifacts must be root-contained regular files. Symlinks are rejected in the final
// component and every existing ancestor before opening (O_NOFOLLOW), and the opened descriptor
// is re-validated after the open: the ancestor/final symlink check is repeated, the target's
// realpath must remain the exact expected root-contained path, and the current path's device and
// inode must match the opened descriptor. Bytes are read and hashed only from that verified fd.
function readBytes(root, relative, label) {
  if (typeof relative !== "string" || relative === "" || path.isAbsolute(relative)) fail(`${label} path is invalid: ${relative}`);
  const rootDir = path.resolve(root);
  const target = path.resolve(rootDir, relative);
  if (!isWithin(rootDir, target)) fail(`${label} escapes repository root: ${relative}`);
  const segments = path.relative(rootDir, target).split(path.sep).filter((item) => item && item !== ".");
  const assertNoSymlinks = () => {
    let current = rootDir;
    for (const segment of segments) {
      current = path.join(current, segment);
      let stats;
      try { stats = fs.lstatSync(current); } catch { fail(`${label} is missing: ${relative}`); }
      if (stats.isSymbolicLink()) fail(`${label} path contains a symbolic link: ${current}`);
    }
  };
  assertNoSymlinks();
  const descriptor = (() => {
    try { return fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); }
    catch { fail(`${label} is missing: ${relative}`); }
  })();
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile()) fail(`${label} is not a regular file: ${relative}`);
    if (stats.size > MAX_ARTIFACT_BYTES) fail(`${label} exceeds size bound`);
    // Post-open validation closes the check/open race: while the descriptor stays open, the
    // path must still be symlink-free and resolve to exactly the expected root-contained file.
    assertNoSymlinks();
    let resolved;
    try { resolved = fs.realpathSync(target); } catch { fail(`${label} path could not be resolved: ${relative}`); }
    let realRoot;
    try { realRoot = fs.realpathSync(rootDir); } catch { fail(`${label} repository root could not be resolved: ${rootDir}`); }
    if (resolved !== path.resolve(realRoot, relative)) fail(`${label} resolved outside the expected root-contained path: ${relative}`);
    let currentStats;
    try { currentStats = fs.statSync(target); } catch { fail(`${label} is missing: ${relative}`); }
    if (currentStats.dev !== stats.dev || currentStats.ino !== stats.ino) fail(`${label} path no longer references the opened file: ${relative}`);
    const bytes = fs.readFileSync(descriptor);
    if (bytes.length > MAX_ARTIFACT_BYTES) fail(`${label} exceeds size bound`);
    return bytes;
  } finally { fs.closeSync(descriptor); }
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

function validateFunctionalDeploymentApproval(root, plan) {
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
  // Approval metadata is exactly {approved_by, approved_at}; any extra field (e.g. notes) is
  // rejected so the approved canonical bytes are uniquely bound by the detached record.
  exactKeys(plan.approval, ["approved_by", "approved_at"], "canonical plan approval");

  // Deterministic canonical plan bytes: the exact approved candidate object plus the matching
  // plan approval, serialized with repository canonical formatting (JSON.stringify(..., null, 2)
  // plus a trailing newline). Detached approval authorizes these bytes, not merely parsed equality.
  const canonicalPlanBytes = Buffer.from(`${JSON.stringify({ ...candidate, approval: { approved_by: approval.approved_by, approved_at: approval.approved_at } }, null, 2)}\n`);

  return { candidateSha256, canonicalPlanSha256: sha256(canonicalPlanBytes) };
}

// Unconditional exact-hash validation. Recognizability markers in the incoming plan never select
// whether this validator runs; any plan that is not the exact approved candidate plus approval fails.
export function validateFunctionalDeploymentActivation(root, plan) {
  const { candidateSha256, canonicalPlanSha256 } = validateFunctionalDeploymentApproval(root, plan);
  return { applicable: true, candidateSha256, canonicalPlanSha256 };
}

// Trusted activation-transition selection for a canonical repository plan.
// Only two identities may be accepted or frozen as the active plan:
//   1. the exact completed Pool Proof canonical plan (pinned SHA-256); or
//   2. the exact detached-approved functional deployment candidate plus approval, whose
//      canonical bytes must hash to the supplied active plan SHA-256.
// Every different canonical replacement-plan hash fails closed.
export function authorizeKnownCanonicalPlan(root, plan, sha) {
  if (typeof sha !== "string" || !SHA256.test(sha)) fail("canonical plan SHA-256 is required for activation authorization");
  if (sha === TRUSTED_ACTIVE_PLAN_SHA256) return { authorized: true, basis: "trusted-active-plan" };
  const { candidateSha256, canonicalPlanSha256 } = validateFunctionalDeploymentApproval(root, plan);
  if (sha !== canonicalPlanSha256) fail("active plan SHA-256 does not match the approved canonical plan bytes");
  return { authorized: true, basis: "detached-functional-approval", candidateSha256, canonicalPlanSha256 };
}
