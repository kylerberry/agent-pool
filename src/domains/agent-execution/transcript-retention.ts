/**
 * Transcript retention pipeline (ADR-026, ADR-032).
 *
 * A retained transcript must become a verified durable object *before* the
 * ephemeral workspace is destroyed, otherwise the audit index ends up pointing
 * at bytes that no longer exist. The ordering is therefore not an implementation
 * detail — it is the contract:
 *
 *   finalize -> redact -> hash -> persist -> verify -> index -> extraction complete
 *
 * Two consequences are enforced here rather than left to callers:
 *
 * - The hash is taken over the redacted bytes that are actually persisted, so a
 *   verified object is provably the object that was reviewed for secrets.
 * - Verification re-reads the durable object's own metadata. Comparing the local
 *   buffer against itself would verify nothing.
 *
 * `transcript_path` stays what the phase-artifact contract says it is: a
 * transient workspace-relative extraction locator, never a durable reference.
 * The durable reference is `transcript_object_id`.
 */

import { createHash } from 'node:crypto';
import {
  createExecutionFailure,
  deepFreeze,
  type CraftsPhase,
  type ExecutionFailure,
  type TranscriptRetentionStep,
} from './contracts.ts';

export const TRANSCRIPT_RETENTION_ORDER: readonly TranscriptRetentionStep[] = Object.freeze([
  'finalize',
  'redact',
  'hash',
  'persist',
  'verify',
  'index',
]);

/** Rejects absolute paths, Windows drive-qualified paths, and any `..` traversal. */
const WORKSPACE_RELATIVE_LOCATOR = /^(?![\\/])(?![A-Za-z]:[\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$)).+$/;

export function isWorkspaceRelativeLocator(value: string): boolean {
  return WORKSPACE_RELATIVE_LOCATOR.test(value);
}

export type RedactionResult = {
  readonly text: string;
  readonly policyVersion: string;
  readonly redactionCount: number;
};

export type DurableObjectMetadata = {
  readonly sha256: string;
  readonly byteSize: number;
};

export interface TranscriptSource {
  /** Finalize and close the transcript, returning its complete bytes. */
  finalize(): Promise<string>;
}

export interface TranscriptRedactor {
  redact(text: string): RedactionResult;
}

export interface TranscriptObjectStore {
  /** Persist bytes outside the attempt workspace and return the durable object id. */
  put(key: string, bytes: Buffer): Promise<string>;
  /** Read back the stored object's own metadata; null when the object is absent. */
  head(objectId: string): Promise<DurableObjectMetadata | null>;
}

export interface TranscriptAuditIndex {
  /** Transactionally commit the audit record. Throwing marks the attempt audit_incomplete. */
  commit(record: TranscriptAuditRecord): Promise<void>;
}

export type TranscriptAuditRecord = {
  readonly node_id: string;
  readonly attempt_id: string;
  readonly phase: CraftsPhase;
  readonly transcript_object_id: string;
  readonly sha256: string;
  readonly byte_size: number;
  readonly media_type: string;
  readonly schema_version: number;
  readonly redaction_policy_version: string;
  readonly redaction_status: 'redacted';
  readonly redaction_count: number;
  readonly created_at: string;
  readonly retention_status: 'retained';
  readonly access_classification: 'authorized-human-only';
  readonly extraction_status: 'audit_complete';
};

export type TranscriptRetentionSuccess = {
  readonly status: 'audit_complete';
  readonly record: TranscriptAuditRecord;
  readonly stepsCompleted: readonly TranscriptRetentionStep[];
};

export type TranscriptRetentionIncomplete = {
  readonly status: 'audit_incomplete';
  readonly failedStep: TranscriptRetentionStep;
  readonly failure: ExecutionFailure;
  readonly stepsCompleted: readonly TranscriptRetentionStep[];
  readonly node_id: string;
  readonly attempt_id: string;
  readonly phase: CraftsPhase;
};

export type TranscriptRetentionOutcome = TranscriptRetentionSuccess | TranscriptRetentionIncomplete;

export type RetainTranscriptInput = {
  readonly nodeId: string;
  readonly attemptId: string;
  readonly phase: CraftsPhase;
  /** Workspace-relative extraction locator. Never stored as the durable reference. */
  readonly transcriptPath: string;
  readonly source: TranscriptSource;
  readonly redactor: TranscriptRedactor;
  readonly objectStore: TranscriptObjectStore;
  readonly auditIndex: TranscriptAuditIndex;
  readonly mediaType?: string;
  readonly now?: () => Date;
};

