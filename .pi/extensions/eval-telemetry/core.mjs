import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const TELEMETRY_SCHEMA_VERSION = 1;
export const METHODOLOGY = Object.freeze({ id: "local-crafts", version: 1, artifact_contract_version: 1 });
const PHASE_AGENT = Object.freeze({ C: "local-craft-planner", R: "local-craft-builder", A: "local-craft-evaluator", F: "local-craft-builder", T: "local-craft-security", S: "local-craft-sharpener" });
const PHASE_ROLE = Object.freeze({ C: "planning", R: "building", A: "assessing", F: "building", T: "tightening", S: "sharpening" });
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fail(message, code = "telemetry_invalid") { const error = new Error(message); error.code = code; throw error; }
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function safeSegment(value, label) { if (typeof value !== "string" || !SAFE_SEGMENT.test(value)) fail(`${label} is unsafe`, "unsafe_path"); return value; }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function hashValue(domain, value) {
  const bytes = typeof value === "string" ? value : canonical(value);
  return { algorithm: "sha256", domain, digest: crypto.createHash("sha256").update(`${domain}\0${bytes}`).digest("hex"), bytes: Buffer.byteLength(bytes) };
}
function lengthBucket(value) {
  const bytes = Buffer.byteLength(value);
  if (bytes === 0) return 0;
  return 2 ** Math.ceil(Math.log2(Math.max(64, bytes)));
}
function hashSensitive(key, domain, value) {
  return { algorithm: "hmac-sha256", domain, digest: crypto.createHmac("sha256", key).update(`${domain}\0${value}`).digest("hex"), length_bucket: lengthBucket(value) };
}
function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function assertNoSymlinkAncestors(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail("telemetry path escapes repository", "unsafe_path");
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail("symlinked telemetry path is forbidden", "unsafe_path");
  }
}
function ensurePrivateDirectory(root, directory) {
  assertNoSymlinkAncestors(root, directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertNoSymlinkAncestors(root, directory);
  const real = fs.realpathSync(directory);
  if (real !== root && !isWithin(root, real)) fail("telemetry directory escapes repository", "unsafe_path");
  if (!fs.statSync(real).isDirectory()) fail("telemetry path is not a directory", "unsafe_path");
  fs.chmodSync(real, 0o700);
  if ((fs.statSync(real).mode & 0o077) !== 0) fail("telemetry directory permissions are not private", "unsafe_permissions");
  return real;
}
function loadOrCreateHashKey(root, runDirectory) {
  ensurePrivateDirectory(root, runDirectory);
  const keyPath = path.join(runDirectory, ".telemetry-hmac-key");
  assertNoSymlinkAncestors(root, keyPath);
  try {
    const descriptor = fs.openSync(keyPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(descriptor, crypto.randomBytes(32).toString("hex")); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  if (fs.lstatSync(keyPath).isSymbolicLink()) fail("telemetry hash key cannot be a symlink", "unsafe_path");
  const descriptor = fs.openSync(keyPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let key;
  try { key = fs.readFileSync(descriptor, "utf8").trim(); } finally { fs.closeSync(descriptor); }
  if (!/^[a-f0-9]{64}$/.test(key)) fail("telemetry hash key is invalid", "invalid_hash_key");
  return key;
}
function atomicWriteJson(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, filePath);
  const directoryDescriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
}
function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const descriptor = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeSync(descriptor, `${JSON.stringify(value)}\n`); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
function readJson(filePath, code = "invalid_json") {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { fail(`invalid JSON: ${filePath}`, code); }
}
function sanitizeError(error) {
  const code = typeof error?.code === "string" ? error.code : "telemetry_error";
  return { code: code.replace(/[^a-z0-9_.-]/gi, "_").slice(0, 80) || "telemetry_error" };
}

export function resolveAssociation(rootDir, env = process.env) {
  if (env.PI_SUBAGENT_CHILD !== "1") return { associated: false, reason: "not_subagent_child" };
  const agent = env.PI_SUBAGENT_CHILD_AGENT;
  if (typeof agent !== "string" || !agent.startsWith("local-craft-")) return { associated: false, reason: "not_local_craft_child" };
  const root = fs.realpathSync(path.resolve(rootDir));
  const guardPath = path.join(root, ".pi", "goal-runs", "workspace-writer.json");
  if (!fs.existsSync(guardPath)) return { associated: false, reason: "no_active_goal_writer" };
  assertNoSymlinkAncestors(root, guardPath);
  if (fs.lstatSync(guardPath).isSymbolicLink()) fail("workspace guard cannot be a symlink", "unsafe_path");
  const guard = readJson(guardPath, "invalid_workspace_guard");
  const runId = safeSegment(guard.run_id, "run_id");
  const nodeId = safeSegment(guard.node_id, "node_id");
  const attemptId = safeSegment(guard.attempt_id, "attempt_id");
  if (fs.realpathSync(path.resolve(guard.workspace)) !== root) fail("workspace guard does not match current workspace", "association_mismatch");
  const ledgerPath = path.join(root, ".pi", "goal-runs", runId, "ledger.json");
  assertNoSymlinkAncestors(root, ledgerPath);
  const ledger = readJson(ledgerPath, "invalid_goal_ledger");
  const node = ledger.nodes?.[nodeId];
  const attempt = node?.attempts?.find((candidate) => candidate.attempt_id === attemptId);
  if (!attempt || node.status !== "in_progress" || attempt.final_status !== null) fail("workspace guard does not reference an active attempt", "association_mismatch");
  const phase = guard.next_action?.phase;
  if (!phase) fail("workspace guard has no dispatcher-written next phase", "association_mismatch");
  if (PHASE_AGENT[phase] !== agent) fail(`child agent ${agent} does not match phase ${phase}`, "association_mismatch");
  const planPath = path.join(root, ledger.plan_path);
  assertNoSymlinkAncestors(root, planPath);
  if (crypto.createHash("sha256").update(fs.readFileSync(planPath)).digest("hex") !== ledger.frozen_plan_sha) fail("approved plan drift detected", "plan_drift");
  return { associated: true, run_id: runId, node_id: nodeId, attempt_id: attemptId, flow: attempt.flow, phase, role: PHASE_ROLE[phase], agent, ledger_path: path.relative(root, ledgerPath) };
}

function numeric(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }
export function normalizeUsage(usage) {
  if (!isObject(usage)) return null;
  const cost = isObject(usage.cost) ? usage.cost : {};
  return {
    input: numeric(usage.input), output: numeric(usage.output), cache_read: numeric(usage.cacheRead ?? usage.cache_read), cache_write: numeric(usage.cacheWrite ?? usage.cache_write),
    total_tokens: numeric(usage.totalTokens),
    cost: { input: numeric(cost.input), output: numeric(cost.output), cache_read: numeric(cost.cacheRead ?? cost.cache_read), cache_write: numeric(cost.cacheWrite ?? cost.cache_write), total: numeric(cost.total) },
  };
}
function addUsage(total, usage) {
  if (!usage) return total;
  for (const key of ["input", "output", "cache_read", "cache_write", "total_tokens"]) total[key] += usage[key];
  for (const key of ["input", "output", "cache_read", "cache_write", "total"]) total.cost[key] += usage.cost[key];
  return total;
}
function emptyUsage() { return { input: 0, output: 0, cache_read: 0, cache_write: 0, total_tokens: 0, cost: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 } }; }

export function gitSnapshot(rootDir) {
  const run = (args) => execFileSync("git", args, { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
  try {
    const head = run(["rev-parse", "HEAD"]);
    let dirty = false;
    try { execFileSync("git", ["diff", "--quiet"], { cwd: rootDir, stdio: "ignore", timeout: 5000 }); } catch { dirty = true; }
    try { execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: rootDir, stdio: "ignore", timeout: 5000 }); } catch { dirty = true; }
    const untracked = run(["ls-files", "--others", "--exclude-standard"]) !== "";
    return { available: true, head, dirty: dirty || untracked };
  } catch { return { available: false }; }
}
function configuredVersions(rootDir) {
  try {
    const runtime = readJson(path.join(rootDir, ".pi", "runtime-versions.json"));
    return { node_actual: process.version, pi_configured: runtime.piCodingAgent ?? null, graphify_configured: runtime.graphify ?? null, packages_configured: runtime.packages ?? {}, source: ".pi/runtime-versions.json" };
  } catch { return { node_actual: process.version, pi_configured: null, graphify_configured: null, packages_configured: {}, source: null }; }
}
function expectedModel(rootDir, role) {
  try { return readJson(path.join(rootDir, ".pi", "model-routing.bootstrap.json")).roles?.[role]?.primary ?? null; } catch { return null; }
}

export class TelemetryCollector {
  constructor({ rootDir, association, sessionId, sessionFile, model, activeTools = [], now = () => new Date().toISOString() }) {
    this.rootDir = fs.realpathSync(path.resolve(rootDir));
    this.association = association;
    this.now = now;
    this.runDir = path.join(this.rootDir, ".pi", "goal-runs", association.run_id);
    this.hashKey = loadOrCreateHashKey(this.rootDir, this.runDir);
    this.sessionKey = hashValue("agent-pool.telemetry.session.v1", sessionId || crypto.randomUUID()).digest.slice(0, 24);
    this.sessionDir = ensurePrivateDirectory(this.rootDir, path.join(this.runDir, "telemetry", "sessions", this.sessionKey));
    this.eventsPath = path.join(this.sessionDir, "events.jsonl");
    this.manifestPath = path.join(this.sessionDir, "manifest.json");
    this.toolStarts = new Map();
    this.finalized = false;
    this.health = { status: "healthy", errors: [] };
    this.manifest = {
      schema_version: TELEMETRY_SCHEMA_VERSION, status: "active", association,
      session: { key: this.sessionKey, id_hash: hashValue("agent-pool.telemetry.session-id.v1", sessionId || "unknown").digest, file_hash: sessionFile ? hashValue("agent-pool.telemetry.session-file.v1", path.basename(sessionFile)).digest : null },
      launch: { agent: association.agent, phase: association.phase, role: association.role, expected_model: expectedModel(this.rootDir, association.role), initial_model: model ?? null, active_tools: [...new Set(activeTools)].sort() },
      versions: configuredVersions(this.rootDir), git_start: gitSnapshot(this.rootDir), git_end: null,
      started_at: this.now(), completed_at: null, prompt: null, system_prompt: null,
      observed_models: [], usage: emptyUsage(), assistant_messages: 0, turns: 0,
      tools: { calls: 0, errors: 0, by_name: {} }, health: this.health,
    };
    this._event("telemetry.session.started", { phase: association.phase, agent: association.agent });
    this._persist();
  }
  _degrade(error) {
    const sanitized = sanitizeError(error);
    this.health.status = "degraded";
    if (!this.health.errors.some((item) => item.code === sanitized.code) && this.health.errors.length < 10) this.health.errors.push(sanitized);
  }
  _event(type, data = {}) {
    try { appendJsonLine(this.eventsPath, { schema_version: TELEMETRY_SCHEMA_VERSION, type, timestamp: this.now(), ...data }); }
    catch (error) { this._degrade(error); }
  }
  _persist() {
    try { this.manifest.health = this.health; atomicWriteJson(this.manifestPath, this.manifest); }
    catch (error) { this._degrade(error); }
  }
  capturePrompt(prompt, systemPrompt, activeTools = []) {
    try {
      this.manifest.prompt = hashSensitive(this.hashKey, "agent-pool.telemetry.prompt.v1", prompt ?? "");
      this.manifest.system_prompt = hashSensitive(this.hashKey, "agent-pool.telemetry.system-prompt.v1", systemPrompt ?? "");
      this.manifest.launch.active_tools = [...new Set(activeTools)].sort();
      this._event("telemetry.agent.started", { prompt_hash: this.manifest.prompt.digest, system_prompt_hash: this.manifest.system_prompt.digest });
      this._persist();
    } catch (error) { this._degrade(error); }
  }
  captureAssistant(message) {
    try {
      const usage = normalizeUsage(message?.usage);
      const model = typeof message?.provider === "string" && typeof message?.model === "string" ? `${message.provider}/${message.model}` : null;
      if (model && !this.manifest.observed_models.includes(model)) this.manifest.observed_models.push(model);
      addUsage(this.manifest.usage, usage);
      this.manifest.assistant_messages += 1;
      this._event("telemetry.provider.message", { provider: typeof message?.provider === "string" ? message.provider : null, model: typeof message?.model === "string" ? message.model : null, api: typeof message?.api === "string" ? message.api : null, stop_reason: typeof message?.stopReason === "string" ? message.stopReason : null, usage, error: Boolean(message?.errorMessage) });
      this._persist();
    } catch (error) { this._degrade(error); }
  }
  turnStarted() { this.manifest.turns += 1; this._event("telemetry.turn.started", { turn: this.manifest.turns }); }
  toolStarted(toolCallId, toolName) {
    try {
      const call = hashValue("agent-pool.telemetry.tool-call.v1", toolCallId).digest.slice(0, 24);
      this.toolStarts.set(call, Date.now());
      this.manifest.tools.calls += 1;
      this.manifest.tools.by_name[toolName] = (this.manifest.tools.by_name[toolName] ?? 0) + 1;
      this._event("telemetry.tool.started", { call, tool: toolName });
    } catch (error) { this._degrade(error); }
  }
  toolEnded(toolCallId, toolName, isError) {
    try {
      const call = hashValue("agent-pool.telemetry.tool-call.v1", toolCallId).digest.slice(0, 24);
      const started = this.toolStarts.get(call);
      this.toolStarts.delete(call);
      if (isError) this.manifest.tools.errors += 1;
      this._event("telemetry.tool.ended", { call, tool: toolName, error: Boolean(isError), duration_ms: started ? Math.max(0, Date.now() - started) : null });
      this._persist();
    } catch (error) { this._degrade(error); }
  }
  finalize(reason = "settled") {
    if (this.finalized) return;
    this.finalized = true;
    this.manifest.status = "completed";
    this.manifest.completed_at = this.now();
    this.manifest.git_end = gitSnapshot(this.rootDir);
    this._event("telemetry.session.completed", { reason });
    this._persist();
  }
  status() {
    return { associated: true, run_id: this.association.run_id, node_id: this.association.node_id, attempt_id: this.association.attempt_id, phase: this.association.phase, status: this.manifest.status, health: this.health.status, observed_models: [...this.manifest.observed_models], total_tokens: this.manifest.usage.total_tokens, total_cost: this.manifest.usage.cost.total, manifest: path.relative(this.rootDir, this.manifestPath) };
  }
}

function boundedString(value, max = 200) { return typeof value === "string" ? value.slice(0, max) : null; }
function sanitizedGit(value) {
  return isObject(value) && value.available === true && typeof value.head === "string"
    ? { available: true, head: value.head.slice(0, 80), dirty: Boolean(value.dirty) }
    : { available: false };
}
function sanitizedVersions(value) {
  if (!isObject(value)) return null;
  const packages = isObject(value.packages_configured)
    ? Object.fromEntries(Object.entries(value.packages_configured).filter(([key, version]) => SAFE_SEGMENT.test(key) && typeof version === "string").map(([key, version]) => [key, version.slice(0, 80)]))
    : {};
  return { node_actual: boundedString(value.node_actual, 40), pi_configured: boundedString(value.pi_configured, 80), graphify_configured: boundedString(value.graphify_configured, 80), packages_configured: packages, source: value.source === ".pi/runtime-versions.json" ? value.source : null };
}
function collectTelemetryManifests(rootDir, runId, nodeId, attemptId) {
  const sessionsRoot = path.join(rootDir, ".pi", "goal-runs", runId, "telemetry", "sessions");
  if (!fs.existsSync(sessionsRoot)) return [];
  assertNoSymlinkAncestors(rootDir, sessionsRoot);
  if (fs.lstatSync(sessionsRoot).isSymbolicLink()) fail("telemetry sessions root cannot be a symlink", "unsafe_path");
  const realSessionsRoot = fs.realpathSync(sessionsRoot);
  if (!isWithin(rootDir, realSessionsRoot)) fail("telemetry sessions root escapes repository", "unsafe_path");
  const manifests = [];
  for (const sessionKey of fs.readdirSync(realSessionsRoot)) {
    if (!SAFE_SEGMENT.test(sessionKey)) continue;
    const sessionDirectory = path.join(realSessionsRoot, sessionKey);
    if (!fs.lstatSync(sessionDirectory).isDirectory() || fs.lstatSync(sessionDirectory).isSymbolicLink()) continue;
    const manifestPath = path.join(sessionDirectory, "manifest.json");
    if (!fs.existsSync(manifestPath) || fs.lstatSync(manifestPath).isSymbolicLink()) continue;
    try {
      const descriptor = fs.openSync(manifestPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(descriptor, "utf8")); } finally { fs.closeSync(descriptor); }
      if (manifest.association?.node_id !== nodeId || manifest.association?.attempt_id !== attemptId) continue;
      const phase = boundedString(manifest.association?.phase, 1);
      const agent = boundedString(manifest.association?.agent, 80);
      if (!PHASE_AGENT[phase] || agent !== PHASE_AGENT[phase]) continue;
      const observedModels = Array.isArray(manifest.observed_models) ? manifest.observed_models.filter((model) => typeof model === "string" && /^[^/\s]+\/[^\s]+$/.test(model)).map((model) => model.slice(0, 160)).slice(0, 10) : [];
      const byName = isObject(manifest.tools?.by_name)
        ? Object.fromEntries(Object.entries(manifest.tools.by_name).filter(([name, count]) => SAFE_SEGMENT.test(name) && typeof count === "number").map(([name, count]) => [name, numeric(count)]))
        : {};
      manifests.push({ path: path.relative(rootDir, manifestPath), phase, agent, status: manifest.status === "completed" ? "completed" : "partial", health: manifest.health?.status === "healthy" ? "healthy" : "degraded", expected_model: boundedString(manifest.launch?.expected_model, 160), observed_models: observedModels, usage: normalizeUsage(manifest.usage), tools: { calls: numeric(manifest.tools?.calls), errors: numeric(manifest.tools?.errors), by_name: byName }, versions: sanitizedVersions(manifest.versions), git_start: sanitizedGit(manifest.git_start), git_end: sanitizedGit(manifest.git_end) });
    } catch {}
  }
  return manifests.sort((a, b) => `${a.phase}:${a.path}`.localeCompare(`${b.phase}:${b.path}`));
}
function safeArtifactReference(value) {
  if (typeof value !== "string" || !value) return null;
  const normalized = path.normalize(value);
  if (path.isAbsolute(value) || normalized === ".." || normalized.startsWith(`..${path.sep}`)) return { external_ref_hash: hashValue("agent-pool.eval.external-ref.v1", value).digest };
  return normalized.split(path.sep).join("/");
}
function resolveLedgerArtifact(ledgerDir, relativePath) {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${path.sep}`)) fail("ledger artifact path is unsafe", "unsafe_artifact_path");
  const base = fs.realpathSync(ledgerDir);
  const absolute = path.resolve(base, relativePath);
  if (!isWithin(base, absolute)) fail("ledger artifact escapes run directory", "unsafe_artifact_path");
  assertNoSymlinkAncestors(base, absolute);
  if (!fs.existsSync(absolute) || fs.lstatSync(absolute).isSymbolicLink()) fail("ledger artifact is missing or symlinked", "unsafe_artifact_path");
  const real = fs.realpathSync(absolute);
  if (!isWithin(base, real)) fail("ledger artifact resolves outside run directory", "unsafe_artifact_path");
  return { absolute: real, relative: path.relative(base, real).split(path.sep).join("/") };
}
function testEvidenceFromArtifact(ledgerDir, record) {
  if (!record?.path) return null;
  try {
    const resolved = resolveLedgerArtifact(ledgerDir, record.path);
    const descriptor = fs.openSync(resolved.absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let artifact;
    try { artifact = JSON.parse(fs.readFileSync(descriptor, "utf8")); } finally { fs.closeSync(descriptor); }
    const pick = (value) => value ? { commit_sha: value.commit_sha, suite_path: safeArtifactReference(value.suite_path), suite_hash: value.suite_hash, command_hash: typeof value.command === "string" ? hashValue("agent-pool.eval.command.v1", value.command).digest : null, exit_code: value.exit_code, image_digest: value.image_digest, output_artifact: safeArtifactReference(value.output_artifact) } : null;
    if (artifact.phase === "R") return { red: pick(artifact.phase_data?.red_evidence), green: pick(artifact.phase_data?.green_evidence) };
    if (artifact.phase === "F") return { green: pick(artifact.phase_data?.green_evidence) };
  } catch {}
  return null;
}

export function emitEvalCandidate({ rootDir, runId, plan, ledger, nodeId, attemptId }) {
  safeSegment(runId, "run_id"); safeSegment(nodeId, "node_id"); safeSegment(attemptId, "attempt_id");
  const root = fs.realpathSync(path.resolve(rootDir));
  const nodeContract = plan.nodes.find((node) => node.id === nodeId);
  const attempt = ledger.nodes?.[nodeId]?.attempts?.find((candidate) => candidate.attempt_id === attemptId);
  if (!nodeContract || !attempt) fail("candidate source node or attempt missing", "candidate_source_missing");
  const ledgerDir = path.join(root, ".pi", "goal-runs", runId);
  assertNoSymlinkAncestors(root, ledgerDir);
  const realLedgerDir = fs.realpathSync(ledgerDir);
  if (!isWithin(root, realLedgerDir)) fail("goal run directory escapes repository", "unsafe_path");
  const telemetry = collectTelemetryManifests(root, runId, nodeId, attemptId);
  const phases = {};
  for (const [phase, record] of Object.entries(attempt.phases ?? {})) {
    if (!Object.hasOwn(PHASE_AGENT, phase) || !isObject(record)) continue;
    let artifactPath = null;
    try { artifactPath = resolveLedgerArtifact(realLedgerDir, record.path).relative; } catch {}
    phases[phase] = { status: ["passed", "needs_fix", "failed", "blocked"].includes(record.status) ? record.status : "invalid", artifact_path: artifactPath, artifact_sha256: typeof record.sha256 === "string" && /^[a-f0-9]{64}$/.test(record.sha256) ? record.sha256 : null, test_evidence: artifactPath ? testEvidenceFromArtifact(realLedgerDir, { path: artifactPath }) : null };
  }
  const reasons = ["local_crafts_wrapped", "not_n3_replayed", "preexisting_tests_not_verified"];
  for (const [phase, record] of Object.entries(phases)) if (!record.artifact_path || !record.artifact_sha256) reasons.push(`invalid_${phase.toLowerCase()}_artifact_reference`);
  const requiredPhases = attempt.flow === "R-S" ? ["R", "S"] : ["C", "R", "A", "T", "S"];
  for (const phase of requiredPhases) if (!telemetry.some((item) => item.phase === phase && item.status === "completed")) reasons.push(`missing_${phase.toLowerCase()}_telemetry`);
  if (!telemetry.some((item) => (item.usage?.total_tokens ?? 0) > 0)) reasons.push("missing_actual_usage");
  const finalGit = gitSnapshot(root);
  if (!finalGit.available || finalGit.dirty) reasons.push("uncommitted_worktree");
  const candidate = {
    schema_version: 1, kind: "local-build-eval-candidate", source: "local-repository-build", eligibility: "telemetry-only", formal_eval_eligible: false,
    eligibility_reasons: [...new Set(reasons)].sort(), methodology: METHODOLOGY,
    run_id: runId, node_id: nodeId, attempt_id: attemptId, flow: attempt.flow === "R-S" ? "R-S" : "C-R-A-F-T-S", final_status: ["passed", "failed", "escalated"].includes(attempt.final_status) ? attempt.final_status : "invalid",
    node_contract_sha256: hashValue("agent-pool.eval.node-contract.v1", nodeContract).digest,
    base_git: sanitizedGit(attempt.base_git), final_git: sanitizedGit(finalGit), phases, telemetry,
    created_at: new Date().toISOString(),
  };
  const outputDirectory = ensurePrivateDirectory(root, path.join(realLedgerDir, "eval-candidates", nodeId));
  const outputPath = path.join(outputDirectory, `${attemptId}.json`);
  assertNoSymlinkAncestors(root, outputPath);
  atomicWriteJson(outputPath, candidate);
  return { status: "written", path: path.relative(root, outputPath), eligibility: candidate.eligibility, reasons: candidate.eligibility_reasons };
}

export function telemetryStatus(rootDir, env = process.env) {
  try {
    const association = resolveAssociation(rootDir, env);
    if (!association.associated) return association;
    const root = fs.realpathSync(path.resolve(rootDir));
    const manifests = collectTelemetryManifests(root, association.run_id, association.node_id, association.attempt_id);
    return { associated: true, run_id: association.run_id, node_id: association.node_id, attempt_id: association.attempt_id, next_phase: association.phase, manifests: manifests.map((item) => ({ phase: item.phase, status: item.status, health: item.health, path: item.path })) };
  } catch (error) { return { associated: false, reason: sanitizeError(error).code }; }
}
