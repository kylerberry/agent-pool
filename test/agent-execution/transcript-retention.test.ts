import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  TRANSCRIPT_RETENTION_ORDER,
  isWorkspaceRelativeLocator,
  retainTranscript,
  type DurableObjectMetadata,
  type RetainTranscriptInput,
  type TranscriptAuditRecord,
} from '../../src/domains/agent-execution/index.ts';

const RAW = 'model call ok\nOPENAI_API_KEY=sk-live-secret\ndone';
const REDACTED = 'model call ok\nOPENAI_API_KEY=[REDACTED]\ndone';

type Recorder = { steps: string[] };

function fakeStore(recorder: Recorder, overrides: {
  putThrows?: boolean;
  headThrows?: boolean;
  headResult?: DurableObjectMetadata | null;
  objectId?: string;
} = {}) {
  const stored = new Map<string, Buffer>();
  return {
    async put(key: string, bytes: Buffer): Promise<string> {
      recorder.steps.push('persist');
      if (overrides.putThrows) throw new Error('object store unavailable');
      const objectId = overrides.objectId ?? `obj-${key}`;
      stored.set(objectId, bytes);
      return objectId;
    },
    async head(objectId: string): Promise<DurableObjectMetadata | null> {
      recorder.steps.push('verify');
      if (overrides.headThrows) throw new Error('object store unavailable');
      if (overrides.headResult !== undefined) return overrides.headResult;
      const bytes = stored.get(objectId);
      if (!bytes) return null;
      return { sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.byteLength };
    },
  };
}

function input(recorder: Recorder, overrides: Partial<RetainTranscriptInput> = {}): RetainTranscriptInput {
  const committed: TranscriptAuditRecord[] = [];
  return {
    nodeId: 'node-1',
    attemptId: 'attempt-1',
    phase: 'R',
    transcriptPath: '.agent-pool/transcripts/R.log',
    source: {
      async finalize() {
        recorder.steps.push('finalize');
        return RAW;
      },
    },
    redactor: {
      redact(text: string) {
        recorder.steps.push('redact');
        return {
          text: text.replace(/sk-[A-Za-z0-9-]+/g, '[REDACTED]'),
          policyVersion: 'redaction-policy-v1',
          redactionCount: 1,
        };
      },
    },
    objectStore: fakeStore(recorder),
    auditIndex: {
      async commit(record) {
        recorder.steps.push('index');
        committed.push(record);
      },
    },
    now: () => new Date('2026-07-31T12:00:00Z'),
    ...overrides,
  };
}

