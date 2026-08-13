import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type PiProcess,
  type PoolProofLaunchExpectations,
  type ProofJob,
} from '../../src/domains/agent-execution/index.ts';

export function deferrable(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export function yieldToEventLoop(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

export function makeJob(fixturePath: string): ProofJob {
  return {
    nodeId: 'single-worker-pool-proof',
    attemptId: 'att://proof/single-worker-pool-proof/1',
    attemptNumber: 1,
    intent: 'test',
    changeSpec: 'test',
    acceptanceCriteria: [{ id: 'c1', text: 'test passes' }],
    criteriaOriginSource: 'direct_task',
    criteriaOriginSourceId: 'test',
    targetRepo: 'single-worker-fixture',
    targetBranch: 'main',
    allowedChangedPaths: ['src/message.js'],
    fixtureTestCommand: ['node', '--test', 'test/message.test.js'],
    workspacePath: fixturePath,
  };
}

export function setupFixture(fixturePath: string): void {
  mkdirSync(join(fixturePath, 'src'), { recursive: true });
  mkdirSync(join(fixturePath, 'test'), { recursive: true });
  writeFileSync(join(fixturePath, 'src/message.js'), "export function getMessage() { return 'world'; }");
  writeFileSync(
    join(fixturePath, 'test/message.test.js'),
    `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { getMessage } from '../src/message.js'; test('msg', () => assert.equal(getMessage(), 'world'));`,
  );
  writeFileSync(join(fixturePath, 'package.json'), JSON.stringify({ type: 'module' }));
  mkdirSync(join(fixturePath, '.git'), { recursive: true });
  writeFileSync(join(fixturePath, '.git', 'HEAD'), 'abc123');
  writeFileSync(join(fixturePath, '.git', 'HEAD^'), 'base123');
}

export function makeFakeProcess(attemptId: string, nodeId: string, nonce: string, resultId: string, overrides?: Partial<PiProcess>): PiProcess {
  return Object.freeze({
    pid: 12345,
    exitCode: 0,
    signalCode: null,
    timedOut: false,
    output: '',
    attemptId,
    nodeId,
    attemptNonce: nonce,
    resultId,
    failureCode: null,
    ...overrides,
  });
}

export function makeLaunchIdentity(): PoolProofLaunchExpectations {
  return {
    nodeId: 'single-worker-pool-proof',
    attemptId: 'att://proof/single-worker-pool-proof/1',
    targetRepo: 'single-worker-fixture',
    targetBranch: 'main',
    workspacePath: '/tmp/fake',
    piRuntimeParent: '/tmp/fake/pi',
    piSessionDir: '/tmp/fake/session',
    piExecutablePath: '/opt/pi/pi',
    piExecutableVersion: '0.84.1',
    piExecutableDigest: 'pinned-pi-digest',
    packagePath: '/opt/agent-pool-worker-harness',
    packageProfile: 'pool-proof-builder',
    packageDigest: 'pinned-package-digest',
    profileName: 'pool-proof-builder',
    profilePath: '/opt/agent-pool-worker-harness/profiles/pool-proof-builder',
    profileDigest: 'pinned-profile-digest',
    selectedModel: 'moonshot/kimi-k2.7-code',
    toolGrants: ['read', 'edit', 'write', 'bash', 'actor_identity'],
    resultDestinationId: 'result-1',
  };
}
