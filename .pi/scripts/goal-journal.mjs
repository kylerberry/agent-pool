import crypto from "node:crypto";

export const JOURNAL_SCHEMA_VERSION = 2;
export const PHASES = new Set(["C", "R", "A", "F", "T", "S"]);
export const ARTIFACT_STATUSES = new Set(["passed", "needs_fix", "failed", "blocked"]);
export const FLOWS = new Set(["C-R-A-F-T-S", "R-S"]);
export const SECURITY_TRIGGERS = new Set([
  "trust-boundary-change",
  "untrusted-input",
  "authentication-authorization",
  "secrets-sensitive-data",
  "external-integration",
  "file-command-execution",
  "ci-deploy-permissions",
  "tenant-isolation",
]);
export const CHECKPOINT_KINDS = new Set(["plan-security"]);
export const DECISION_OUTCOMES = new Set(["defer-and-proceed", "stop-and-rescope"]);
export const SEVERITIES = new Set(["critical", "high", "medium", "low"]);

function fail(message) { throw new Error(message); }
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
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

function stringArray(value, label, { unique = false, nonEmpty = false } = {}) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) fail(`${label} must be a string array`);
  if (unique && new Set(value).size !== value.length) fail(`${label} must contain unique values`);
  if (nonEmpty && value.length === 0) fail(`${label} must be non-empty`);
}

export function hashJson(value) {
  return sha256(canonical(value));
}

export function recordsIncludingLatest(history, latest) {
  const records = Array.isArray(history) ? [...history] : [];
  if (latest && !records.some((record) => record.path === latest.path && record.sha256 === latest.sha256)) {
    records.push(latest);
  }
  return records;
}

export function latestRecord(history, latest) {
  return recordsIncludingLatest(history, latest).at(-1) || null;
}

export function phaseRecords(attempt, phase) {
  return recordsIncludingLatest(attempt.phase_history?.[phase], attempt.phases?.[phase]);
}

export function latestPhase(attempt, phase) {
  return phaseRecords(attempt, phase).at(-1) || null;
}

export function ensurePhaseHistory(attempt) {
  attempt.phase_history ||= {};
  for (const [phase, record] of Object.entries(attempt.phases || {})) {
    attempt.phase_history[phase] = recordsIncludingLatest(attempt.phase_history[phase], record);
  }
  return attempt.phase_history;
}

export function normalizeLedger(ledger) {
  ledger ||= {};
  ledger.schema_version = JOURNAL_SCHEMA_VERSION;
  ledger.nodes ||= {};
  for (const node of Object.values(ledger.nodes)) {
    node.status ||= "pending";
    node.depends_on ||= [];
    node.attempts ||= [];
    for (const attempt of node.attempts) {
      attempt.phases ||= {};
      attempt.phase_history ||= {};
      attempt.checkpoints ||= [];
      attempt.decisions ||= [];
      ensurePhaseHistory(attempt);
    }
  }
  ledger.amendments ||= [];
  return ledger;
}

export function computeFrontier(ledger) {
  const effective = Object.fromEntries(Object.entries(ledger.nodes).map(([id, node]) => [id, node.status]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, node] of Object.entries(ledger.nodes)) {
      if (effective[id] === "pending" && node.depends_on.some((dependency) => ["failed", "blocked", "escalated"].includes(effective[dependency]))) {
        effective[id] = "blocked";
        changed = true;
      }
    }
  }
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

// Direct attempt-scoped decision targets: {type: "phase"|"checkpoint", name, revision}. A
// decision matches its target only when its attempt_id equals the attempt and the target is
// structurally identical, or when it is a legacy hash-bound record whose hash resolves to
// exactly one record of the same attempt with that derived target. Ambiguity or absence never
// authorizes work.
function sameTarget(a, b) {
  return isObject(a) && isObject(b) && a.type === b.type && a.name === b.name && a.revision === b.revision;
}

function phaseRecordByRevision(attempt, phase, revision) {
  return phaseRecords(attempt, phase)[revision - 1] || null;
}

function checkpointRecordByRevision(attempt, kind, revision) {
  const records = attempt.checkpoints?.filter((checkpoint) => checkpoint.kind === kind) || [];
  return records[revision - 1] || null;
}

