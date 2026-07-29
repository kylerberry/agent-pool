#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emitEvalCandidate, gitSnapshot } from "../extensions/eval-telemetry/core.mjs";

const PHASES = new Set(["C", "R", "A", "F", "T", "S"]);
const SECURITY_TRIGGERS = new Set(["trust-boundary-change", "untrusted-input", "authentication-authorization", "secrets-sensitive-data", "external-integration", "file-command-execution", "ci-deploy-permissions", "tenant-isolation"]);
const ARTIFACT_STATUSES = new Set(["passed", "needs_fix", "failed", "blocked"]);
const MIGRATION_BOUNDS = {
  max_plan_bytes: 10 * 1024 * 1024,
  max_approval_bytes: 64 * 1024,
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
const ENVELOPE_BOUNDS = {
  max_depth: 16,
  max_values: 1024,
  max_array_length: 64,
  max_string_length: 8192,
};
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const FLOWS = new Set(["C-R-A-F-T-S", "R-S"]);
const TOP_LEVEL_KEYS = [
  "schema_version", "node_id", "attempt_id", "phase", "status", "model",
  "started_at", "completed_at", "summary", "acceptance_criteria_status",
  "changed_files", "commands_run", "cost", "risks", "open_questions",
  "recommended_next_step", "failure_context", "transcript_path", "phase_data",
];

function fail(message) { throw new Error(message); }
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, keys, label) {
  if (!isObject(value) || Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) {
    fail(`${label} has missing or unknown fields`);
  }
}
function exactKeysOptional(value, required, optional, label) {
  if (!isObject(value)) fail(`${label} is not an object`);
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (!required.every((key) => keys.includes(key)) || keys.some((key) => !allowed.has(key))) {
    fail(`${label} has missing or unknown fields`);
  }
}
function stringArray(value, label, { unique = false } = {}) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) fail(`${label} must be a string array`);
  if (unique && new Set(value).size !== value.length) fail(`${label} must contain unique values`);
}
function validDate(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) fail(`${label} must be a date-time`);
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function sha256File(filePath) { return sha256(fs.readFileSync(filePath)); }
function assertBound(value, min, max, label) { if (value < min || value > max) fail(`${label} is out of bounds`); }

function readAllBytes(descriptor) {
  const chunks = [];
  while (true) {
    const buffer = Buffer.alloc(65536);
    const bytesRead = fs.readSync(descriptor, buffer, 0, 65536, null);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks);
}

function safeOpenRead(rootDir, inputPath, label) {
  if (path.isAbsolute(inputPath)) fail(`${label} must be a relative path`);
  const lexical = path.resolve(rootDir, inputPath);
  if (!isWithin(rootDir, lexical)) fail(`${label} escapes repository root`);
  assertNoSymlinkAncestors(rootDir, lexical);
  const beforeChain = captureDirectoryChain(rootDir, path.dirname(lexical));
  let descriptor;
  try {
    descriptor = fs.openSync(lexical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error.code === "ELOOP") fail(`${label} is a symlink`);
    if (error.code === "ENOENT") fail(`${label} does not exist`);
    throw error;
  }
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.isSymbolicLink()) fail(`${label} is not a regular file`);
    const bytes = readAllBytes(descriptor);
    const realPath = fs.realpathSync(lexical);
    if (!isWithin(rootDir, realPath)) fail(`${label} resolves outside repository root`);
    revalidateDirectoryChain(beforeChain);
    return { bytes, stats, realPath };
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateTrustBasis(stats, relativePath) {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") fail("POSIX ownership primitives are required");
  if (!stats.isFile() || stats.isSymbolicLink()) fail("approval must be a regular non-symlink file");
  if (stats.uid !== process.getuid()) fail("approval must be owned by the effective user");
  if ((stats.mode & 0o022) !== 0) fail("approval must not be group or world writable");
  return { uid: stats.uid, gid: stats.gid, mode: stats.mode.toString(8), path: relativePath };
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

function atomicWriteBytes(filePath, bytes, mode = 0o600) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, filePath);
  const directoryDescriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
}

