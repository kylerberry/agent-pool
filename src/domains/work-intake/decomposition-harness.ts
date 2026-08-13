/**
 * Work Intake — deterministic decomposition invocation harness.
 *
 * Validates/sanitizes/retrieves/routes/invokes/validates and at most one repair.
 * No controller, queue, persistence, Gate 1, dispatch, or Pool Worker harness
 * dependency. Model-facing surface is read-only.
 */

import type {
  DecompositionJob,
  DecompositionCandidate,
  DecompositionFailure,
  DecompositionInvocationRecord,
  BreadthRetriever,
  DecompositionModelInvoker,
  PiExecutableIdentity,
} from "./decomposition-contracts.ts";
import {
  isDecompositionCandidate,
  isDecompositionFailure,
} from "./decomposition-contracts.ts";
import type { DecompositionLimits } from "./decomposition-limits.ts";
import { validateLimitPolicy, byteLength, loadLimitPolicyFromSource } from "./decomposition-limits.ts";
import {
  sanitizePromptBoundValue,
  sanitizeStringArray,
  sanitizeOptionalString,
  projectProviderError,
  projectRetrievalError,
  loadSanitizationPolicyFromSource,
} from "./decomposition-sanitization.ts";
import {
  loadOrchestratorBootstrapPolicyFromSource,
} from "../model-routing-and-evaluation/bootstrap-policy.ts";
import {
  validateAvailability,
  selectForRole,
  isRoutingFailure,
} from "../model-routing-and-evaluation/model-router.ts";
import type { RoutingPolicy } from "../model-routing-and-evaluation/routing-policy.ts";
import type { IndexRevision, BreadthResult } from "../codebase-knowledge/contracts.ts";
import { assertIndexRevision, cacheKey } from "../codebase-knowledge/contracts.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SOURCE_DIR, "..", "..", "..");
const ORCHESTRATOR_PACKAGE_ROOT = join(REPO_ROOT, "packages/orchestrator-harness");

interface RunDecompositionOptions {
  readonly job: DecompositionJob;
  readonly availability: readonly { readonly fullId: string; readonly provider?: string; readonly model?: string }[];
  readonly breadthRetriever: BreadthRetriever;
  readonly modelInvoker: DecompositionModelInvoker;
  readonly piExecutable?: PiExecutableIdentity;
  readonly explicitModelId?: string;
  readonly deadlineMs?: number;
  readonly onRecord?: (record: DecompositionInvocationRecord) => void;
  readonly policy?: RoutingPolicy;
  readonly limits?: DecompositionLimits;
}

function deepFreeze<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function deepCopy<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => deepCopy(item)) as unknown as T;
  }
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    copy[key] = deepCopy((value as Record<string, unknown>)[key]);
  }
  return copy as T;
}