function incomplete(
  input: RetainTranscriptInput,
  failedStep: TranscriptRetentionStep,
  failure: ExecutionFailure,
  stepsCompleted: readonly TranscriptRetentionStep[],
): TranscriptRetentionIncomplete {
  return deepFreeze({
    status: 'audit_incomplete' as const,
    failedStep,
    failure,
    stepsCompleted: [...stepsCompleted],
    node_id: input.nodeId,
    attempt_id: input.attemptId,
    phase: input.phase,
  });
}

/**
 * Run the retention pipeline for one retained transcript.
 *
 * Never throws: an extraction failure is a recorded `audit_incomplete` outcome,
 * because the structured failure-context artifact remains the primary machine
 * record and a throw here would strand the workspace.
 */
export async function retainTranscript(
  input: RetainTranscriptInput,
): Promise<TranscriptRetentionOutcome> {
  const completed: TranscriptRetentionStep[] = [];
  const nowFn = input.now ?? (() => new Date());

  if (!isWorkspaceRelativeLocator(input.transcriptPath)) {
    return incomplete(
      input,
      'finalize',
      createExecutionFailure('TRANSCRIPT_PATH_NOT_WORKSPACE_RELATIVE', input.transcriptPath),
      completed,
    );
  }

  let raw: string;
  try {
    raw = await input.source.finalize();
  } catch {
    return incomplete(input, 'finalize', createExecutionFailure('TRANSCRIPT_STEP_OUT_OF_ORDER', 'finalize failed'), completed);
  }
  completed.push('finalize');

  let redaction: RedactionResult;
  try {
    redaction = input.redactor.redact(raw);
  } catch {
    return incomplete(input, 'redact', createExecutionFailure('TRANSCRIPT_NOT_REDACTED'), completed);
  }
  if (typeof redaction?.text !== 'string' || typeof redaction?.policyVersion !== 'string') {
    return incomplete(input, 'redact', createExecutionFailure('TRANSCRIPT_NOT_REDACTED'), completed);
  }
  completed.push('redact');

  // Hash the redacted bytes that are about to be persisted, never the raw ones.
  const bytes = Buffer.from(redaction.text, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const byteSize = bytes.byteLength;
  completed.push('hash');

  // Node and attempt ids reach here from an upstream contract. They are already
  // validated, but the object key is handed to an injected store that may be
  // filesystem-backed, so it is sanitised rather than trusted: a `../` in an id
  // must not become a path escape inside someone else's store implementation.
  const objectKey = [input.nodeId, input.attemptId, `${input.phase}.transcript`]
    .map((segment) => segment.replace(/[^A-Za-z0-9._-]/g, '_'))
    .join('/');
  let objectId: string;
  try {
    objectId = await input.objectStore.put(objectKey, bytes);
  } catch {
    return incomplete(input, 'persist', createExecutionFailure('TRANSCRIPT_PERSIST_FAILED'), completed);
  }
  if (typeof objectId !== 'string' || objectId.trim() === '') {
    return incomplete(input, 'persist', createExecutionFailure('TRANSCRIPT_PERSIST_FAILED'), completed);
  }
  completed.push('persist');

  let stored: DurableObjectMetadata | null;
  try {
    stored = await input.objectStore.head(objectId);
  } catch {
    return incomplete(input, 'verify', createExecutionFailure('TRANSCRIPT_VERIFY_FAILED'), completed);
  }
  if (!stored || stored.sha256 !== sha256 || stored.byteSize !== byteSize) {
    return incomplete(input, 'verify', createExecutionFailure('TRANSCRIPT_VERIFY_FAILED'), completed);
  }
  completed.push('verify');

  const record: TranscriptAuditRecord = deepFreeze({
    node_id: input.nodeId,
    attempt_id: input.attemptId,
    phase: input.phase,
    transcript_object_id: objectId,
    sha256,
    byte_size: byteSize,
    media_type: input.mediaType ?? 'text/plain',
    schema_version: 1,
    redaction_policy_version: redaction.policyVersion,
    redaction_status: 'redacted' as const,
    redaction_count: redaction.redactionCount,
    created_at: nowFn().toISOString(),
    retention_status: 'retained' as const,
    access_classification: 'authorized-human-only' as const,
    extraction_status: 'audit_complete' as const,
  });

  try {
    await input.auditIndex.commit(record);
  } catch {
    return incomplete(input, 'index', createExecutionFailure('TRANSCRIPT_INDEX_FAILED'), completed);
  }
  completed.push('index');

  return deepFreeze({
    status: 'audit_complete' as const,
    record,
    stepsCompleted: [...completed],
  });
}