function writeImmutableObject(rootDir, subPath, bytes) {
  const digest = sha256(bytes);
  const filePath = path.resolve(rootDir, subPath, digest);
  const directory = path.dirname(filePath);
  if (!isWithin(rootDir, directory) && directory !== rootDir) fail("content-addressed object directory escapes repository");
  assertNoSymlinkAncestors(rootDir, directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const chain = captureDirectoryChain(rootDir, directory);
  try {
    const descriptor = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    const directoryDescriptor = fs.openSync(directory, "r");
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
    revalidateDirectoryChain(chain);
    return { path: filePath, sha: digest };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.isSymbolicLink()) fail(`content-addressed object is not a regular file: ${digest}`);
    if (isPosix() && stats.uid !== process.getuid()) fail(`content-addressed object is not owned by effective user: ${digest}`);
    if (isPosix() && (stats.mode & 0o7777) !== 0o600) fail(`content-addressed object must be mode 0600: ${digest}`);
    const existing = readAllBytes(descriptor);
    if (Buffer.compare(existing, bytes) !== 0) fail(`content-addressed object collision at ${digest}`);
    revalidateDirectoryChain(chain);
    return { path: filePath, sha: digest };
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateApprovalEnvelope(envelope) {
  validateJsonBounds(envelope, ENVELOPE_BOUNDS, "approval envelope");
  exactKeys(envelope, ["schema_version", "run_id", "expected_old_plan_sha256", "approved_new_plan_sha256", "approver", "approved_at", "approval_context"], "approval envelope");
  if (envelope.schema_version !== 1) fail("approval envelope schema_version must be 1");
  safeSegment(envelope.run_id, "approval run_id");
  if (!/^[0-9a-f]{64}$/.test(envelope.expected_old_plan_sha256)) fail("approval envelope expected_old_plan_sha256 is invalid");
  if (!/^[0-9a-f]{64}$/.test(envelope.approved_new_plan_sha256)) fail("approval envelope approved_new_plan_sha256 is invalid");
  if (typeof envelope.approver !== "string" || !envelope.approver || envelope.approver.length > MIGRATION_BOUNDS.max_approver_length) fail("approval envelope approver is invalid");
  validDate(envelope.approved_at, "approval envelope approved_at");
  if (typeof envelope.approval_context !== "string" || envelope.approval_context.length > MIGRATION_BOUNDS.max_approval_context_length) fail("approval envelope approval_context is invalid");
}

function compareMigrationPlans(oldPlan, newPlan, ledgerNodes) {
  if (!Array.isArray(oldPlan.nodes) || !Array.isArray(newPlan.nodes) || oldPlan.nodes.length !== newPlan.nodes.length) fail("plan node count changed");
  const newMap = new Map(newPlan.nodes.map((node) => [node.id, node]));
  for (const oldNode of oldPlan.nodes) {
    const newNode = newMap.get(oldNode.id);
    if (!newNode) fail(`node ${oldNode.id} was removed in new plan`);
    if (oldNode.intent !== newNode.intent) fail(`node ${oldNode.id} intent changed`);
    if (oldNode.change_spec !== newNode.change_spec) fail(`node ${oldNode.id} change_spec changed`);
    if (JSON.stringify(oldNode.depends_on) !== JSON.stringify(newNode.depends_on)) fail(`node ${oldNode.id} depends_on changed`);
    const oldCrit = oldNode.acceptance_criteria;
    const newCrit = newNode.acceptance_criteria;
    stringArray(oldCrit, `node ${oldNode.id} old acceptance_criteria`);
    stringArray(newCrit, `node ${oldNode.id} new acceptance_criteria`);
    if (oldCrit.length > MIGRATION_BOUNDS.max_criteria || newCrit.length > MIGRATION_BOUNDS.max_criteria) fail(`node ${oldNode.id} has too many acceptance criteria`);
    for (const criterion of [...oldCrit, ...newCrit]) if (typeof criterion !== "string" || criterion.length > MIGRATION_BOUNDS.max_criterion_length) fail(`node ${oldNode.id} criterion is out of bounds`);
    if (ledgerNodes?.[oldNode.id]?.status === "passed") {
      if (JSON.stringify(oldCrit) !== JSON.stringify(newCrit)) fail(`completed node ${oldNode.id} acceptance_criteria changed`);
    } else {
      if (newCrit.length < oldCrit.length) fail(`pending node ${oldNode.id} acceptance_criteria shortened`);
      for (let index = 0; index < oldCrit.length; index += 1) if (oldCrit[index] !== newCrit[index]) fail(`pending node ${oldNode.id} existing acceptance criterion altered`);
    }
  }
}

function resolveLedgerArtifact(ledgerDir, relativePath, label) {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${path.sep}`)) fail(`${label} path is unsafe`);
  const base = fs.realpathSync(ledgerDir);
  const resolved = safeOpenRead(base, relativePath, label);
  if (!isWithin(base, resolved.realPath)) fail(`${label} resolves outside ledger directory`);
  return { ...resolved, relative: path.relative(base, resolved.realPath).split(path.sep).join("/") };
}

function verifyCompletedEvidence(ledger, ledgerDir) {
  const result = [];
  for (const [id, node] of Object.entries(ledger.nodes)) {
    if (node.status !== "passed") continue;
    const attempt = node.attempts.at(-1);
    if (!attempt?.completion_path) fail(`completed node ${id} has no completion record`);
    const completion = resolveLedgerArtifact(ledgerDir, attempt.completion_path, `completed node ${id} completion`);
    const completionBytes = completion.bytes;
    const completionSha = sha256(completionBytes);
    if (typeof attempt.completion_sha256 === "string" && attempt.completion_sha256 !== completionSha) {
      fail(`completed node ${id} completion digest mismatch`);
    }
    const parsedCompletion = JSON.parse(completionBytes);
    const expectedCompletion = {
      schema_version: 1,
      node_id: id,
      attempt_id: attempt.attempt_id,
      status: attempt.final_status,
      flow: attempt.flow,
      completed_at: attempt.completed_at,
      phases: attempt.phases,
    };
    if (canonical(parsedCompletion) !== canonical(expectedCompletion)) fail(`completed node ${id} completion does not match immutable attempt fields`);
    const phaseDigests = [];
    for (const [phase, record] of Object.entries(attempt.phases || {})) {
      const phaseArtifact = resolveLedgerArtifact(ledgerDir, record.path, `completed node ${id} phase ${phase}`);
      const phaseBytes = phaseArtifact.bytes;
      const phaseSha = sha256(phaseBytes);
      if (typeof record.bytes_sha256 === "string" && record.bytes_sha256 !== phaseSha) fail(`completed node ${id} phase ${phase} exact-byte digest mismatch`);
      const parsedArtifact = JSON.parse(phaseBytes);
      if (sha256(canonical(parsedArtifact)) !== record.sha256) fail(`completed node ${id} phase ${phase} canonical digest mismatch`);
      phaseDigests.push({ phase, sha256: phaseSha });
    }
    phaseDigests.sort((a, b) => a.phase.localeCompare(b.phase));
    result.push({ node_id: id, completion_path: completion.relative, completion_sha256: completionSha, phase_digests: phaseDigests });
  }
  result.sort((a, b) => a.node_id.localeCompare(b.node_id));
  return result;
}

function buildManifest({ oldSha, newSha, oldObjectSha, newObjectSha, approvalSha, approvalObjectSha, completedEvidence }) {
  return {
    schema_version: 1,
    old_plan_sha: oldSha,
    new_plan_sha: newSha,
    old_plan_object: oldObjectSha,
    new_plan_object: newObjectSha,
    approval_envelope_sha: approvalSha,
    approval_object: approvalObjectSha,
    completed_evidence: completedEvidence,
  };
}

function buildAmendment({ envelope, approvalSha, manifestSha, trustBasis }) {
  return {
    schema_version: 1,
    old_plan_sha: envelope.expected_old_plan_sha256,
    new_plan_sha: envelope.approved_new_plan_sha256,
    approver: envelope.approver,
    approved_at: envelope.approved_at,
    approval_context: envelope.approval_context,
    approval_envelope_sha: approvalSha,
    evidence_manifest_sha: manifestSha,
    trust_basis: trustBasis,
  };
}

function safeSegment(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) fail(`${label} must be a safe path segment`);
  return value;
}
function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
function assertNoSymlinkAncestors(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail("path escapes repository root");
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail(`symlinked dispatcher path is not allowed: ${current}`);
  }
}

function isPosix() { return typeof process.getuid === "function"; }

// Capture the identity of a real directory (not a symlink). On POSIX the
// effective UID must own the directory and it must not be group/world writable.
// The dev+ino pair records the inode identity so replacement by symlink, mount
// rebinding, or directory recreation is detected on revalidation. A malicious
// process running under the same UID remains outside the local approval trust
// boundary; the global workspace guard only blocks coordinated repository
// writers in the same worktree.
function captureDirectoryIdentity(dirPath) {
  const stats = fs.lstatSync(dirPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail(`directory identity failed: ${dirPath} is not a real directory`);
  if (isPosix() && (stats.mode & 0o022) !== 0) fail(`directory identity failed: ${dirPath} is group or world writable`);
  return { path: dirPath, dev: stats.dev, ino: stats.ino, uid: isPosix() ? stats.uid : null, mode: stats.mode };
}

// Capture identities for every existing directory on the path from rootDir to
// candidatePath (inclusive). Non-existent tail segments are skipped because
// callers validate them separately (e.g., via O_EXCL or ENOENT handling).
function captureDirectoryChain(rootDir, candidatePath) {
  const resolvedRoot = fs.realpathSync(rootDir);
  let resolvedCandidate;
  try {
    resolvedCandidate = fs.realpathSync(candidatePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    let current = candidatePath;
    while (current !== resolvedRoot && !fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    resolvedCandidate = fs.existsSync(current) && fs.lstatSync(current).isDirectory() ? fs.realpathSync(current) : resolvedRoot;
  }
  if (!isWithin(resolvedRoot, resolvedCandidate) && resolvedCandidate !== resolvedRoot) fail("candidate escapes repository root");
  const chain = [captureDirectoryIdentity(resolvedRoot)];
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === "") return chain;
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try { chain.push(captureDirectoryIdentity(current)); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return chain;
}

function revalidateDirectoryChain(chain) {
  for (const entry of chain) {
    const current = captureDirectoryIdentity(entry.path);
    if (current.dev !== entry.dev || current.ino !== entry.ino || current.uid !== entry.uid || current.mode !== entry.mode) {
      fail(`directory identity changed: ${entry.path}`);
    }
  }
}

function atomicWriteJson(filePath, data) {
  atomicWriteBytes(filePath, Buffer.from(`${JSON.stringify(data, null, 2)}\n`), 0o600);
}

function validateEvidence(value, label) {
  const keys = ["commit_sha", "suite_path", "suite_hash", "command", "exit_code", "image_digest", "output_artifact"];
  exactKeys(value, keys, label);
  for (const key of ["commit_sha", "suite_path", "suite_hash", "command", "image_digest", "output_artifact"]) {
    if (typeof value[key] !== "string" || !value[key]) fail(`${label}.${key} must be a non-empty string`);
  }
  if (!Number.isInteger(value.exit_code)) fail(`${label}.exit_code must be an integer`);
}
function validateFindings(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  for (const finding of value) {
    exactKeys(finding, ["severity", "message", "evidence"], `${label} finding`);
    if (!["critical", "high", "medium", "low"].includes(finding.severity)) fail(`${label} severity is invalid`);
    if (typeof finding.message !== "string") fail(`${label} message must be a string`);
    stringArray(finding.evidence, `${label} evidence`);
  }
}
function validatePhaseData(artifact) {
  const data = artifact.phase_data;
  if (!isObject(data)) fail("phase_data must be an object");
  if (artifact.phase === "C") {
    const keys = ["complexity", "selected_flow", "scope", "non_goals", "test_strategy", "planned_files", "trust_boundaries", "security_triggers", "render_plan"];
    exactKeys(data, keys, "C phase_data");
    if (!["lite", "full"].includes(data.complexity) || !FLOWS.has(data.selected_flow)) fail("C complexity or selected_flow is invalid");
    if (typeof data.scope !== "string") fail("C scope must be a string");
    for (const key of ["non_goals", "test_strategy", "planned_files", "trust_boundaries", "render_plan"]) stringArray(data[key], `C ${key}`);
    stringArray(data.security_triggers, "C security_triggers", { unique: true });
    if (data.security_triggers.some((trigger) => !SECURITY_TRIGGERS.has(trigger))) fail("C security_triggers contains an unknown value");
  } else if (artifact.phase === "R") {
    exactKeys(data, ["red_evidence", "green_evidence", "implementation_notes", "patch_path"], "R phase_data");
    validateEvidence(data.red_evidence, "R red_evidence");
    validateEvidence(data.green_evidence, "R green_evidence");
    stringArray(data.implementation_notes, "R implementation_notes");
    if (data.patch_path !== null && typeof data.patch_path !== "string") fail("R patch_path must be string or null");
  } else if (artifact.phase === "A") {
    exactKeys(data, ["criteria_fit", "maintainability", "blocking_findings", "non_blocking_observations"], "A phase_data");
    exactKeys(data.criteria_fit, ["passed", "rationale"], "A criteria_fit");
    if (typeof data.criteria_fit.passed !== "boolean" || typeof data.criteria_fit.rationale !== "string") fail("A criteria_fit is invalid");
    const scores = ["correctness_risk", "locality_simplicity", "interface_clarity", "type_error_safety", "test_quality"];
    exactKeys(data.maintainability, scores, "A maintainability");
    for (const key of scores) {
      exactKeys(data.maintainability[key], ["score", "rationale"], `A ${key}`);
      if (!Number.isInteger(data.maintainability[key].score) || data.maintainability[key].score < 0 || data.maintainability[key].score > 4 || typeof data.maintainability[key].rationale !== "string") fail(`A ${key} score or rationale is invalid`);
    }
    validateFindings(data.blocking_findings, "A blocking_findings");
    stringArray(data.non_blocking_observations, "A non_blocking_observations");
  } else if (artifact.phase === "F") {
    exactKeys(data, ["findings_addressed", "documented_disagreements", "green_evidence", "patch_path"], "F phase_data");
    stringArray(data.findings_addressed, "F findings_addressed");
    stringArray(data.documented_disagreements, "F documented_disagreements");
    validateEvidence(data.green_evidence, "F green_evidence");
    if (data.patch_path !== null && typeof data.patch_path !== "string") fail("F patch_path must be string or null");
  } else if (artifact.phase === "T") {
    exactKeys(data, ["trust_boundaries_reviewed", "security_findings", "security_commands", "residual_risk"], "T phase_data");
    stringArray(data.trust_boundaries_reviewed, "T trust_boundaries_reviewed");
    validateFindings(data.security_findings, "T security_findings");
    stringArray(data.security_commands, "T security_commands");
    stringArray(data.residual_risk, "T residual_risk");
  } else if (artifact.phase === "S") {
    exactKeys(data, ["docs_changed", "domain_instructions_changed", "wiki_pages_changed", "durable_learnings"], "S phase_data");
    for (const key of ["docs_changed", "domain_instructions_changed", "wiki_pages_changed", "durable_learnings"]) stringArray(data[key], `S ${key}`);
  }
}

export function validatePhaseArtifact(artifact, { nodeId, attemptId, phase, acceptanceCriteria }) {
  exactKeys(artifact, TOP_LEVEL_KEYS, "phase artifact");
  if (artifact.schema_version !== 1 || artifact.node_id !== nodeId || artifact.attempt_id !== attemptId || artifact.phase !== phase) {
    fail("phase artifact identity does not match ledger operation");
  }
  if (!PHASES.has(artifact.phase) || !ARTIFACT_STATUSES.has(artifact.status)) fail("phase artifact phase or status is invalid");
  if (typeof artifact.model !== "string" || !/^[^/]+\/.+$/.test(artifact.model)) fail("phase artifact model is invalid");
  validDate(artifact.started_at, "started_at"); validDate(artifact.completed_at, "completed_at");
  if (typeof artifact.summary !== "string" || typeof artifact.recommended_next_step !== "string") fail("phase artifact summary fields are invalid");
  if (!Array.isArray(artifact.acceptance_criteria_status) || artifact.acceptance_criteria_status.length === 0) fail("acceptance_criteria_status must be a non-empty array");
  for (const item of artifact.acceptance_criteria_status) {
    exactKeys(item, ["criterion", "status", "evidence"], "acceptance criterion status");
    if (typeof item.criterion !== "string" || !["met", "unmet", "unknown", "not_tested"].includes(item.status)) fail("acceptance criterion status is invalid");
    stringArray(item.evidence, "acceptance criterion evidence");
  }
  if (acceptanceCriteria && JSON.stringify(artifact.acceptance_criteria_status.map((item) => item.criterion)) !== JSON.stringify(acceptanceCriteria)) {
    fail("acceptance_criteria_status must map every original criterion exactly once in source order");
  }
  stringArray(artifact.changed_files, "changed_files", { unique: true }); stringArray(artifact.risks, "risks"); stringArray(artifact.open_questions, "open_questions");
  if (["C", "A", "T"].includes(artifact.phase) && artifact.changed_files.length) fail(`${artifact.phase} must be read-only`);
  if (!Array.isArray(artifact.commands_run)) fail("commands_run must be an array");
  for (const command of artifact.commands_run) {
    exactKeys(command, ["command", "exit_code", "output_artifact"], "command evidence");
    if (typeof command.command !== "string" || !Number.isInteger(command.exit_code) || (command.output_artifact !== null && typeof command.output_artifact !== "string")) fail("command evidence is invalid");
  }
  exactKeys(artifact.cost, ["input_tokens", "output_tokens", "amount", "currency"], "cost");
  if (!Number.isInteger(artifact.cost.input_tokens) || artifact.cost.input_tokens < 0 || !Number.isInteger(artifact.cost.output_tokens) || artifact.cost.output_tokens < 0) fail("cost token counts are invalid");
  if (artifact.cost.amount !== null && (typeof artifact.cost.amount !== "number" || artifact.cost.amount < 0)) fail("cost amount is invalid");
  if (artifact.cost.currency !== null && typeof artifact.cost.currency !== "string") fail("cost currency is invalid");
  if (artifact.status === "passed" && artifact.failure_context !== null) fail("passed artifact failure_context must be null");
  if (artifact.status !== "passed") {
    exactKeys(artifact.failure_context, ["attempted", "failure_reason", "discoveries", "dead_ends"], "failure_context");
    stringArray(artifact.failure_context.attempted, "failure_context attempted");
    stringArray(artifact.failure_context.discoveries, "failure_context discoveries");
    stringArray(artifact.failure_context.dead_ends, "failure_context dead_ends");
    if (typeof artifact.failure_context.failure_reason !== "string") fail("failure_context failure_reason must be a string");
  }
  if (artifact.transcript_path !== null && typeof artifact.transcript_path !== "string") fail("transcript_path must be string or null");
  validatePhaseData(artifact);
  return artifact;
}

class FileLock {
  constructor(lockPath) { this.lockPath = lockPath; this.descriptor = null; this.token = `${process.pid}:${crypto.randomUUID()}`; }
  acquire() {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    try {
      this.descriptor = fs.openSync(this.lockPath, "wx", 0o600);
      fs.writeFileSync(this.descriptor, `${this.token}\n`);
      fs.fsyncSync(this.descriptor);
    } catch (error) {
      if (error.code === "EEXIST") fail(`ledger lock is held at ${this.lockPath}; after confirming no dispatcher is active, remove this stale lock manually`);
      throw error;
    }
  }
  release() {
    if (this.descriptor !== null) { try { fs.closeSync(this.descriptor); } catch {} this.descriptor = null; }
    try {
      if (fs.readFileSync(this.lockPath, "utf8").trim() === this.token) fs.unlinkSync(this.lockPath);
    } catch {}
  }
}

function nextPhase(attempt) {
  const phases = attempt.phases;
  if (attempt.flow === "R-S") return !phases.R ? "R" : !phases.S ? "S" : null;
  if (!phases.C) return "C";
  if (!phases.R) return "R";
  if (!phases.A) return "A";
  if (phases.A.status === "needs_fix" && !phases.F) return "F";
  if (!phases.T) return "T";
  if (!phases.S) return "S";
  return null;
}

export class GoalDispatcher {
  constructor({ rootDir = process.cwd(), runId = process.env.GOAL_RUN_ID || "default", planPath = "docs/raw/plans/proposed-build-dag.json" } = {}) {
    this.rootDir = fs.realpathSync(path.resolve(rootDir));
    this.runId = safeSegment(runId, "runId");
    const resolvedPlan = path.isAbsolute(planPath) ? path.resolve(planPath) : path.resolve(this.rootDir, planPath);
    this.planPath = fs.realpathSync(resolvedPlan);
    if (!isWithin(this.rootDir, this.planPath)) fail("plan path must be inside the repository root");
    this.ledgerBase = path.join(this.rootDir, ".pi", "goal-runs");
    this.ledgerDir = path.join(this.ledgerBase, this.runId);
    this.ledgerPath = path.join(this.ledgerDir, "ledger.json");
    this.lockPath = path.join(this.ledgerDir, "ledger.lock");
    this.workspaceGuardPath = path.join(this.ledgerBase, "workspace-writer.json");
    this.incomingDir = path.join(this.ledgerDir, "incoming");
  }
  static validatePlanObject(plan, byteLength) {
    if (byteLength > MIGRATION_BOUNDS.max_plan_bytes) fail("plan exceeds size bound");
    validateJsonBounds(plan, MIGRATION_BOUNDS, "plan");
    exactKeysOptional(plan, ["schema_version", "nodes", "approval"], ["kind", "source"], "plan");
    if (plan.schema_version !== 1) fail("plan schema_version must be 1");
    if (plan.kind !== undefined && (typeof plan.kind !== "string" || plan.kind.length > MIGRATION_BOUNDS.max_string_field)) fail("plan kind is invalid");
    if (plan.source !== undefined && (typeof plan.source !== "string" || plan.source.length > MIGRATION_BOUNDS.max_string_field)) fail("plan source is invalid");
    if (!Array.isArray(plan.nodes) || !plan.nodes.length) fail("plan nodes are invalid");
    exactKeysOptional(plan.approval, ["approved_by", "approved_at"], ["notes"], "plan approval");
    if (typeof plan.approval.approved_by !== "string" || !plan.approval.approved_by || plan.approval.approved_by.length > MIGRATION_BOUNDS.max_approver_length) fail("plan approval.approved_by is invalid");
    validDate(plan.approval.approved_at, "plan approval.approved_at");
    if (plan.approval.notes !== undefined && (typeof plan.approval.notes !== "string" || plan.approval.notes.length > MIGRATION_BOUNDS.max_approval_context_length)) fail("plan approval.notes is invalid");
    const required = ["id", "intent", "change_spec", "acceptance_criteria", "depends_on"];
    const ids = new Set();
    for (const node of plan.nodes) {
      exactKeys(node, required, `plan node ${node.id || "<unknown>"}`);
      safeSegment(node.id, "plan node ID");
      if (ids.has(node.id)) fail(`plan node ID is duplicated: ${node.id}`);
      ids.add(node.id);
      if (typeof node.intent !== "string" || typeof node.change_spec !== "string") fail(`plan node ${node.id} contract is invalid`);
      stringArray(node.acceptance_criteria, `plan node ${node.id} acceptance_criteria`); stringArray(node.depends_on, `plan node ${node.id} depends_on`);
      if (node.id.length > MIGRATION_BOUNDS.max_id_length || node.intent.length > MIGRATION_BOUNDS.max_string_field || node.change_spec.length > MIGRATION_BOUNDS.max_string_field) fail(`node ${node.id} field is out of bounds`);
    }
    const incoming = new Map(plan.nodes.map((node) => [node.id, new Set(node.depends_on)]));
    for (const [id, dependencies] of incoming) for (const dependency of dependencies) {
      if (dependency === id || !ids.has(dependency)) fail(`plan node ${id} has invalid dependency ${dependency}`);
    }
    const ready = [...incoming].filter(([, dependencies]) => dependencies.size === 0).map(([id]) => id);
    const visited = [];
    while (ready.length) {
      const id = ready.shift(); visited.push(id);
      for (const [candidate, dependencies] of incoming) if (dependencies.delete(id) && dependencies.size === 0 && !visited.includes(candidate) && !ready.includes(candidate)) ready.push(candidate);
    }
    if (visited.length !== plan.nodes.length) fail("plan contains a cycle or has no root");
    return plan;
  }
  static validatePlan(planPath) {
    if (!fs.existsSync(planPath)) fail(`plan not found: ${planPath}`);
    const raw = fs.readFileSync(planPath);
    let plan;
    try { plan = JSON.parse(raw); } catch (error) { fail(`plan JSON parse error: ${error.message}`); }
    GoalDispatcher.validatePlanObject(plan, raw.length);
    return { plan, sha: sha256(raw) };
  }
  _withLock(operation) { const lock = new FileLock(this.lockPath); lock.acquire(); try { return operation(); } finally { lock.release(); } }
  _readLedger() { return JSON.parse(fs.readFileSync(this.ledgerPath, "utf8")); }
  _writeLedger(ledger) { ledger.updated_at = new Date().toISOString(); atomicWriteJson(this.ledgerPath, ledger); }
  _migrationHook(/* name */) { /* no-op; tests may override for deterministic race injection */ }
  _assertNoDrift(ledger) { const current = sha256File(this.planPath); if (current !== ledger.frozen_plan_sha) fail(`plan drift detected: frozen ${ledger.frozen_plan_sha}, current ${current}`); }
  _guardIdentity(nodeId, attemptId) { return { run_id: this.runId, node_id: nodeId, attempt_id: attemptId, workspace: this.rootDir }; }
  _ensureWorkspaceGuard(nodeId, attemptId) {
    const expected = this._guardIdentity(nodeId, attemptId);
    fs.mkdirSync(this.ledgerBase, { recursive: true });
    assertNoSymlinkAncestors(this.rootDir, this.ledgerBase);
    if (fs.existsSync(this.workspaceGuardPath) && fs.lstatSync(this.workspaceGuardPath).isSymbolicLink()) fail("symlinked workspace guard is not allowed");
    try {
      const descriptor = fs.openSync(this.workspaceGuardPath, "wx", 0o600);
      try { fs.writeFileSync(descriptor, `${JSON.stringify(expected)}\n`); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (fs.lstatSync(this.workspaceGuardPath).isSymbolicLink()) fail("symlinked workspace guard is not allowed");
      const existing = JSON.parse(fs.readFileSync(this.workspaceGuardPath, "utf8"));
      if (canonical(existing) === canonical(expected)) return false;
      fail(`workspace already has active writer ${existing.run_id}/${existing.node_id}/${existing.attempt_id}; use a distinct git worktree`);
    }
  }
  _releaseWorkspaceGuard(nodeId, attemptId) {
    if (!fs.existsSync(this.workspaceGuardPath)) return;
    const expected = this._guardIdentity(nodeId, attemptId);
    const existing = JSON.parse(fs.readFileSync(this.workspaceGuardPath, "utf8"));
    if (canonical(existing) === canonical(expected)) fs.unlinkSync(this.workspaceGuardPath);
  }
  _frontier(ledger) {
    const effective = Object.fromEntries(Object.entries(ledger.nodes).map(([id, node]) => [id, node.status]));
    let changed = true;
    while (changed) { changed = false; for (const [id, node] of Object.entries(ledger.nodes)) if (effective[id] === "pending" && node.depends_on.some((dependency) => ["failed", "blocked", "escalated"].includes(effective[dependency]))) { effective[id] = "blocked"; changed = true; } }
    const result = { ready: [], pending: [], inProgress: [], completed: [], failed: [], blocked: [] };
    for (const [id, node] of Object.entries(ledger.nodes)) {
      const status = effective[id];
      if (status === "in_progress") result.inProgress.push(id);
      else if (status === "passed") result.completed.push(id);
      else if (status === "failed" || status === "escalated") result.failed.push(id);
      else if (status === "blocked") result.blocked.push(id);
      else if (node.depends_on.every((dependency) => effective[dependency] === "passed")) result.ready.push(id);
      else result.pending.push(id);
    }
    for (const values of Object.values(result)) values.sort();
    return result;
  }
  init() {
    assertNoSymlinkAncestors(this.rootDir, this.ledgerDir);
    fs.mkdirSync(this.incomingDir, { recursive: true });
    assertNoSymlinkAncestors(this.rootDir, this.ledgerDir);
    return this._withLock(() => {
      const { plan, sha } = GoalDispatcher.validatePlan(this.planPath);
      if (fs.existsSync(this.ledgerPath)) { const ledger = this._readLedger(); if (ledger.frozen_plan_sha !== sha) fail("plan drift detected on init"); return { created: false, ledger_path: this.ledgerPath }; }
      const nodes = Object.fromEntries(plan.nodes.map((node) => [node.id, { status: "pending", depends_on: [...node.depends_on], attempts: [] }]));
      const now = new Date().toISOString();
      this._writeLedger({ schema_version: 1, run_id: this.runId, created_at: now, updated_at: now, frozen_plan_sha: sha, plan_path: path.relative(this.rootDir, this.planPath), nodes, amendments: [] });
      return { created: true, ledger_path: this.ledgerPath };
    });
  }
  status() {
    const ledger = this._readLedger(); const current = sha256File(this.planPath);
    return { run_id: ledger.run_id, frozen_plan_sha: ledger.frozen_plan_sha, current_plan_sha: current, planDrift: current !== ledger.frozen_plan_sha, ...this._frontier(ledger) };
  }
  resume() {
    const ledger = this._readLedger(); this._assertNoDrift(ledger); const frontier = this._frontier(ledger);
    const nodeId = frontier.inProgress[0] || null;
    if (!nodeId) return { ...this.status(), active_attempt: null };
    const attempt = ledger.nodes[nodeId].attempts.at(-1);
    this._ensureWorkspaceGuard(nodeId, attempt.attempt_id);
    return { ...this.status(), active_attempt: { node_id: nodeId, attempt_id: attempt.attempt_id, flow: attempt.flow, next_phase: nextPhase(attempt) } };
  }
  start({ nodeId, flow = "C-R-A-F-T-S" } = {}) {
    if (!FLOWS.has(flow)) fail(`invalid flow: ${flow}`);
    return this._withLock(() => {
      const ledger = this._readLedger(); this._assertNoDrift(ledger); const frontier = this._frontier(ledger);
      if (frontier.inProgress.length) {
        const activeNode = frontier.inProgress[0]; const active = ledger.nodes[activeNode].attempts.at(-1);
        if (!nodeId || nodeId === activeNode) { this._ensureWorkspaceGuard(activeNode, active.attempt_id); return { node_id: activeNode, attempt_id: active.attempt_id, flow: active.flow, resumed: true }; }
        fail(`node ${activeNode} is already in progress; explicit parallelism requires a distinct git worktree and GOAL_RUN_ID`);
      }
      const target = nodeId || frontier.ready[0];
      if (!target || !frontier.ready.includes(target)) fail(`node ${target || "<none>"} is not in the ready frontier`);
      const sequence = ledger.nodes[target].attempts.length + 1;
      const attemptId = `${target}-attempt-${sequence}`;
      this._ensureWorkspaceGuard(target, attemptId);
      ledger.nodes[target].status = "in_progress";
      ledger.nodes[target].attempts.push({ attempt_id: attemptId, sequence, flow, started_at: new Date().toISOString(), base_git: gitSnapshot(this.rootDir), phases: {}, final_status: null });
      try { this._writeLedger(ledger); } catch (error) { this._releaseWorkspaceGuard(target, attemptId); throw error; }
      return { node_id: target, attempt_id: attemptId, flow, resumed: false };
    });
  }
  recordPhase(nodeId, attemptId, phase, artifact) {
    if (!PHASES.has(phase)) fail(`invalid phase: ${phase}`);
    const { plan } = GoalDispatcher.validatePlan(this.planPath);
    const planNode = plan.nodes.find((node) => node.id === nodeId);
    if (!planNode) fail(`unknown plan node: ${nodeId}`);
    validatePhaseArtifact(artifact, { nodeId, attemptId, phase, acceptanceCriteria: planNode.acceptance_criteria });
    return this._withLock(() => {
      const ledger = this._readLedger(); this._assertNoDrift(ledger);
      const node = ledger.nodes[nodeId]; const attempt = node?.attempts.find((item) => item.attempt_id === attemptId);
      if (!attempt) fail(`unknown node or attempt: ${nodeId}/${attemptId}`);
      if (node.status !== "in_progress" || attempt.final_status !== null) fail("phase artifacts can be recorded only for an active attempt");
      const digest = sha256(canonical(artifact));
      const existing = attempt.phases[phase];
      if (existing) { if (existing.sha256 === digest) return { path: existing.path, sha256: digest, replayed: true }; fail(`conflicting replay for phase ${phase}`); }
      const expected = nextPhase(attempt);
      if (expected !== phase) fail(`phase order violation: expected ${expected}, got ${phase}`);
      if (phase === "C" && artifact.phase_data.selected_flow !== attempt.flow) fail("C selected_flow does not match reserved attempt flow");
      const relativePath = path.join("phases", nodeId, attemptId, `${phase}.json`);
      assertNoSymlinkAncestors(this.rootDir, path.dirname(path.join(this.ledgerDir, relativePath)));
      atomicWriteJson(path.join(this.ledgerDir, relativePath), artifact);
      attempt.phases[phase] = { path: relativePath, sha256: digest, status: artifact.status, recorded_at: new Date().toISOString() };
      this._writeLedger(ledger);
      return { path: relativePath, sha256: digest, replayed: false };
    });
  }
  complete(nodeId, attemptId, status) {
    if (!["passed", "failed", "escalated"].includes(status)) fail(`invalid completion status: ${status}`);
    return this._withLock(() => {
      const ledger = this._readLedger(); this._assertNoDrift(ledger);
      const node = ledger.nodes[nodeId]; const attempt = node?.attempts.find((item) => item.attempt_id === attemptId);
      if (!attempt || node.status !== "in_progress" || attempt.final_status !== null) fail("node attempt is not active");
      if (status === "passed") {
        if (nextPhase(attempt) !== null) fail(`cannot pass incomplete attempt; next phase is ${nextPhase(attempt)}`);
        for (const [phase, record] of Object.entries(attempt.phases)) {
          if (phase === "A" && record.status === "needs_fix" && attempt.phases.F?.status === "passed") continue;
          if (record.status !== "passed") fail(`cannot pass attempt with non-passing phase ${phase}`);
        }
      }
      node.status = status; attempt.final_status = status; attempt.completed_at = new Date().toISOString();
      const summary = { schema_version: 1, node_id: nodeId, attempt_id: attemptId, status, flow: attempt.flow, completed_at: attempt.completed_at, phases: attempt.phases };
      const relativePath = path.join("nodes", nodeId, attemptId, "completion.json");
      assertNoSymlinkAncestors(this.rootDir, path.dirname(path.join(this.ledgerDir, relativePath)));
      atomicWriteJson(path.join(this.ledgerDir, relativePath), summary); attempt.completion_path = relativePath;
      this._writeLedger(ledger);
      this._releaseWorkspaceGuard(nodeId, attemptId);
      let telemetryCandidate;
      try {
        const { plan } = GoalDispatcher.validatePlan(this.planPath);
        telemetryCandidate = emitEvalCandidate({ rootDir: this.rootDir, runId: this.runId, plan, ledger, nodeId, attemptId });
      } catch (error) {
        telemetryCandidate = { status: "degraded", error_code: typeof error?.code === "string" ? error.code : "candidate_write_failed" };
      }
      return { node_id: nodeId, attempt_id: attemptId, status, completion_path: relativePath, telemetry_candidate: telemetryCandidate };
    });
  }
  emitCandidate(nodeId, attemptId) {
    const ledger = this._readLedger();
    this._assertNoDrift(ledger);
    const node = ledger.nodes?.[nodeId];
    const attempt = node?.attempts?.find((candidate) => candidate.attempt_id === attemptId);
    if (!attempt?.final_status) fail("candidate source attempt is not complete");
    const { plan } = GoalDispatcher.validatePlan(this.planPath);
    return emitEvalCandidate({ rootDir: this.rootDir, runId: this.runId, plan, ledger, nodeId, attemptId });
  }
  migratePlan({ oldPlanPath, newPlanPath, approvalPath }) {
    const oldFile = safeOpenRead(this.rootDir, oldPlanPath, "old plan");
    const newFile = safeOpenRead(this.rootDir, newPlanPath, "new plan");
    const approvalFile = safeOpenRead(this.rootDir, approvalPath, "approval envelope");
    if (oldFile.bytes.length > MIGRATION_BOUNDS.max_plan_bytes) fail("old plan exceeds size bound");
    if (newFile.bytes.length > MIGRATION_BOUNDS.max_plan_bytes) fail("new plan exceeds size bound");
    if (approvalFile.bytes.length > MIGRATION_BOUNDS.max_approval_bytes) fail("approval envelope exceeds size bound");
    if (newFile.realPath !== this.planPath) fail("newPlanPath must resolve to dispatcher.planPath");

    const oldSha = sha256(oldFile.bytes);
    const newSha = sha256(newFile.bytes);
    const approvalSha = sha256(approvalFile.bytes);

    let oldPlan;
    let newPlan;
    let envelope;
    try { oldPlan = JSON.parse(oldFile.bytes); } catch (error) { fail(`old plan JSON parse error: ${error.message}`); }
    try { newPlan = JSON.parse(newFile.bytes); } catch (error) { fail(`new plan JSON parse error: ${error.message}`); }
    try { envelope = JSON.parse(approvalFile.bytes); } catch (error) { fail(`approval envelope JSON parse error: ${error.message}`); }

    GoalDispatcher.validatePlanObject(oldPlan, oldFile.bytes.length);
    GoalDispatcher.validatePlanObject(newPlan, newFile.bytes.length);
    validateApprovalEnvelope(envelope);

    if (envelope.run_id !== this.runId) fail("approval run_id does not match dispatcher run ID");
    if (envelope.expected_old_plan_sha256 !== oldSha) fail("expected old plan hash does not match actual old plan bytes");
    if (envelope.approved_new_plan_sha256 !== newSha) fail("approved new plan hash does not match actual new plan bytes");

    const oldApprovedAt = Date.parse(oldPlan.approval.approved_at);
    const approvedAt = Date.parse(envelope.approved_at);
    const now = Date.now();
    if (Number.isNaN(oldApprovedAt) || Number.isNaN(approvedAt)) fail("approval timestamps are invalid");
    if (approvedAt <= oldApprovedAt) fail("approval approved_at must be later than the old plan approval timestamp");
    if (approvedAt > now + CLOCK_SKEW_MS) fail("approval approved_at is too far in the future");

    const approvalRel = path.relative(this.rootDir, approvalFile.realPath).split(path.sep).join("/");
    const trustBasis = validateTrustBasis(approvalFile.stats, approvalRel);

    if (oldPlan.nodes.length > MIGRATION_BOUNDS.max_nodes || newPlan.nodes.length > MIGRATION_BOUNDS.max_nodes) fail("plan has too many nodes");

    return this._withLock(() => {
      const ledger = this._readLedger();
      const frontier = this._frontier(ledger);
      if (frontier.inProgress.length) fail(`active attempt in progress: ${frontier.inProgress[0]}`);

      const migrationId = this._guardIdentity("migration", `migration-${process.pid}-${crypto.randomUUID()}`);
      let guardAcquired = false;
      try {
        this._ensureWorkspaceGuard(migrationId.node_id, migrationId.attempt_id);
        guardAcquired = true;
      } catch (error) {
        this._releaseWorkspaceGuard(migrationId.node_id, migrationId.attempt_id);
        throw error;
      }
      const ledgerChain = captureDirectoryChain(this.rootDir, this.ledgerDir);

      try {
        if (!ledger.amendments) ledger.amendments = [];

        const replayIndex = ledger.amendments.findIndex((amendment) => amendment.old_plan_sha === oldSha && amendment.new_plan_sha === newSha && amendment.approval_envelope_sha === approvalSha);
        if (replayIndex !== -1) {
          this._verifyReplay({ ledger, amendment: ledger.amendments[replayIndex], oldSha, newSha, approvalSha, oldBytes: oldFile.bytes, newBytes: newFile.bytes, approvalBytes: approvalFile.bytes });
          return { old_plan_sha: oldSha, new_plan_sha: newSha, amendment_index: replayIndex, replayed: true, manifest_sha: ledger.amendments[replayIndex].evidence_manifest_sha };
        }
        if (ledger.amendments.some((amendment) => amendment.old_plan_sha === oldSha && (amendment.new_plan_sha !== newSha || amendment.approval_envelope_sha !== approvalSha))) {
          fail("conflicting migration replay");
        }

        if (ledger.frozen_plan_sha !== oldSha) fail("ledger frozen plan hash does not match old plan hash");
        compareMigrationPlans(oldPlan, newPlan, ledger.nodes);
        const completedEvidence = verifyCompletedEvidence(ledger, this.ledgerDir);

        const oldSnapshot = writeImmutableObject(this.ledgerDir, path.join("migrations", "objects"), oldFile.bytes);
        const newSnapshot = writeImmutableObject(this.ledgerDir, path.join("migrations", "objects"), newFile.bytes);
        const approvalSnapshot = writeImmutableObject(this.ledgerDir, path.join("migrations", "objects"), approvalFile.bytes);

        const manifest = buildManifest({
          oldSha,
          newSha,
          oldObjectSha: oldSnapshot.sha,
          newObjectSha: newSnapshot.sha,
          approvalSha,
          approvalObjectSha: approvalSnapshot.sha,
          completedEvidence,
        });
        const manifestBytes = Buffer.from(canonical(manifest), "utf8");
        const manifestSnapshot = writeImmutableObject(this.ledgerDir, path.join("migrations", "objects"), manifestBytes);

        const amendment = buildAmendment({ envelope, approvalSha, manifestSha: manifestSnapshot.sha, trustBasis });
        const amendmentBytes = Buffer.from(canonical(amendment), "utf8");
        const amendmentSnapshot = writeImmutableObject(this.ledgerDir, path.join("migrations", "objects"), amendmentBytes);

        this._migrationHook("before-activation-recheck");

        revalidateDirectoryChain(ledgerChain);

        if (!fs.existsSync(this.workspaceGuardPath)) fail("migration guard disappeared before activation");
        const currentGuard = JSON.parse(fs.readFileSync(this.workspaceGuardPath, "utf8"));
        if (canonical(currentGuard) !== canonical(migrationId)) fail("migration guard changed before activation");

        const finalPlan = safeOpenRead(this.rootDir, path.relative(this.rootDir, this.planPath), "canonical plan");
        if (sha256(finalPlan.bytes) !== newSha) fail("canonical plan changed after pre-lock read");

        verifyCompletedEvidence(ledger, this.ledgerDir);

        const recheckFrontier = this._frontier(ledger);
        if (recheckFrontier.inProgress.length) fail(`active attempt in progress: ${recheckFrontier.inProgress[0]}`);

        ledger.frozen_plan_sha = newSha;
        ledger.amendments.push({ ...amendment, amendment_object_sha: amendmentSnapshot.sha });
        this._writeLedger(ledger);
        revalidateDirectoryChain(ledgerChain);

        return { old_plan_sha: oldSha, new_plan_sha: newSha, amendment_index: ledger.amendments.length - 1, replayed: false, manifest_sha: manifestSnapshot.sha };
      } finally {
        if (guardAcquired) this._releaseWorkspaceGuard(migrationId.node_id, migrationId.attempt_id);
      }
    });
  }
  _verifyReplay({ ledger, amendment, oldSha, newSha, approvalSha, oldBytes, newBytes, approvalBytes }) {
    const planFile = safeOpenRead(this.rootDir, path.relative(this.rootDir, this.planPath), "canonical plan");
    if (sha256(planFile.bytes) !== newSha) fail("current canonical plan hash does not match approved new hash");
    if (ledger.frozen_plan_sha !== newSha) fail("ledger frozen plan hash does not match approved new hash");

    const expectObject = (expectedSha, expectedBytes, label) => {
      const resolved = safeOpenRead(this.ledgerDir, path.join("migrations", "objects", expectedSha), label);
      const actualSha = sha256(resolved.bytes);
      if (actualSha !== expectedSha) fail(`${label} object digest mismatch`);
      if (expectedBytes && Buffer.compare(resolved.bytes, expectedBytes) !== 0) fail(`${label} object bytes mismatch`);
      return resolved.bytes;
    };
    expectObject(oldSha, oldBytes, "old plan");
    expectObject(newSha, newBytes, "new plan");
    expectObject(approvalSha, approvalBytes, "approval envelope");

    const manifestBytes = expectObject(amendment.evidence_manifest_sha, null, "manifest");
    const manifestObj = JSON.parse(manifestBytes);
    const recomputedEvidence = verifyCompletedEvidence(ledger, this.ledgerDir);
    const recomputedManifest = buildManifest({
      oldSha,
      newSha,
      oldObjectSha: oldSha,
      newObjectSha: newSha,
      approvalSha,
      approvalObjectSha: approvalSha,
      completedEvidence: recomputedEvidence,
    });
    if (canonical(manifestObj) !== canonical(recomputedManifest)) fail("manifest does not match recomputed manifest");

    const amendmentBytes = expectObject(amendment.amendment_object_sha, null, "amendment");
    const amendmentObj = JSON.parse(amendmentBytes);
    const derivedAmendment = buildAmendment({
      envelope: {
        expected_old_plan_sha256: amendment.old_plan_sha,
        approved_new_plan_sha256: amendment.new_plan_sha,
        approver: amendment.approver,
        approved_at: amendment.approved_at,
        approval_context: amendment.approval_context,
      },
      approvalSha: amendment.approval_envelope_sha,
      manifestSha: amendment.evidence_manifest_sha,
      trustBasis: amendment.trust_basis,
    });
    if (canonical(amendmentObj) !== canonical(derivedAmendment)) fail("amendment object does not match ledger entry");
  }
}

function readIncomingArtifact(dispatcher, artifactPath) {
  const resolved = fs.realpathSync(path.resolve(artifactPath));
  const incoming = fs.realpathSync(dispatcher.incomingDir);
  if (!isWithin(incoming, resolved) || fs.lstatSync(path.resolve(artifactPath)).isSymbolicLink()) {
    fail(`artifact path must be a non-symlinked file under ${dispatcher.incomingDir}`);
  }
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

function main(argv) {
  const dispatcher = new GoalDispatcher(); const command = argv[2]; const print = (value) => console.log(JSON.stringify(value, null, 2));
  try {
    if (command === "init") print(dispatcher.init());
    else if (command === "status") print(dispatcher.status());
    else if (command === "resume") print(dispatcher.resume());
    else if (command === "start") print(dispatcher.start({ nodeId: argv[3] || undefined, flow: argv[4] || "C-R-A-F-T-S" }));
    else if (command === "record-phase") { const [nodeId, attemptId, phase, artifactPath] = argv.slice(3); if (!artifactPath) fail("usage: record-phase <node> <attempt> <phase> <artifact.json>"); print(dispatcher.recordPhase(nodeId, attemptId, phase, readIncomingArtifact(dispatcher, artifactPath))); }
    else if (command === "complete") { const [nodeId, attemptId, status] = argv.slice(3); if (!status) fail("usage: complete <node> <attempt> <passed|failed|escalated>"); print(dispatcher.complete(nodeId, attemptId, status)); }
    else if (command === "emit-candidate") { const [nodeId, attemptId] = argv.slice(3); if (!attemptId) fail("usage: emit-candidate <node> <attempt>"); print(dispatcher.emitCandidate(nodeId, attemptId)); }
    else if (command === "migrate-plan") { const [oldPlan, newPlan, approval] = argv.slice(3); if (!approval) fail("usage: migrate-plan <old-plan.json> <new-plan.json> <approval.json>"); print(dispatcher.migratePlan({ oldPlanPath: oldPlan, newPlanPath: newPlan, approvalPath: approval })); }
    else fail("usage: goal-dispatcher.mjs <init|status|resume|start|record-phase|complete|emit-candidate|migrate-plan>");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv);