const ALLOWED_JOB_FIELDS = new Set([
  "jobId",
  "spec",
  "rawSpec",
  "targetRepository",
  "head",
  "indexRevision",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyOwnFields(value: unknown, allowed: ReadonlySet<string>): value is Record<string, unknown> {
  return isPlainObject(value) && Object.keys(value).every((key) => allowed.has(key));
}

function boundedJobId(jobId: unknown): string {
  return typeof jobId === "string" && byteLength(jobId) <= 256 ? jobId : "unknown";
}

function reject(code: string, reason: string, jobId: unknown): DecompositionFailure {
  // Invalid inputs must never reflect attacker-controlled field names or ids.
  return Object.freeze({ code, reason: reason.slice(0, 256), jobId: boundedJobId(jobId) });
}

function validateJob(job: DecompositionJob, limits: DecompositionLimits): { readonly indexRevision: IndexRevision } | DecompositionFailure {
  if (!hasOnlyOwnFields(job, ALLOWED_JOB_FIELDS)) {
    return reject("INVALID_JOB", "Job must be a plain object with only known fields", "unknown");
  }
  if (!Object.hasOwn(job, "jobId") || typeof job.jobId !== "string" || job.jobId === "") {
    return reject("INVALID_JOB", "jobId is required", "unknown");
  }
  if ((!Object.hasOwn(job, "rawSpec") && "rawSpec" in job) || (Object.hasOwn(job, "rawSpec") && job.rawSpec !== undefined && typeof job.rawSpec !== "string")) {
    return reject("INVALID_JOB", "rawSpec must be an own string field when present", job.jobId);
  }
  if (!Object.hasOwn(job, "spec") || !hasOnlyOwnFields(job.spec, new Set(["intent", "acceptanceCriteria", "constraints"]))) {
    return reject("INVALID_JOB", "spec must be a plain object with only known fields", job.jobId);
  }
  if (!Object.hasOwn(job.spec, "intent") || typeof job.spec.intent !== "string" || job.spec.intent === "") {
    return reject("INVALID_JOB", "spec.intent is required", job.jobId);
  }
  if (!Object.hasOwn(job.spec, "acceptanceCriteria") || !Array.isArray(job.spec.acceptanceCriteria) || job.spec.acceptanceCriteria.length === 0) {
    return reject("INVALID_JOB", "spec.acceptanceCriteria must be a non-empty array", job.jobId);
  }
  for (const criterion of job.spec.acceptanceCriteria) {
    if (typeof criterion !== "string" || criterion.length === 0) {
      return reject("INVALID_JOB", "spec.acceptanceCriteria entries must be non-empty strings", job.jobId);
    }
  }
  if ((!Object.hasOwn(job.spec, "constraints") && "constraints" in job.spec) || (Object.hasOwn(job.spec, "constraints") && job.spec.constraints !== undefined)) {
    if (!Array.isArray(job.spec.constraints)) {
      return reject("INVALID_JOB", "spec.constraints must be an array", job.jobId);
    }
    for (const constraint of job.spec.constraints) {
      if (typeof constraint !== "string" || constraint.length === 0) {
        return reject("INVALID_JOB", "spec.constraints entries must be non-empty strings", job.jobId);
      }
    }
  }
  const targetRepositoryFields = new Set(["owner", "name"]);
  if (!Object.hasOwn(job, "targetRepository") || !hasOnlyOwnFields(job.targetRepository, targetRepositoryFields) || !Object.hasOwn(job.targetRepository, "owner") || typeof job.targetRepository.owner !== "string" || job.targetRepository.owner.length === 0 || !Object.hasOwn(job.targetRepository, "name") || typeof job.targetRepository.name !== "string" || job.targetRepository.name.length === 0) {
    return reject("INVALID_JOB", "targetRepository owner/name are required", job.jobId);
  }
  if (!Object.hasOwn(job, "head") || typeof job.head !== "string" || !/^[0-9a-f]{40}$/.test(job.head)) {
    return reject("INVALID_JOB", "head must be a 40-character hex SHA", job.jobId);
  }
  const indexRevisionFields = new Set(["repository", "head", "graphifyVersion", "indexSchemaVersion", "sensitivePathPolicyVersion", "manifestDigest", "indexRevision", "createdAt"]);
  const repositoryFields = new Set(["owner", "name"]);
  if (!Object.hasOwn(job, "indexRevision") || !hasOnlyOwnFields(job.indexRevision, indexRevisionFields) || !hasOnlyOwnFields(job.indexRevision.repository, repositoryFields) || !Object.hasOwn(job.indexRevision.repository, "owner") || !Object.hasOwn(job.indexRevision.repository, "name")) {
    return reject("INVALID_JOB", "indexRevision must be a plain object with only known fields", job.jobId);
  }
  let validatedRevision: IndexRevision;
  try {
    validatedRevision = assertIndexRevision(job.indexRevision);
  } catch (error) {
    return reject("INVALID_JOB", error instanceof Error ? error.message : "indexRevision is invalid", job.jobId);
  }
  if (job.head !== validatedRevision.head) {
    return reject("INDEX_REVISION_MISMATCH", "job head does not match index revision head", job.jobId);
  }
  if (job.targetRepository.owner !== validatedRevision.repository.owner || job.targetRepository.name !== validatedRevision.repository.name) {
    return reject("INDEX_REVISION_MISMATCH", "job repository does not match index revision repository", job.jobId);
  }

  // Serialize only the validated primitive projection, never the untrusted
  // object graph (which may be cyclic despite otherwise plausible fields).
  const serialized = JSON.stringify({
    jobId: job.jobId,
    spec: {
      intent: job.spec.intent,
      acceptanceCriteria: job.spec.acceptanceCriteria,
      ...(job.spec.constraints === undefined ? {} : { constraints: job.spec.constraints }),
    },
    ...(job.rawSpec === undefined ? {} : { rawSpec: job.rawSpec }),
    targetRepository: job.targetRepository,
    head: job.head,
    indexRevision: validatedRevision,
  });
  if (byteLength(serialized) > limits.maxSerializedJobBytes) {
    return reject("JOB_SIZE_EXCEEDED", "Serialized job exceeds limit", job.jobId);
  }
  if (job.rawSpec !== undefined && byteLength(job.rawSpec) > limits.maxRawSpecBytes) {
    return reject("RAW_SPEC_LIMIT_EXCEEDED", "rawSpec exceeds limit", job.jobId);
  }
  return { indexRevision: validatedRevision };
}

function sanitizeJob(job: DecompositionJob, validatedIndexRevision: IndexRevision): DecompositionJob {
  return deepFreeze({
    jobId: job.jobId,
    spec: {
      intent: sanitizePromptBoundValue(job.spec.intent),
      acceptanceCriteria: sanitizeStringArray(job.spec.acceptanceCriteria),
      constraints: job.spec.constraints ? sanitizeStringArray(job.spec.constraints) : undefined,
    },
    rawSpec: sanitizeOptionalString(job.rawSpec),
    targetRepository: { ...job.targetRepository },
    head: job.head,
    indexRevision: deepCopy(validatedIndexRevision),
  });
}

function validateNodeIdLength(id: string, limits: DecompositionLimits): boolean {
  return id.length > 0 && id.length <= limits.maxNodeIdLength;
}

function validateNodeStringLength(value: string, limits: DecompositionLimits): boolean {
  return byteLength(value) <= limits.maxNodeStringLength;
}

function validateNodeCollectionLength(values: readonly unknown[], limits: DecompositionLimits): boolean {
  return values.length <= limits.maxNodeCollectionLength;
}

function validateCandidate(candidate: unknown, limits: DecompositionLimits): { reason: string; code: string } | null {
  if (!isPlainObject(candidate)) return { reason: "candidate must be an object", code: "INVALID_OUTPUT" };
  const unknownTop = Object.keys(candidate).filter((k) => k !== "nodes");
  if (unknownTop.length > 0) return { reason: `unknown top-level fields: ${unknownTop.join(", ")}`, code: "INVALID_OUTPUT" };
  if (!Array.isArray(candidate.nodes)) return { reason: "nodes must be an array", code: "INVALID_OUTPUT" };
  if (candidate.nodes.length > limits.maxNodes) return { reason: `node count ${candidate.nodes.length} exceeds limit ${limits.maxNodes}`, code: "NODE_COUNT_EXCEEDED" };

  const nodeFields = new Set(["id", "intent", "change_spec", "acceptance_criteria", "depends_on"]);

  for (const node of candidate.nodes) {
    if (!isPlainObject(node)) return { reason: "each node must be an object", code: "INVALID_OUTPUT" };
    const unknownNodeFields = Object.keys(node).filter((k) => !nodeFields.has(k));
    if (unknownNodeFields.length > 0) return { reason: `unknown node fields: ${unknownNodeFields.join(", ")}`, code: "INVALID_OUTPUT" };
    if (typeof node.id !== "string" || node.id.length === 0 || !validateNodeIdLength(node.id, limits)) {
      return { reason: `node id must be a non-empty string <= ${limits.maxNodeIdLength} chars`, code: "INVALID_OUTPUT" };
    }
    if (typeof node.intent !== "string" || node.intent.length === 0 || !validateNodeStringLength(node.intent, limits)) {
      return { reason: `node intent must be a non-empty string <= ${limits.maxNodeStringLength} bytes`, code: "INVALID_OUTPUT" };
    }
    if (typeof node.change_spec !== "string" || node.change_spec.length === 0 || !validateNodeStringLength(node.change_spec, limits)) {
      return { reason: `node change_spec must be a non-empty string <= ${limits.maxNodeStringLength} bytes`, code: "INVALID_OUTPUT" };
    }
    if (!Array.isArray(node.acceptance_criteria) || node.acceptance_criteria.length === 0 || !validateNodeCollectionLength(node.acceptance_criteria, limits)) {
      return { reason: `node acceptance_criteria must be a non-empty array <= ${limits.maxNodeCollectionLength}`, code: "INVALID_OUTPUT" };
    }
    for (const criterion of node.acceptance_criteria) {
      if (typeof criterion !== "string" || criterion.length === 0 || !validateNodeStringLength(criterion, limits)) {
        return { reason: `acceptance criterion must be a non-empty string <= ${limits.maxNodeStringLength} bytes`, code: "INVALID_OUTPUT" };
      }
    }
    if (!Array.isArray(node.depends_on) || !validateNodeCollectionLength(node.depends_on, limits)) {
      return { reason: `node depends_on must be an array <= ${limits.maxNodeCollectionLength}`, code: "INVALID_OUTPUT" };
    }
    for (const dep of node.depends_on) {
      if (typeof dep !== "string" || dep.length === 0) return { reason: "depends_on entries must be non-empty strings", code: "INVALID_OUTPUT" };
    }
  }
  return null;
}

function buildPrompt(
  sanitizedJob: DecompositionJob,
  breadth: BreadthResult,
  repairDiagnostics?: readonly string[],
): string {
  const sections: string[] = [];
  sections.push("Decompose the following spec into a flat list of nodes.");
  sections.push("");
  sections.push("INTENT:");
  sections.push(sanitizedJob.spec.intent);
  sections.push("");
  sections.push("ACCEPTANCE CRITERIA:");
  for (const criterion of sanitizedJob.spec.acceptanceCriteria) {
    sections.push(`- ${criterion}`);
  }
  if (sanitizedJob.spec.constraints && sanitizedJob.spec.constraints.length > 0) {
    sections.push("");
    sections.push("CONSTRAINTS:");
    for (const constraint of sanitizedJob.spec.constraints) {
      sections.push(`- ${constraint}`);
    }
  }
  if (sanitizedJob.rawSpec) {
    sections.push("");
    sections.push("RAW SPEC:");
    sections.push(sanitizedJob.rawSpec);
  }
  sections.push("");
  sections.push("CODEBASE CONTEXT:");
  sections.push(`repository: ${sanitizePromptBoundValue(sanitizedJob.targetRepository.owner)}/${sanitizePromptBoundValue(sanitizedJob.targetRepository.name)}`);
  sections.push(`head: ${sanitizedJob.head}`);
  sections.push(`graph units: ${breadth.units.length}${breadth.truncated ? " (truncated)" : ""}`);
  for (const unit of breadth.units) {
    sections.push(`- ${sanitizePromptBoundValue(unit.id)} (${sanitizePromptBoundValue(unit.kind)}) ${sanitizePromptBoundValue(unit.label)} @ ${sanitizePromptBoundValue(unit.sourcePath)}`);
  }
  for (const edge of breadth.edges) {
    sections.push(`- edge: ${sanitizePromptBoundValue(edge.source)} ${sanitizePromptBoundValue(edge.relation)} ${sanitizePromptBoundValue(edge.target)}`);
  }
  if (breadth.truncationReason) {
    sections.push(`truncation reason: ${sanitizePromptBoundValue(breadth.truncationReason)}`);
  }
  if (repairDiagnostics && repairDiagnostics.length > 0) {
    sections.push("");
    sections.push("REPAIR INSTRUCTIONS: fix the following structural issues and return only the corrected JSON:");
    for (const diagnostic of repairDiagnostics) {
      sections.push(`- ${diagnostic}`);
    }
  }
  sections.push("");
  sections.push("Return a JSON object with a single 'nodes' array. Each node must have exactly id, intent, change_spec, acceptance_criteria, and depends_on.");

  return sections.join("\n");
}

function packageIdentity(): { name: string; version: string; path: string } {
  const pkg = JSON.parse(readFileSync(join(ORCHESTRATOR_PACKAGE_ROOT, "package.json"), "utf8")) as Record<string, unknown>;
  return {
    name: String(pkg.name ?? "agent-pool-orchestrator-harness"),
    version: String(pkg.version ?? "0.1.0"),
    path: ORCHESTRATOR_PACKAGE_ROOT,
  };
}

function launcherIdentity(piExecutable?: PiExecutableIdentity): { path: string; version: string; digest: string } {
  if (piExecutable) {
    return piExecutable;
  }
  const runtime = JSON.parse(readFileSync(join(ORCHESTRATOR_PACKAGE_ROOT, "config/runtime-versions.json"), "utf8")) as Record<string, unknown>;
  return {
    path: join(ORCHESTRATOR_PACKAGE_ROOT, "scripts/launch.mjs"),
    version: String(runtime.piCodingAgent ?? "0.81.1"),
    digest: String(runtime.launcherDigest ?? "sha256:launcher"),
  };
}

async function withDeadline<T>(operation: (signal: AbortSignal, remainingMs: number) => Promise<T>, remainingMs: number): Promise<T> {
  if (remainingMs <= 0) {
    throw new Error("TIMEOUT");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error("TIMEOUT"));
    }, remainingMs);
  });
  const guardedOperation = async () => {
    try {
      return await operation(controller.signal, remainingMs);
    } catch (error) {
      if (timedOut) {
        // Swallow abort-triggered errors; the timeoutPromise will reject.
        return new Promise<never>(() => {});
      }
      throw error;
    }
  };
  try {
    const result = await Promise.race([guardedOperation(), timeoutPromise]);
    clearTimeout(timer);
    return result;
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

async function retrieveWithDeadline(
  retriever: BreadthRetriever,
  revision: IndexRevision,
  limits: { readonly maxUnits: number; readonly maxEdges: number },
  remainingMs: number,
): Promise<BreadthResult> {
  try {
    return await withDeadline((signal) => retriever.retrieve(revision, limits, signal), remainingMs);
  } catch (error) {
    if (error instanceof Error && error.message === "TIMEOUT") {
      throw new Error("BREADTH_RETRIEVAL_TIMEOUT");
    }
    throw new Error("BREADTH_RETRIEVAL_FAILED");
  }
}

async function invokeWithDeadline(
  invoker: DecompositionModelInvoker,
  prompt: string,
  model: string,
  maxOutputTokens: number,
  remainingMs: number,
): Promise<{ ok: true; text: string } | { ok: false; code: string; reason: string }> {
  try {
    const text = await withDeadline(
      (signal, deadlineMs) => invoker.invoke({ prompt, model, deadlineMs, maxOutputTokens }, signal),
      remainingMs,
    );
    return { ok: true, text };
  } catch (error) {
    if (error instanceof Error && error.message === "TIMEOUT") {
      return { ok: false, code: "TIMEOUT", reason: "Invocation deadline exceeded" };
    }
    const projected = projectProviderError(error);
    return { ok: false, code: projected.code, reason: projected.reason };
  }
}

export async function runDecomposition(
  options: RunDecompositionOptions,
): Promise<DecompositionCandidate | DecompositionFailure> {
  const limits = options.limits ?? validateLimitPolicy(loadLimitPolicyFromSource());
  const policy = options.policy ?? loadOrchestratorBootstrapPolicyFromSource();
  const sanitizerPolicy = loadSanitizationPolicyFromSource();

  const validated = validateJob(options.job, limits);
  if (isDecompositionFailure(validated)) return validated;
  const validatedIndexRevision = validated.indexRevision;

  const availability = validateAvailability(options.availability);
  if (isRoutingFailure(availability)) {
    return reject(availability.code, availability.reason, options.job.jobId);
  }

  const decision = selectForRole(policy, "decomposition", availability, options.explicitModelId);
  if (isRoutingFailure(decision)) {
    return reject(decision.code, decision.reason, options.job.jobId);
  }

  const sanitizedJob = sanitizeJob(options.job, validatedIndexRevision);

  const deadlineMs = options.deadlineMs ?? limits.deadlineMs;
  const deadlineAt = Date.now() + deadlineMs;

  let breadth: BreadthResult;
  try {
    breadth = await retrieveWithDeadline(
      options.breadthRetriever,
      sanitizedJob.indexRevision,
      { maxUnits: limits.maxBreadthUnits, maxEdges: limits.maxBreadthEdges },
      deadlineAt - Date.now(),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "BREADTH_RETRIEVAL_TIMEOUT") {
      return reject("BREADTH_RETRIEVAL_TIMEOUT", "Breadth retrieval deadline exceeded", sanitizedJob.jobId);
    }
    const projected = projectRetrievalError(error);
    return reject(projected.code, projected.reason, sanitizedJob.jobId);
  }

  if (breadth.units.length > limits.maxBreadthUnits || breadth.edges.length > limits.maxBreadthEdges) {
    return reject("BREADTH_LIMIT_EXCEEDED", "Breadth result exceeds configured limits", sanitizedJob.jobId);
  }

  let validatedBreadthRevision: IndexRevision;
  try {
    validatedBreadthRevision = assertIndexRevision(breadth.revision);
  } catch (error) {
    return reject("BREADTH_REVISION_INVALID", error instanceof Error ? error.message : "breadth revision is invalid", sanitizedJob.jobId);
  }
  if (cacheKey(validatedBreadthRevision) !== cacheKey(sanitizedJob.indexRevision)) {
    return reject("BREADTH_REVISION_MISMATCH", "breadth revision does not match the requested index revision", sanitizedJob.jobId);
  }

  const prompt = buildPrompt(sanitizedJob, breadth);
  if (byteLength(prompt) > limits.maxPromptBytes) {
    return reject("PROMPT_LIMIT_EXCEEDED", "Prompt exceeds byte limit", sanitizedJob.jobId);
  }

  const pkg = packageIdentity();
  const launcher = launcherIdentity(options.piExecutable);

  const baseRecord: DecompositionInvocationRecord = deepFreeze({
    jobId: sanitizedJob.jobId,
    initialPrompt: prompt,
    selectedModel: decision.selectedModel,
    routing: decision.toJSON() as DecompositionInvocationRecord["routing"],
    breadthTool: {
      name: "breadthRetrieval",
      version: validatedBreadthRevision.graphifyVersion,
      limits: { maxUnits: limits.maxBreadthUnits, maxEdges: limits.maxBreadthEdges },
    },
    package: pkg,
    launcher,
    piExecutable: options.piExecutable ?? { path: launcher.path, version: launcher.version, digest: launcher.digest },
    limitPolicy: { version: limits.version, limits: deepCopy(limits) },
    sanitizerPolicy: { version: sanitizerPolicy.version },
    indexRevision: deepCopy(validatedBreadthRevision),
  });

  const emitRecord = (record: DecompositionInvocationRecord) => {
    if (options.onRecord) options.onRecord(record);
  };

  const initialResult = await invokeWithDeadline(
    options.modelInvoker,
    prompt,
    decision.selectedModel,
    limits.maxOutputTokens,
    deadlineAt - Date.now(),
  );
  if (!initialResult.ok) {
    emitRecord(baseRecord);
    return reject(initialResult.code, initialResult.reason, sanitizedJob.jobId);
  }
  if (byteLength(initialResult.text) > limits.maxResponseBytes) {
    emitRecord(baseRecord);
    return reject("RESPONSE_LIMIT_EXCEEDED", "Response exceeds byte limit", sanitizedJob.jobId);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(initialResult.text);
  } catch {
    parsed = null;
  }

  let diagnostics: string[] = [];
  if (parsed !== null) {
    const validationError = validateCandidate(parsed, limits);
    if (validationError === null) {
      emitRecord(baseRecord);
      return deepFreeze({ nodes: (parsed as DecompositionCandidate).nodes });
    }
    // Limit violations (e.g., node count) are rejected before repair.
    if (validationError.code !== "INVALID_OUTPUT") {
      emitRecord(baseRecord);
      return reject(validationError.code, validationError.reason, sanitizedJob.jobId);
    }
    diagnostics.push(validationError.reason);
  } else {
    diagnostics.push("response is not valid JSON");
  }

  // The initial model call was attempted; preserve its provenance before repair.
  emitRecord(baseRecord);

  // At most one repair call.
  const cappedDiagnostics = diagnostics.slice(0, limits.maxDiagnostics).map((d) => sanitizePromptBoundValue(d));
  const repairPrompt = buildPrompt(sanitizedJob, breadth, cappedDiagnostics);
  if (byteLength(repairPrompt) > limits.maxPromptBytes) {
    emitRecord(baseRecord);
    return reject("PROMPT_LIMIT_EXCEEDED", "Repair prompt exceeds byte limit", sanitizedJob.jobId);
  }
  if (byteLength(JSON.stringify(cappedDiagnostics)) > limits.maxRepairContextBytes) {
    emitRecord(baseRecord);
    return reject("REPAIR_CONTEXT_EXCEEDED", "Repair diagnostics exceed byte limit", sanitizedJob.jobId);
  }

  const repairRecord: DecompositionInvocationRecord = deepFreeze({
    ...baseRecord,
    repairPrompt,
  });

  const repairResult = await invokeWithDeadline(
    options.modelInvoker,
    repairPrompt,
    decision.selectedModel,
    limits.maxOutputTokens,
    deadlineAt - Date.now(),
  );
  if (!repairResult.ok) {
    emitRecord(repairRecord);
    return reject(repairResult.code, repairResult.reason, sanitizedJob.jobId);
  }
  if (byteLength(repairResult.text) > limits.maxResponseBytes) {
    emitRecord(repairRecord);
    return reject("RESPONSE_LIMIT_EXCEEDED", "Repair response exceeds byte limit", sanitizedJob.jobId);
  }

  let repairedParsed: unknown;
  try {
    repairedParsed = JSON.parse(repairResult.text);
  } catch {
    emitRecord(repairRecord);
    return reject("INVALID_OUTPUT", "Repair response is not valid JSON", sanitizedJob.jobId);
  }

  const repairValidationError = validateCandidate(repairedParsed, limits);
  if (repairValidationError !== null) {
    emitRecord(repairRecord);
    return reject(repairValidationError.code, repairValidationError.reason, sanitizedJob.jobId);
  }

  emitRecord(repairRecord);
  return deepFreeze({ nodes: (repairedParsed as DecompositionCandidate).nodes });
}