export function legacyBoundTarget(attempt, hash) {
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return null;
  const matches = [];
  for (const checkpoint of attempt.checkpoints || []) {
    if (checkpoint.sha256 === hash) matches.push({ type: "checkpoint", name: checkpoint.kind, revision: (attempt.checkpoints || []).filter((item) => item.kind === checkpoint.kind).indexOf(checkpoint) + 1 });
  }
  for (const phase of PHASES) {
    const records = phaseRecords(attempt, phase);
    for (const record of records) {
      if (record.sha256 === hash) matches.push({ type: "phase", name: phase, revision: records.indexOf(record) + 1 });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function resolveDecisionTarget(attempt, decision) {
  if (decision?.attempt_id !== undefined) {
    return decision.attempt_id === attempt.attempt_id && isObject(decision.target) ? decision.target : null;
  }
  if (decision?.bound_to !== undefined) return legacyBoundTarget(attempt, decision.bound_to);
  return null;
}

function decisionForTarget(attempt, target) {
  return attempt.decisions?.find((decision) => sameTarget(resolveDecisionTarget(attempt, decision), target)) || null;
}

function phaseDecision(attempt, phase) {
  const records = phaseRecords(attempt, phase);
  if (!records.length) return null;
  return decisionForTarget(attempt, { type: "phase", name: phase, revision: records.length });
}

function checkpointDecision(attempt, kind) {
  const records = attempt.checkpoints?.filter((checkpoint) => checkpoint.kind === kind) || [];
  if (!records.length) return null;
  return decisionForTarget(attempt, { type: "checkpoint", name: kind, revision: records.length });
}

export function boundFixTarget(attempt) {
  for (const phase of ["A", "T"]) {
    const records = phaseRecords(attempt, phase);
    const latest = records.at(-1);
    if (latest && latest.status === "needs_fix") {
      const decision = phaseDecision(attempt, phase);
      if (!decision || decision.outcome !== "defer-and-proceed") {
        const boundF = phaseRecords(attempt, "F").find((f) => f.bound_to === latest.sha256);
        if (!boundF || boundF.status !== "passed") return latest;
      }
    }
  }
  return null;
}

function revisableOrDecision(attempt, phase) {
  const records = phaseRecords(attempt, phase);
  if (records.length < 2) return { phase };
  return { decision: { type: "phase", name: phase, revision: records.length } };
}

function phaseEffectivelyPassed(attempt, phase) {
  const records = phaseRecords(attempt, phase);
  const latest = records.at(-1);
  if (!latest) return false;
  if (latest.status === "passed") return true;
  if (latest.status === "needs_fix") {
    const decision = phaseDecision(attempt, phase);
    return decision?.outcome === "defer-and-proceed";
  }
  return false;
}

function latestCheckpoint(attempt, kind) {
  return attempt.checkpoints?.filter((checkpoint) => checkpoint.kind === kind).at(-1) || null;
}

function planSecurityCycles(attempt) {
  return attempt.checkpoints?.filter((checkpoint) => checkpoint.kind === "plan-security").length || 0;
}

export function nextAction(attempt) {
  if (!FLOWS.has(attempt.flow)) fail(`invalid attempt flow: ${attempt.flow}`);

  if (attempt.flow === "R-S") {
    for (const phase of ["R", "S"]) {
      if (!latestPhase(attempt, phase)) return { phase };
      if (!phaseEffectivelyPassed(attempt, phase)) return revisableOrDecision(attempt, phase);
    }
    return { complete: true };
  }

  const cRecords = phaseRecords(attempt, "C");
  const c = cRecords.at(-1);
  if (!c) return { phase: "C" };
  if (!phaseEffectivelyPassed(attempt, "C")) return revisableOrDecision(attempt, "C");

  const triggers = c.triggers || [];
  if (triggers.length > 0) {
    const cRevisionCount = cRecords.length;
    const planSecurityRecords = attempt.checkpoints?.filter((checkpoint) => checkpoint.kind === "plan-security") || [];
    const psCount = planSecurityRecords.length;
    const latestPlanSecurity = planSecurityRecords.at(-1) || null;

    if (cRevisionCount > psCount) return { checkpoint: "plan-security" };
    if (cRevisionCount < psCount) fail("checkpoint chronology inconsistent: more plan-security checkpoints than C revisions");

    if (!latestPlanSecurity) return { checkpoint: "plan-security" };
    if (latestPlanSecurity.status === "needs-replan") {
      if (psCount < 2) return { phase: "C" };
      const decision = checkpointDecision(attempt, "plan-security");
      if (!decision) return { decision: { type: "checkpoint", name: "plan-security", revision: psCount } };
      if (decision.outcome === "stop-and-rescope") return { outcome: "stop-and-rescope" };
      const hasCriticalHigh = (latestPlanSecurity.findings || []).some((f) => ["critical", "high"].includes(f.severity));
      if (hasCriticalHigh) fail("defer-and-proceed is not allowed for unresolved critical/high plan-security findings");
    }
  }

  for (const phase of ["R", "A", "T", "S"]) {
    const records = phaseRecords(attempt, phase);
    const latest = records.at(-1);
    if (!latest) return { phase };
    if (latest.status === "passed") continue;
    if (["R", "S"].includes(phase)) return revisableOrDecision(attempt, phase);
    if (latest.status === "needs_fix") {
      const decision = phaseDecision(attempt, phase);
      if (decision?.outcome === "defer-and-proceed") continue;
      if (decision?.outcome === "stop-and-rescope") return { outcome: "stop-and-rescope" };

      const needsFixCount = records.filter((record) => record.status === "needs_fix").length;
      if (needsFixCount >= 2) return { decision: { type: "phase", name: phase, revision: records.length } };

      const boundF = phaseRecords(attempt, "F").find((f) => f.bound_to === latest.sha256);
      if (!boundF || boundF.status !== "passed") return { phase: "F" };
      return { phase };
    }
    return null;
  }
  return { complete: true };
}

export function validatePhaseArtifact(artifact, { nodeId, attemptId, phase, acceptanceCriteria }) {
  exactKeys(artifact, [
    "schema_version", "node_id", "attempt_id", "phase", "status", "model",
    "started_at", "completed_at", "summary", "acceptance_criteria_status",
    "changed_files", "commands_run", "cost", "risks", "open_questions",
    "recommended_next_step", "failure_context", "transcript_path", "phase_data",
  ], "phase artifact");

  if (artifact.schema_version !== 1 || artifact.node_id !== nodeId || artifact.attempt_id !== attemptId || artifact.phase !== phase) {
    fail("phase artifact identity does not match ledger operation");
  }
  if (!PHASES.has(artifact.phase) || !ARTIFACT_STATUSES.has(artifact.status)) fail("phase artifact phase or status is invalid");
  if (typeof artifact.model !== "string" || !/^[^/]+\/.+$/.test(artifact.model)) fail("phase artifact model is invalid");
  if (typeof artifact.summary !== "string" || typeof artifact.recommended_next_step !== "string") fail("phase artifact summary fields are invalid");

  if (!Array.isArray(artifact.acceptance_criteria_status) || artifact.acceptance_criteria_status.length === 0) {
    fail("acceptance_criteria_status must be a non-empty array");
  }
  for (const item of artifact.acceptance_criteria_status) {
    exactKeys(item, ["criterion", "status", "evidence"], "acceptance criterion status");
    if (typeof item.criterion !== "string" || !["met", "unmet", "unknown", "not_tested"].includes(item.status)) {
      fail("acceptance criterion status is invalid");
    }
    stringArray(item.evidence, "acceptance criterion evidence");
  }
  if (acceptanceCriteria && JSON.stringify(artifact.acceptance_criteria_status.map((item) => item.criterion)) !== JSON.stringify(acceptanceCriteria)) {
    fail("acceptance_criteria_status must map every original criterion exactly once in source order");
  }
  if (artifact.phase !== "C" && artifact.status === "passed" && artifact.acceptance_criteria_status.some((item) => item.status !== "met")) {
    fail("passed post-plan artifact must mark every acceptance criterion met");
  }

  stringArray(artifact.changed_files, "changed_files", { unique: true });
  stringArray(artifact.risks, "risks");
  stringArray(artifact.open_questions, "open_questions");
  if (["C", "A", "T"].includes(artifact.phase) && artifact.changed_files.length) fail(`${artifact.phase} must be read-only`);

  if (!Array.isArray(artifact.commands_run)) fail("commands_run must be an array");
  for (const command of artifact.commands_run) {
    exactKeys(command, ["command", "exit_code", "output_artifact"], "command evidence");
    if (typeof command.command !== "string" || !Number.isInteger(command.exit_code) || (command.output_artifact !== null && typeof command.output_artifact !== "string")) {
      fail("command evidence is invalid");
    }
  }

  exactKeys(artifact.cost, ["input_tokens", "output_tokens", "amount", "currency"], "cost");
  if (!Number.isInteger(artifact.cost.input_tokens) || artifact.cost.input_tokens < 0 || !Number.isInteger(artifact.cost.output_tokens) || artifact.cost.output_tokens < 0) {
    fail("cost token counts are invalid");
  }
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

function validatePhaseData(artifact) {
  const data = artifact.phase_data;
  if (!isObject(data)) fail("phase_data must be an object");
  if (artifact.phase === "C") {
    exactKeys(data, ["complexity", "selected_flow", "scope", "non_goals", "test_strategy", "planned_files", "trust_boundaries", "security_triggers", "render_plan"], "C phase_data");
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
      if (!Number.isInteger(data.maintainability[key].score) || data.maintainability[key].score < 0 || data.maintainability[key].score > 4 || typeof data.maintainability[key].rationale !== "string") {
        fail(`A ${key} score or rationale is invalid`);
      }
    }
    validateFindings(data.blocking_findings, "A blocking_findings");
    stringArray(data.non_blocking_observations, "A non_blocking_observations");
    if (artifact.status === "passed" && (!data.criteria_fit.passed || data.blocking_findings.length > 0)) {
      fail("passed A artifact requires criteria fit and no blocking findings");
    }
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
    if (artifact.status === "passed" && data.security_findings.some((finding) => ["critical", "high"].includes(finding.severity))) {
      fail("passed T artifact cannot contain critical or high security findings");
    }
    stringArray(data.security_commands, "T security_commands");
    stringArray(data.residual_risk, "T residual_risk");
  } else if (artifact.phase === "S") {
    exactKeys(data, ["docs_changed", "domain_instructions_changed", "wiki_pages_changed", "durable_learnings"], "S phase_data");
    for (const key of ["docs_changed", "domain_instructions_changed", "wiki_pages_changed", "durable_learnings"]) stringArray(data[key], `S ${key}`);
  }
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
    if (!SEVERITIES.has(finding.severity)) fail(`${label} severity is invalid`);
    if (typeof finding.message !== "string") fail(`${label} message must be a string"`);
    stringArray(finding.evidence, `${label} evidence`);
  }
}

export function validateCheckpoint(checkpoint, { attempt }) {
  exactKeysOptional(checkpoint, ["kind", "status", "reviewed_c_sha256", "reviewed_c_revision", "triggers"], ["findings", "path", "sha256", "recorded_at"], "checkpoint");
  if (!CHECKPOINT_KINDS.has(checkpoint.kind)) fail("checkpoint kind is invalid");
  if (checkpoint.kind === "plan-security") {
    if (!["pass", "needs-replan"].includes(checkpoint.status)) fail("plan-security status is invalid");
    if (!/^[0-9a-f]{64}$/.test(checkpoint.reviewed_c_sha256)) fail("checkpoint reviewed_c_sha256 is invalid");
    if (!Number.isInteger(checkpoint.reviewed_c_revision) || checkpoint.reviewed_c_revision < 1) fail("checkpoint reviewed_c_revision is invalid");
    stringArray(checkpoint.triggers, "checkpoint triggers", { unique: true });
    if (checkpoint.triggers.some((trigger) => !SECURITY_TRIGGERS.has(trigger))) fail("checkpoint triggers contain unknown value");

    const cRecords = phaseRecords(attempt, "C");
    const cRecord = cRecords.at(-1);
    if (!cRecord) fail("plan-security checkpoint requires a recorded C phase");
    if (cRecord.sha256 !== checkpoint.reviewed_c_sha256) fail("checkpoint reviewed_c_sha256 does not match latest C artifact");
    if (cRecords.length !== checkpoint.reviewed_c_revision) fail("checkpoint reviewed_c_revision does not match latest C revision");
    if (JSON.stringify(checkpoint.triggers) !== JSON.stringify(cRecord.triggers || [])) {
      fail("checkpoint triggers do not match latest C artifact");
    }

    if (checkpoint.status === "pass" && Array.isArray(checkpoint.findings) && checkpoint.findings.length > 0) {
      fail("passing plan-security checkpoint cannot contain blocking findings");
    }
    if (checkpoint.status === "needs-replan") {
      if (!Array.isArray(checkpoint.findings) || checkpoint.findings.length === 0) fail("needs-replan plan-security checkpoint must include findings");
      for (const finding of checkpoint.findings) {
        exactKeys(finding, ["severity", "finding", "exploitability", "smallestSafeFix"], "plan-security finding");
        if (!SEVERITIES.has(finding.severity)) fail("plan-security finding severity is invalid");
        if (typeof finding.finding !== "string" || typeof finding.exploitability !== "string" || typeof finding.smallestSafeFix !== "string") {
          fail("plan-security finding fields are invalid");
        }
      }
    }
  }
  return checkpoint;
}

function validateDecisionTarget(target) {
  exactKeys(target, ["type", "name", "revision"], "decision target");
  if (target.type === "phase") {
    if (!PHASES.has(target.name)) fail("decision target phase name is invalid");
  } else if (target.type === "checkpoint") {
    if (!CHECKPOINT_KINDS.has(target.name)) fail("decision target checkpoint name is invalid");
  } else {
    fail("decision target type is invalid");
  }
  if (!Number.isInteger(target.revision) || target.revision < 1) fail("decision target revision is invalid");
  return target;
}

// New decisions bind directly to the attempt and an exact {type,name,revision} target. Legacy
// hash-bound records remain structurally valid as historical evidence but cannot be recorded as
// new decisions.
export function validateDecision(decision, { attempt }) {
  const legacy = decision?.bound_to !== undefined && decision?.attempt_id === undefined;
  if (legacy) {
    exactKeysOptional(decision, ["kind", "bound_to", "outcome", "decided_by", "reason"], ["path", "sha256", "recorded_at"], "human decision");
  } else {
    exactKeysOptional(decision, ["kind", "attempt_id", "target", "outcome", "decided_by", "reason"], ["path", "sha256", "recorded_at"], "human decision");
  }
  if (decision.kind !== "human-decision") fail("decision kind is invalid");
  if (legacy) {
    if (!/^[0-9a-f]{64}$/.test(decision.bound_to)) fail("decision bound_to hash is invalid");
  } else {
    if (typeof decision.attempt_id !== "string" || !decision.attempt_id.trim()) fail("decision attempt_id is invalid");
    if (decision.attempt_id !== attempt.attempt_id) fail("decision attempt_id does not match the attempt");
    validateDecisionTarget(decision.target);
  }
  if (!DECISION_OUTCOMES.has(decision.outcome)) fail("decision outcome is invalid");
  if (typeof decision.decided_by !== "string" || !decision.decided_by.trim()) fail("decision decided_by is invalid");
  if (typeof decision.reason !== "string" || !decision.reason.trim()) fail("decision reason is invalid");

  if (decision.outcome === "defer-and-proceed") {
    const target = resolveDecisionTarget(attempt, decision);
    if (target?.type === "checkpoint") {
      const checkpoint = checkpointRecordByRevision(attempt, target.name, target.revision);
      const hasCriticalHigh = (checkpoint?.findings || []).some((f) => ["critical", "high"].includes(f.severity));
      if (hasCriticalHigh) fail("defer-and-proceed is not allowed for unresolved critical/high plan-security findings");
    } else {
      const record = target ? phaseRecordByRevision(attempt, target.name, target.revision) : null;
      if (!target || target.type !== "phase" || !["A", "T"].includes(target.name) || !record || record.status !== "needs_fix") {
        fail("defer-and-proceed is allowed only for exhausted A or T review findings");
      }
    }
  }

  return decision;
}

export function assertCanRecordPhase(attempt, phase, artifactDigest) {
  const expected = nextAction(attempt);
  if (!expected || expected.complete) fail("attempt has no expected next action");

  const existing = latestPhase(attempt, phase);
  if (existing?.sha256 === artifactDigest) return { replayed: true, revision: phaseRecords(attempt, phase).length };

  if (expected.phase !== phase) fail(`phase order violation: expected ${expected.phase}, got ${phase}`);
  return { replayed: false, revision: phaseRecords(attempt, phase).length + 1 };
}

export function assertCanRecordCheckpoint(attempt, checkpoint) {
  const expected = nextAction(attempt);
  if (!expected || expected.complete) fail("attempt has no expected next action");
  if (expected.checkpoint !== checkpoint.kind) fail(`checkpoint order violation: expected ${expected.checkpoint}, got ${checkpoint.kind}`);
  return true;
}

export function assertCanRecordDecision(attempt, decision) {
  const expected = nextAction(attempt);
  if (!expected || expected.complete || typeof expected.decision !== "object") fail("no human decision is expected for this attempt");
  if (decision?.bound_to !== undefined || typeof decision?.attempt_id !== "string") fail("no human decision is expected for this attempt; new decisions must bind directly to the attempt and target");
  if (decision.attempt_id !== attempt.attempt_id || !sameTarget(decision.target, expected.decision)) {
    fail("no human decision is expected for the supplied target");
  }
  return true;
}

export function assertCanComplete(attempt, status) {
  if (status === "passed") {
    const action = nextAction(attempt);
    if (action?.complete !== true) fail(`cannot pass incomplete attempt; next action is ${JSON.stringify(action)}`);
  }
  return true;
}