describe('transcript retention pipeline', () => {
  it('runs finalize, redact, hash, persist, verify, and index in that order', async () => {
    const recorder: Recorder = { steps: [] };
    const outcome = await retainTranscript(input(recorder));

    assert.equal(outcome.status, 'audit_complete');
    assert.deepEqual([...outcome.stepsCompleted], [...TRANSCRIPT_RETENTION_ORDER]);
    // 'hash' is local work with no collaborator call, so it is absent from the
    // collaborator trace; the ordering of the observable calls still holds.
    assert.deepEqual(recorder.steps, ['finalize', 'redact', 'persist', 'verify', 'index']);
  });

  it('hashes the redacted bytes that are actually persisted', async () => {
    const recorder: Recorder = { steps: [] };
    const outcome = await retainTranscript(input(recorder));
    assert.equal(outcome.status, 'audit_complete');
    assert.ok('record' in outcome);

    const expected = createHash('sha256').update(Buffer.from(REDACTED, 'utf8')).digest('hex');
    assert.equal(outcome.record.sha256, expected);
    assert.equal(outcome.record.byte_size, Buffer.byteLength(REDACTED, 'utf8'));
    assert.notEqual(outcome.record.sha256, createHash('sha256').update(Buffer.from(RAW, 'utf8')).digest('hex'));
  });

  it('indexes by durable object id and never by a workspace path', async () => {
    const recorder: Recorder = { steps: [] };
    const outcome = await retainTranscript(input(recorder));
    assert.ok('record' in outcome);

    assert.equal(typeof outcome.record.transcript_object_id, 'string');
    assert.ok(outcome.record.transcript_object_id.length > 0);
    assert.equal(Object.hasOwn(outcome.record, 'transcript_path'), false);
    assert.equal(JSON.stringify(outcome.record).includes('/tmp/'), false);
    assert.equal(outcome.record.redaction_status, 'redacted');
    assert.equal(outcome.record.redaction_policy_version, 'redaction-policy-v1');
    assert.equal(outcome.record.access_classification, 'authorized-human-only');
    assert.equal(outcome.record.extraction_status, 'audit_complete');
    assert.equal(outcome.record.retention_status, 'retained');
  });

  it('records audit_incomplete when durable persistence fails', async () => {
    const recorder: Recorder = { steps: [] };
    const outcome = await retainTranscript(input(recorder, { objectStore: fakeStore(recorder, { putThrows: true }) }));

    assert.equal(outcome.status, 'audit_incomplete');
    assert.ok('failedStep' in outcome);
    assert.equal(outcome.failedStep, 'persist');
    assert.equal(outcome.failure.code, 'TRANSCRIPT_PERSIST_FAILED');
    assert.deepEqual([...outcome.stepsCompleted], ['finalize', 'redact', 'hash']);
    assert.equal(recorder.steps.includes('index'), false);
  });

  it('records audit_incomplete when the stored object fails verification', async () => {
    const recorder: Recorder = { steps: [] };
    const tampered = fakeStore(recorder, { headResult: { sha256: 'deadbeef', byteSize: 1 } });
    const outcome = await retainTranscript(input(recorder, { objectStore: tampered }));

    assert.equal(outcome.status, 'audit_incomplete');
    assert.ok('failedStep' in outcome);
    assert.equal(outcome.failedStep, 'verify');
    assert.equal(outcome.failure.code, 'TRANSCRIPT_VERIFY_FAILED');
    assert.equal(recorder.steps.includes('index'), false);
  });

  it('records audit_incomplete when the durable object is missing after persist', async () => {
    const recorder: Recorder = { steps: [] };
    const outcome = await retainTranscript(input(recorder, { objectStore: fakeStore(recorder, { headResult: null }) }));
    assert.equal(outcome.status, 'audit_incomplete');
    assert.ok('failedStep' in outcome);
    assert.equal(outcome.failedStep, 'verify');
  });

  it('records audit_incomplete when the transactional index commit fails', async () => {
    const recorder: Recorder = { steps: [] };
    const outcome = await retainTranscript(
      input(recorder, {
        auditIndex: {
          async commit() {
            recorder.steps.push('index');
            throw new Error('sqlite is locked');
          },
        },
      }),
    );

    assert.equal(outcome.status, 'audit_incomplete');
    assert.ok('failedStep' in outcome);
    assert.equal(outcome.failedStep, 'index');
    assert.equal(outcome.failure.code, 'TRANSCRIPT_INDEX_FAILED');
    assert.deepEqual([...outcome.stepsCompleted], ['finalize', 'redact', 'hash', 'persist', 'verify']);
  });

  it('records audit_incomplete when redaction fails, without persisting anything', async () => {
    const recorder: Recorder = { steps: [] };
    const outcome = await retainTranscript(
      input(recorder, {
        redactor: {
          redact() {
            recorder.steps.push('redact');
            throw new Error('redaction policy failed to load');
          },
        },
      }),
    );

    assert.equal(outcome.status, 'audit_incomplete');
    assert.ok('failedStep' in outcome);
    assert.equal(outcome.failedStep, 'redact');
    assert.equal(outcome.failure.code, 'TRANSCRIPT_NOT_REDACTED');
    assert.equal(recorder.steps.includes('persist'), false);
  });

  it('records audit_incomplete when the redactor returns an unusable result', async () => {
    const recorder: Recorder = { steps: [] };
    const outcome = await retainTranscript(
      input(recorder, {
        redactor: {
          redact() {
            recorder.steps.push('redact');
            return { text: undefined, policyVersion: 'v1', redactionCount: 0 } as never;
          },
        },
      }),
    );
    assert.equal(outcome.status, 'audit_incomplete');
    assert.ok('failedStep' in outcome);
    assert.equal(outcome.failedStep, 'redact');
    assert.equal(recorder.steps.includes('persist'), false);
  });

  it('records audit_incomplete when finalization fails', async () => {
    const recorder: Recorder = { steps: [] };
    const outcome = await retainTranscript(
      input(recorder, {
        source: {
          async finalize() {
            recorder.steps.push('finalize');
            throw new Error('transcript stream broken');
          },
        },
      }),
    );
    assert.equal(outcome.status, 'audit_incomplete');
    assert.ok('failedStep' in outcome);
    assert.equal(outcome.failedStep, 'finalize');
    assert.deepEqual([...outcome.stepsCompleted], []);
  });

  it('rejects a transcript_path that is not a workspace-relative locator', async () => {
    for (const path of ['/abs/attempt/transcript.log', 'C:\\attempt\\t.log', '../escape.log', 'a/../../b.log', '']) {
      const recorder: Recorder = { steps: [] };
      const outcome = await retainTranscript(input(recorder, { transcriptPath: path }));
      assert.equal(outcome.status, 'audit_incomplete', `${path} must be rejected`);
      assert.ok('failure' in outcome);
      assert.equal(outcome.failure.code, 'TRANSCRIPT_PATH_NOT_WORKSPACE_RELATIVE');
      assert.deepEqual(recorder.steps, []);
    }
  });

  it('classifies workspace-relative locators consistently with the phase artifact contract', () => {
    assert.equal(isWorkspaceRelativeLocator('.agent-pool/transcripts/R.log'), true);
    assert.equal(isWorkspaceRelativeLocator('transcripts/R.log'), true);
    assert.equal(isWorkspaceRelativeLocator('/transcripts/R.log'), false);
    assert.equal(isWorkspaceRelativeLocator('..'), false);
  });

  it('sanitizes the durable object key so a hostile id cannot escape the store', async () => {
    const recorder: Recorder = { steps: [] };
    const keys: string[] = [];
    const capturing = {
      async put(key: string, bytes: Buffer): Promise<string> {
        recorder.steps.push('persist');
        keys.push(key);
        return 'obj-1';
      },
      async head(): Promise<DurableObjectMetadata> {
        recorder.steps.push('verify');
        const bytes = Buffer.from(REDACTED, 'utf8');
        return { sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.byteLength };
      },
    };
    await retainTranscript(
      input(recorder, { nodeId: '../../etc', attemptId: 'a/../../b', objectStore: capturing }),
    );

    assert.equal(keys.length, 1);
    const segments = keys[0].split('/');
    // The separators an id tried to inject are gone, so no segment can traverse.
    assert.equal(segments.length, 3, `object key must have exactly three segments: ${keys[0]}`);
    for (const segment of segments) {
      assert.notEqual(segment, '..', `object key must not traverse: ${keys[0]}`);
    }
    assert.equal(keys[0], '.._.._etc/a_.._.._b/R.transcript');
  });

  it('never throws, so a failed extraction cannot strand the workspace', async () => {
    const recorder: Recorder = { steps: [] };
    const outcome = await retainTranscript(input(recorder, { objectStore: fakeStore(recorder, { headThrows: true }) }));
    assert.equal(outcome.status, 'audit_incomplete');
    assert.ok('node_id' in outcome);
    assert.equal(outcome.node_id, 'node-1');
    assert.equal(outcome.attempt_id, 'attempt-1');
  });
});
