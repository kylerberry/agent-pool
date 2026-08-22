/**
 * Strict validator for reviewed task manifests.
 *
 * The combined TaskManifest is untrusted at this boundary. Every structural
 * bound must pass before clone, sandbox, or model work. The validator executes
 * no git or docker process; the only filesystem access is resolving
 * `target_repo_path`.
 */

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isApprovedModelId, type ApprovedModelId } from '../domains/model-routing-and-evaluation/approved-models.ts';

export type TaskManifestAcceptanceCriterion = {
  readonly id: string;
  readonly text: string;
};

export type TaskManifest = {
  readonly schema_version: 1;
  readonly task_id: string;
  readonly target_repo_path: string;
  readonly base_commit: string;
  readonly intent: string;
  readonly change_spec: string;
  readonly acceptance_criteria: readonly TaskManifestAcceptanceCriterion[];
  readonly allowed_changed_paths: readonly string[];
  readonly verification_commands: readonly (readonly string[])[];
  readonly model: ApprovedModelId;
  readonly bounds: { readonly verification_timeout_seconds: number };
};

export type TaskManifestRejection = {
  readonly ok: false;
  readonly code: string;
  readonly reason: string;
};

export type ValidatedTaskManifest = {
  readonly ok: true;
  readonly manifest: TaskManifest;
  readonly manifest_sha256: string;
};

