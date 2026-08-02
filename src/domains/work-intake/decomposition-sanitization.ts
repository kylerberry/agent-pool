/**
 * Work Intake — deterministic prompt-bound sanitization.
 *
 * Applies H1: scan every raw-spec and breadth string before it reaches a model
 * prompt or provenance record. Redact recognized secret-bearing values with
 * stable markers; reject values that cannot be safely sanitized. No credentials,
 * raw provider payloads, or ambient environment values cross this boundary.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface SanitizationPolicy {
  readonly version: number;
  readonly patterns: readonly SanitizerPattern[];
}

export interface SanitizerPattern {
  readonly id: string;
  readonly regex: string;
  readonly flags: string;
  readonly replacement: string;
}

const REPLACEMENT = "[REDACTED-SECRET]";
const REJECT_REPLACEMENT = "[REJECTED-UNSANITIZABLE]";

// Deterministic detector set. Each pattern identifies a class of secret-bearing
// value commonly found in raw specs, source paths, or graph labels.
const DEFAULT_PATTERNS: readonly SanitizerPattern[] = Object.freeze([
  {
    id: "openai-api-key",
    regex: String.raw`\b(sk-[a-zA-Z0-9_-]{20,})\b`,
    flags: "g",
    replacement: REPLACEMENT,
  },
  {
    id: "generic-api-key",
    regex: String.raw`\b(?:api[_-]?key|apikey)\s*[:=]\s*["']?([a-zA-Z0-9_\-]{16,})["']?`,
    flags: "gi",
    replacement: REPLACEMENT,
  },
  {
    id: "password-assignment",
    regex: String.raw`\b(?:password|passwd|pwd)\s*[:=]\s*["']?([^\s"'\n]{4,})["']?`,
    flags: "gi",
    replacement: REPLACEMENT,
  },
  {
    id: "jwt-token",
    regex: String.raw`\b(eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*\.?[a-zA-Z0-9_-]*)\b`,
    flags: "g",
    replacement: REPLACEMENT,
  },
  {
    id: "bearer-token",
    regex: String.raw`\b(Bearer\s+[a-zA-Z0-9_\-\.]{20,})\b`,
    flags: "gi",
    replacement: REPLACEMENT,
  },
  {
    id: "private-key-block",
    regex: String.raw`-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----`,
    flags: "g",
    replacement: REPLACEMENT,
  },
  {
    id: "high-entropy-secret",
    regex: String.raw`\b(?:secret|token|credential)\s*[:=]\s*["']?([a-zA-Z0-9_\-]{24,})["']?`,
    flags: "gi",
    replacement: REPLACEMENT,
  },
]);

const DEFAULT_POLICY: SanitizationPolicy = Object.freeze({
  version: 1,
  patterns: DEFAULT_PATTERNS,
});

function compilePattern(pattern: SanitizerPattern): RegExp {
  return new RegExp(pattern.regex, pattern.flags);
}

export function sanitizePromptBoundValue(
  value: string,
  policy: SanitizationPolicy = loadSanitizationPolicyFromSource(),
): string {
  if (typeof value !== "string") {
    throw new Error("sanitization input must be a string");
  }
  let sanitized = value;
  for (const pattern of policy.patterns) {
    sanitized = sanitized.replace(compilePattern(pattern), pattern.replacement);
  }
  // Reject any remaining value that still looks like an unsanitized high-entropy
  // credential after pattern redaction.
  if (/\b(?:sk-[a-zA-Z0-9_-]{20,}|eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*)\b/.test(sanitized)) {
    return REJECT_REPLACEMENT;
  }
  return sanitized;
}

export function sanitizeStringArray(values: readonly string[]): readonly string[] {
  return Object.freeze(values.map((v) => sanitizePromptBoundValue(v)));
}

export function sanitizeOptionalString(value: string | undefined): string | undefined {
  return value === undefined ? undefined : sanitizePromptBoundValue(value);
}

export function projectProviderError(_error: unknown): { code: string; reason: string } {
  // Never echo raw provider exception text, payloads, or credentials.
  return { code: "MODEL_INVOCATION_FAILED", reason: "Model invocation failed" };
}

export function projectRetrievalError(_error: unknown): { code: string; reason: string } {
  // Never echo raw retriever exception text, cache paths, or credentials.
  return { code: "BREADTH_RETRIEVAL_FAILED", reason: "Breadth retrieval failed" };
}

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SOURCE_DIR, "..", "..", "..");

export function loadSanitizationPolicyFromSource(): SanitizationPolicy {
  const path = join(REPO_ROOT, "packages/orchestrator-harness/config/sanitization-policy.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("sanitization policy must be an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.version !== "number" || !Number.isInteger(obj.version) || obj.version <= 0) {
    throw new Error("sanitization policy version must be a positive integer");
  }
  if (!Array.isArray(obj.patterns)) {
    throw new Error("sanitization policy patterns must be an array");
  }
  const patterns = obj.patterns.map((p) => {
    if (!p || typeof p !== "object") throw new Error("pattern must be an object");
    const pattern = p as Record<string, unknown>;
    if (typeof pattern.id !== "string" || pattern.id === "") throw new Error("pattern id required");
    if (typeof pattern.regex !== "string") throw new Error("pattern regex required");
    if (typeof pattern.flags !== "string") throw new Error("pattern flags required");
    if (typeof pattern.replacement !== "string") throw new Error("pattern replacement required");
    return Object.freeze({
      id: pattern.id,
      regex: pattern.regex,
      flags: pattern.flags,
      replacement: pattern.replacement,
    });
  });
  return Object.freeze({ version: obj.version, patterns });
}