const FIELD_BOUNDS = {
  task_id_max: 128,
  intent_max: 2048,
  change_spec_max: 8192,
  criterion_id_max: 128,
  criterion_text_max: 1024,
  allowed_path_max: 512,
  allowed_paths_min: 1,
  allowed_paths_max: 64,
  argv_elements_max: 8,
  argv_element_max: 256,
  commands_min: 1,
  commands_max: 4,
  criteria_min: 1,
  criteria_max: 8,
  timeout_min: 60,
  timeout_max: 900,
} as const;

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{16,}/,
  /(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}/,
  /(?:MOONSHOT_API_KEY|ZAI_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN|ANTHROPIC_API_KEY)\s*=/i,
  /(?:api[_-]?key|token|secret|password|credential|auth[_-]?token)["'\s:=]+[A-Za-z0-9_\-./+=]{8,}/i,
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function is40HexSha1(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** Repo-path resolution, isolated so tests inject temp paths. */
function resolveTargetRepoPath(value: unknown): { ok: true; realPath: string } | { ok: false; code: string; reason: string } {
  if (!isNonEmptyString(value)) {
    return { ok: false, code: 'TARGET_REPO_PATH_UNRESOLVABLE', reason: 'target_repo_path must be a non-empty string' };
  }
  if (!isAbsolute(value)) {
    return { ok: false, code: 'TARGET_REPO_PATH_NOT_ABSOLUTE', reason: `target_repo_path must be absolute: ${value}` };
  }
  let real: string;
  try {
    real = realpathSync(value);
  } catch {
    return { ok: false, code: 'TARGET_REPO_PATH_UNRESOLVABLE', reason: `target_repo_path does not resolve: ${value}` };
  }
  try {
    if (!statSync(real).isDirectory()) {
      return { ok: false, code: 'TARGET_REPO_PATH_UNRESOLVABLE', reason: `target_repo_path is not a directory: ${value}` };
    }
  } catch {
    return { ok: false, code: 'TARGET_REPO_PATH_UNRESOLVABLE', reason: `target_repo_path is not statable: ${value}` };
  }
  return { ok: true, realPath: real };
}

function containsCredentialLikeValue(value: unknown): string | null {
  if (typeof value === 'string') {
    for (const pattern of CREDENTIAL_PATTERNS) {
      const match = value.match(pattern);
      if (match) return match[0];
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = containsCredentialLikeValue(item);
      if (hit) return hit;
    }
    return null;
  }
  if (isObject(value)) {
    for (const item of Object.values(value)) {
      const hit = containsCredentialLikeValue(item);
      if (hit) return hit;
    }
  }
  return null;
}

export function parseTaskManifest(raw: unknown): { ok: true; manifest: TaskManifest } | TaskManifestRejection {
  if (!isObject(raw)) {
    return { ok: false, code: 'MANIFEST_NOT_OBJECT', reason: 'manifest must be a JSON object' };
  }

  const allowedFields = new Set([
    'schema_version', 'task_id', 'target_repo_path', 'base_commit', 'intent', 'change_spec',
    'acceptance_criteria', 'allowed_changed_paths', 'verification_commands', 'model', 'bounds',
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowedFields.has(key)) {
      return { ok: false, code: 'MANIFEST_UNKNOWN_FIELD', reason: `unknown manifest field: ${key}` };
    }
  }
  for (const field of allowedFields) {
    if (!(field in raw)) {
      return { ok: false, code: 'MANIFEST_MISSING_FIELD', reason: `missing manifest field: ${field}` };
    }
  }

  // Wrong JSON types are distinguished from constraint violations: a non-string
  // where a string (or non-array where an array) is expected is a type failure.
  const stringFields = ['task_id', 'target_repo_path', 'base_commit', 'intent', 'change_spec', 'model'] as const;
  for (const field of stringFields) {
    if (typeof raw[field] !== 'string') {
      return { ok: false, code: 'MANIFEST_FIELD_TYPE', reason: `${field} must be a string, got ${JSON.stringify(raw[field])}` };
    }
  }
  const arrayFields = ['acceptance_criteria', 'allowed_changed_paths', 'verification_commands'] as const;
  for (const field of arrayFields) {
    if (!Array.isArray(raw[field])) {
      return { ok: false, code: 'MANIFEST_FIELD_TYPE', reason: `${field} must be an array, got ${JSON.stringify(raw[field])}` };
    }
  }

  if (raw.schema_version !== 1) {
    return { ok: false, code: 'MANIFEST_FIELD_TYPE', reason: `schema_version must be 1, got ${JSON.stringify(raw.schema_version)}` };
  }
  if (typeof raw.task_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw.task_id) || raw.task_id.length > FIELD_BOUNDS.task_id_max) {
    return { ok: false, code: 'TASK_ID_INVALID', reason: `task_id must be a bounded identifier (1..${FIELD_BOUNDS.task_id_max} chars, [A-Za-z0-9][A-Za-z0-9._-]*): ${JSON.stringify(raw.task_id)}` };
  }
  if ((raw.intent as string).length < 1 || (raw.intent as string).length > FIELD_BOUNDS.intent_max) {
    return { ok: false, code: 'TEXT_FIELD_INVALID', reason: `intent must be 1..${FIELD_BOUNDS.intent_max} chars` };
  }
  if ((raw.change_spec as string).length < 1 || (raw.change_spec as string).length > FIELD_BOUNDS.change_spec_max) {
    return { ok: false, code: 'TEXT_FIELD_INVALID', reason: `change_spec must be 1..${FIELD_BOUNDS.change_spec_max} chars` };
  }
  if (!is40HexSha1(raw.base_commit as string)) {
    return { ok: false, code: 'BASE_COMMIT_NOT_40HEX_SHA1', reason: `base_commit must be an immutable 40-hex SHA-1, got ${JSON.stringify(raw.base_commit)}` };
  }

  if (!Array.isArray(raw.acceptance_criteria)
    || raw.acceptance_criteria.length < FIELD_BOUNDS.criteria_min
    || raw.acceptance_criteria.length > FIELD_BOUNDS.criteria_max) {
    return { ok: false, code: 'ACCEPTANCE_CRITERIA_INVALID', reason: `acceptance_criteria must contain ${FIELD_BOUNDS.criteria_min}..${FIELD_BOUNDS.criteria_max} entries` };
  }
  const criteriaIds = new Set<string>();
  const criteria: TaskManifestAcceptanceCriterion[] = [];
  for (const entry of raw.acceptance_criteria) {
    if (!isObject(entry) || Object.keys(entry).some((k) => k !== 'id' && k !== 'text')) {
      return { ok: false, code: 'ACCEPTANCE_CRITERIA_INVALID', reason: 'each acceptance criterion must be an object with only id and text' };
    }
    if (!('id' in entry) || !('text' in entry)) {
      return { ok: false, code: 'ACCEPTANCE_CRITERIA_INVALID', reason: 'each acceptance criterion requires id and text' };
    }
    const id = entry.id;
    const text = entry.text;
    if (typeof id !== 'string' || id.length < 1 || id.length > FIELD_BOUNDS.criterion_id_max
      || typeof text !== 'string' || text.length < 1 || text.length > FIELD_BOUNDS.criterion_text_max) {
      return { ok: false, code: 'ACCEPTANCE_CRITERIA_INVALID', reason: `criterion id must be 1..${FIELD_BOUNDS.criterion_id_max} chars and text 1..${FIELD_BOUNDS.criterion_text_max} chars` };
    }
    if (criteriaIds.has(id)) {
      return { ok: false, code: 'ACCEPTANCE_CRITERIA_INVALID', reason: `duplicate acceptance criterion id: ${id}` };
    }
    criteriaIds.add(id);
    criteria.push({ id, text });
  }

  if (!Array.isArray(raw.allowed_changed_paths)
    || raw.allowed_changed_paths.length < FIELD_BOUNDS.allowed_paths_min
    || raw.allowed_changed_paths.length > FIELD_BOUNDS.allowed_paths_max) {
    return { ok: false, code: 'ALLOWED_PATH_COUNT_INVALID', reason: `allowed_changed_paths must contain ${FIELD_BOUNDS.allowed_paths_min}..${FIELD_BOUNDS.allowed_paths_max} entries` };
  }
  const allowedPaths: string[] = [];
  for (const path of raw.allowed_changed_paths) {
    if (typeof path !== 'string' || path.length === 0) {
      return { ok: false, code: 'ALLOWED_PATH_EMPTY', reason: 'allowed_changed_paths entries must be non-empty strings' };
    }
    if (path.length > FIELD_BOUNDS.allowed_path_max || path.startsWith('/') || isAbsolute(path)) {
      return { ok: false, code: 'ALLOWED_PATH_NOT_REPO_RELATIVE', reason: `allowed path must be repo-relative: ${JSON.stringify(path)}` };
    }
    const segments = path.split('/');
    if (segments.some((segment) => segment === '..')) {
      return { ok: false, code: 'ALLOWED_PATH_NOT_REPO_RELATIVE', reason: `allowed path must not contain '..' segments: ${JSON.stringify(path)}` };
    }
    if (segments.some((segment) => segment === '.git')) {
      return { ok: false, code: 'ALLOWED_PATH_GIT_PREFIX', reason: `allowed path must not touch .git: ${JSON.stringify(path)}` };
    }
    allowedPaths.push(path);
  }

  if (!Array.isArray(raw.verification_commands)
    || raw.verification_commands.length < FIELD_BOUNDS.commands_min
    || raw.verification_commands.length > FIELD_BOUNDS.commands_max) {
    return { ok: false, code: 'VERIFICATION_COMMAND_COUNT_INVALID', reason: `verification_commands must contain ${FIELD_BOUNDS.commands_min}..${FIELD_BOUNDS.commands_max} commands` };
  }
  const commands: string[][] = [];
  for (const argv of raw.verification_commands) {
    if (!Array.isArray(argv) || argv.length < 1) {
      return { ok: false, code: 'VERIFICATION_ARGV_EMPTY', reason: 'each verification command must be a non-empty argv array' };
    }
    if (argv.length > FIELD_BOUNDS.argv_elements_max) {
      return { ok: false, code: 'VERIFICATION_ARGV_TOO_LONG', reason: `each verification command allows at most ${FIELD_BOUNDS.argv_elements_max} elements` };
    }
    const checked: string[] = [];
    for (const element of argv) {
      if (typeof element !== 'string' || element.length === 0) {
        return { ok: false, code: 'VERIFICATION_ARG_INVALID_CHARS', reason: 'argv elements must be non-empty strings' };
      }
      if (element.length > FIELD_BOUNDS.argv_element_max) {
        return { ok: false, code: 'VERIFICATION_ARG_TOO_LONG', reason: `argv elements allow at most ${FIELD_BOUNDS.argv_element_max} chars` };
      }
      if (element.includes('\0') || element.includes('\n') || element.includes('\r')) {
        return { ok: false, code: 'VERIFICATION_ARG_INVALID_CHARS', reason: 'argv elements must not contain NUL or newline characters' };
      }
      checked.push(element);
    }
    if (checked[0]!.includes('/')) {
      return { ok: false, code: 'VERIFICATION_ARG0_NOT_BARE', reason: `argv[0] must be a bare command name, got ${JSON.stringify(checked[0])}` };
    }
    commands.push(checked);
  }

  if (!isApprovedModelId(raw.model)) {
    return { ok: false, code: 'MODEL_NOT_APPROVED', reason: `model must be an exact approved model id, got ${JSON.stringify(raw.model)}` };
  }
  if (!isObject(raw.bounds)) {
    return { ok: false, code: 'MANIFEST_FIELD_TYPE', reason: 'bounds must be an object' };
  }
  for (const key of Object.keys(raw.bounds)) {
    if (key !== 'verification_timeout_seconds') {
      return { ok: false, code: 'MANIFEST_UNKNOWN_FIELD', reason: `unknown bounds field: ${key}` };
    }
  }
  const timeout = raw.bounds.verification_timeout_seconds;
  if (typeof timeout !== 'number' || !Number.isInteger(timeout)
    || timeout < FIELD_BOUNDS.timeout_min || timeout > FIELD_BOUNDS.timeout_max) {
    return { ok: false, code: 'VERIFICATION_TIMEOUT_OUT_OF_RANGE', reason: `bounds.verification_timeout_seconds must be an integer in ${FIELD_BOUNDS.timeout_min}..${FIELD_BOUNDS.timeout_max}` };
  }

  const target = resolveTargetRepoPath(raw.target_repo_path);
  if (!target.ok) {
    return { ok: false, code: target.code, reason: target.reason };
  }

  const credentialHit = containsCredentialLikeValue(raw);
  if (credentialHit !== null) {
    return { ok: false, code: 'CREDENTIAL_LIKE_VALUE', reason: 'manifest contains a credential-like value (redacted from evidence)' };
  }

  const manifest: TaskManifest = {
    schema_version: 1,
    task_id: raw.task_id as string,
    target_repo_path: target.realPath,
    base_commit: raw.base_commit as string,
    intent: raw.intent as string,
    change_spec: raw.change_spec as string,
    acceptance_criteria: Object.freeze(criteria),
    allowed_changed_paths: Object.freeze(allowedPaths),
    verification_commands: Object.freeze(commands.map((argv) => Object.freeze([...argv]))),
    model: raw.model as ApprovedModelId,
    bounds: { verification_timeout_seconds: timeout },
  };
  return { ok: true, manifest };
}

export function loadTaskManifest(path: string): ValidatedTaskManifest | (TaskManifestRejection & { readonly ok: false }) {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return { ok: false, code: 'MANIFEST_UNREADABLE', reason: `cannot read task manifest: ${path}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { ok: false, code: 'MANIFEST_INVALID_JSON', reason: `task manifest is not valid JSON: ${path}` };
  }
  const parsed = parseTaskManifest(raw);
  if (!parsed.ok) {
    return parsed;
  }
  return {
    ok: true,
    manifest: parsed.manifest,
    manifest_sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
