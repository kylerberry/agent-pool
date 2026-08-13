import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestTempDir } from './test-temp-dir.ts';
import { createPoolProofPiLauncher } from '../../src/domains/agent-execution/index.ts';
import { buildMarker, digestFile, makeExpectations, makeFakePiAuthDumpScript, makeFakePiIdentityCapsuleDumpScript, makeFakePiPromptDumpScript, makeFakePiScript, makeIdentityDirs, makeJob } from './pool-proof-pi-launcher.fixtures.ts';

describe('Pool Proof Pi Launcher', () => {
  it('launches a fake executable that rejects unknown flags and receives the prompt', async (t) => {
    const runtimeRoot = createTestTempDir(t, 'launcher-');
    const fixturePath = createTestTempDir(t, 'fixture-');
    mkdirSync(join(fixturePath, 'src'), { recursive: true });
    const identity = makeIdentityDirs(runtimeRoot);
    const piPath = makeFakePiScript(runtimeRoot, { includePrompt: 'Attempt contract' });

    const launcher = createPoolProofPiLauncher({
      expectations: makeExpectations(fixturePath, piPath, identity),
      job: makeJob(),
      verifyPackageAndProfile: identity.verify,
    });

    const now = new Date();
    const launched = await launcher.launch({
      schema_version: 3,
      actor: 'pool-worker',
      node_id: 'single-worker-pool-proof',
      attempt_id: 'att://proof/single-worker-pool-proof/1',
      attempt_nonce: 'a'.repeat(64),
      issued_by: 'agent-pool-runtime',
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 179_000).toISOString(),
      max_age_seconds: 180,
      target_repo: 'fixture',
      target_branch: 'main',
      workspace_path: fixturePath,
      pi_runtime_parent: join(fixturePath, '.pi-runtime'),
      pi_session_dir: join(fixturePath, '.pi-runtime', 'session'),
      pi_executable_identity: {
        path: piPath,
        version: '0.84.1',
        digest: digestFile(piPath),
      },
      package_identity: {
        path: identity.packagePath,
        profile: 'pool-proof-builder',
        digest: identity.packageDigest,
      },
      profile_identity: {
        name: 'pool-proof-builder',
        path: identity.profilePath,
        digest: identity.profileDigest,
      },
      selected_model: 'openai-codex/gpt-5.6-terra',
      tool_grants: ['read', 'edit', 'write', 'bash', 'actor_identity'],
      result_destination: { kind: 'sqlite', id: 'result-1' },
    });

    assert.ok('exitCode' in launched, `launch failed: ${(launched as { code: string; reason: string }).code}`);
    assert.equal(launched.exitCode, 0);
    assert.ok((launched.output ?? '').includes('{"done":true}'));
  });

  it('rejects launch when profile declares more than one agent', async (t) => {
    const runtimeRoot = createTestTempDir(t, 'launcher-');
    const fixturePath = createTestTempDir(t, 'fixture-');
    mkdirSync(join(fixturePath, 'src'), { recursive: true });
    const identity = makeIdentityDirs(runtimeRoot);
    const piPath = makeFakePiScript(runtimeRoot, { includePrompt: 'Attempt contract' });
    const expectations = makeExpectations(fixturePath, piPath, identity);

    writeFileSync(
      join(identity.profilePath, 'profile.json'),
      JSON.stringify({
        name: 'pool-proof-builder',
        actor: 'pool-worker',
        agents: ['./agents/pool-proof-builder.md', './agents/extra.md'],
        extensions: ['./extensions/trusted-bootstrap.ts'],
      }),
    );

    const launcher = createPoolProofPiLauncher({
      expectations,
      job: makeJob(),
      verifyPackageAndProfile: identity.verify,
    });

    const now = new Date();
    const launched = await launcher.launch({
      schema_version: 3,
      actor: 'pool-worker',
      node_id: 'single-worker-pool-proof',
      attempt_id: 'att://proof/single-worker-pool-proof/1',
      attempt_nonce: 'e'.repeat(64),
      issued_by: 'agent-pool-runtime',
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 179_000).toISOString(),
      max_age_seconds: 180,
      target_repo: 'fixture',
      target_branch: 'main',
      workspace_path: fixturePath,
      pi_runtime_parent: expectations.piRuntimeParent,
      pi_session_dir: expectations.piSessionDir,
      pi_executable_identity: {
        path: piPath,
        version: '0.84.1',
        digest: digestFile(piPath),
      },
      package_identity: {
        path: identity.packagePath,
        profile: 'pool-proof-builder',
        digest: identity.packageDigest,
      },
      profile_identity: {
        name: 'pool-proof-builder',
        path: identity.profilePath,
        digest: identity.profileDigest,
      },
      selected_model: 'openai-codex/gpt-5.6-terra',
      tool_grants: ['read', 'edit', 'write', 'bash', 'actor_identity'],
      result_destination: { kind: 'sqlite', id: 'result-1' },
    });

    assert.ok('code' in launched, 'launch must fail with an execution failure');
    assert.equal((launched as { code: string }).code, 'POOL_PROOF_LAUNCHER_MISMATCH');
  });

  it('rejects launch when profile declares a different extension', async (t) => {
    const runtimeRoot = createTestTempDir(t, 'launcher-');
    const fixturePath = createTestTempDir(t, 'fixture-');
    mkdirSync(join(fixturePath, 'src'), { recursive: true });
    const identity = makeIdentityDirs(runtimeRoot);
    const piPath = makeFakePiScript(runtimeRoot, { includePrompt: 'Attempt contract' });
    const expectations = makeExpectations(fixturePath, piPath, identity);

    writeFileSync(
      join(identity.profilePath, 'profile.json'),
      JSON.stringify({
        name: 'pool-proof-builder',
        actor: 'pool-worker',
        agents: ['./agents/pool-proof-builder.md'],
        extensions: ['./extensions/malicious.ts'],
      }),
    );

    const launcher = createPoolProofPiLauncher({
      expectations,
      job: makeJob(),
      verifyPackageAndProfile: identity.verify,
    });

    const now = new Date();
    const launched = await launcher.launch({
      schema_version: 3,
      actor: 'pool-worker',
      node_id: 'single-worker-pool-proof',
      attempt_id: 'att://proof/single-worker-pool-proof/1',
      attempt_nonce: 'f'.repeat(64),
      issued_by: 'agent-pool-runtime',
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 179_000).toISOString(),
      max_age_seconds: 180,
      target_repo: 'fixture',
      target_branch: 'main',
      workspace_path: fixturePath,
      pi_runtime_parent: expectations.piRuntimeParent,
      pi_session_dir: expectations.piSessionDir,
      pi_executable_identity: {
        path: piPath,
        version: '0.84.1',
        digest: digestFile(piPath),
      },
      package_identity: {
        path: identity.packagePath,
        profile: 'pool-proof-builder',
        digest: identity.packageDigest,
      },
      profile_identity: {
        name: 'pool-proof-builder',
        path: identity.profilePath,
        digest: identity.profileDigest,
      },
      selected_model: 'openai-codex/gpt-5.6-terra',
      tool_grants: ['read', 'edit', 'write', 'bash', 'actor_identity'],
      result_destination: { kind: 'sqlite', id: 'result-1' },
    });

    assert.ok('code' in launched, 'launch must fail with an execution failure');
    assert.equal((launched as { code: string }).code, 'POOL_PROOF_LAUNCHER_MISMATCH');
  });

  it('rejects launch when package or profile digest changes after preflight', async (t) => {
    const runtimeRoot = createTestTempDir(t, 'launcher-');
    const fixturePath = createTestTempDir(t, 'fixture-');
    mkdirSync(join(fixturePath, 'src'), { recursive: true });
    const identity = makeIdentityDirs(runtimeRoot);
    const piPath = makeFakePiScript(runtimeRoot, { includePrompt: 'Attempt contract' });
    const expectations = makeExpectations(fixturePath, piPath, identity);

    const launcher = createPoolProofPiLauncher({
      expectations,
      job: makeJob(),
      verifyPackageAndProfile: identity.verify,
    });

    // Mutate the package after expectations/digests were computed.
    writeFileSync(join(identity.packagePath, 'lib', 'broker.mjs'), 'export const mutated = true;');

    const now = new Date();
    const launched = await launcher.launch({
      schema_version: 3,
      actor: 'pool-worker',
      node_id: 'single-worker-pool-proof',
      attempt_id: 'att://proof/single-worker-pool-proof/1',
      attempt_nonce: 'd'.repeat(64),
      issued_by: 'agent-pool-runtime',
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 179_000).toISOString(),
      max_age_seconds: 180,
      target_repo: 'fixture',
      target_branch: 'main',
      workspace_path: fixturePath,
      pi_runtime_parent: expectations.piRuntimeParent,
      pi_session_dir: expectations.piSessionDir,
      pi_executable_identity: {
        path: piPath,
        version: '0.84.1',
        digest: digestFile(piPath),
      },
      package_identity: {
        path: identity.packagePath,
        profile: 'pool-proof-builder',
        digest: identity.packageDigest,
      },
      profile_identity: {
        name: 'pool-proof-builder',
        path: identity.profilePath,
        digest: identity.profileDigest,
      },
      selected_model: 'openai-codex/gpt-5.6-terra',
      tool_grants: ['read', 'edit', 'write', 'bash', 'actor_identity'],
      result_destination: { kind: 'sqlite', id: 'result-1' },
    });

    assert.ok('code' in launched, 'launch must fail with an execution failure');
    assert.equal((launched as { code: string }).code, 'POOL_PROOF_LAUNCHER_MISMATCH');
  });

  it('rejects launch when profile actor is not pool-worker', async (t) => {
    const runtimeRoot = createTestTempDir(t, 'launcher-');
    const fixturePath = createTestTempDir(t, 'fixture-');
    mkdirSync(join(fixturePath, 'src'), { recursive: true });
    const identity = makeIdentityDirs(runtimeRoot);
    const piPath = makeFakePiScript(runtimeRoot, { includePrompt: 'Attempt contract' });
    const expectations = makeExpectations(fixturePath, piPath, identity);

    writeFileSync(
      join(identity.profilePath, 'profile.json'),
      JSON.stringify({
        name: 'pool-proof-builder',
        actor: 'repository-builder',
        agents: ['./agents/pool-proof-builder.md'],
        extensions: ['./extensions/trusted-bootstrap.ts'],
      }),
    );

    const launcher = createPoolProofPiLauncher({ expectations, job: makeJob() });
    const launched = await launcher.launch(buildMarker(expectations));

    assert.ok('code' in launched, 'launch must fail with an execution failure');
    assert.equal((launched as { code: string }).code, 'POOL_PROOF_LAUNCHER_MISMATCH');
  });

  it('rejects launch when profile agent path is not the canonical builder agent', async (t) => {
    const runtimeRoot = createTestTempDir(t, 'launcher-');
    const fixturePath = createTestTempDir(t, 'fixture-');
    mkdirSync(join(fixturePath, 'src'), { recursive: true });
    const identity = makeIdentityDirs(runtimeRoot);
    const piPath = makeFakePiScript(runtimeRoot, { includePrompt: 'Attempt contract' });
    const expectations = makeExpectations(fixturePath, piPath, identity);

    writeFileSync(join(identity.profilePath, 'agents', 'other.md'), '---\nsystemPromptMode: replace\n---\n\nOther agent');
    writeFileSync(
      join(identity.profilePath, 'profile.json'),
      JSON.stringify({
        name: 'pool-proof-builder',
        actor: 'pool-worker',
        agents: ['./agents/other.md'],
        extensions: ['./extensions/trusted-bootstrap.ts'],
      }),
    );

    const launcher = createPoolProofPiLauncher({ expectations, job: makeJob() });
    const launched = await launcher.launch(buildMarker(expectations));

    assert.ok('code' in launched, 'launch must fail with an execution failure');
    assert.equal((launched as { code: string }).code, 'POOL_PROOF_LAUNCHER_MISMATCH');
  });

  it('rejects launch when agent declares an unsupported system prompt mode', async (t) => {
    const runtimeRoot = createTestTempDir(t, 'launcher-');
    const fixturePath = createTestTempDir(t, 'fixture-');
    mkdirSync(join(fixturePath, 'src'), { recursive: true });
    const identity = makeIdentityDirs(runtimeRoot);
    const piPath = makeFakePiScript(runtimeRoot, { includePrompt: 'Attempt contract' });
    const expectations = makeExpectations(fixturePath, piPath, identity);

    writeFileSync(
      join(identity.profilePath, 'agents', 'pool-proof-builder.md'),
      `---\nname: pool-proof-builder\nsystemPromptMode: prepend\n---\n\nYou are the pool-proof-builder Pool Worker agent.`,
    );

    const launcher = createPoolProofPiLauncher({ expectations, job: makeJob() });
    const launched = await launcher.launch(buildMarker(expectations));

    assert.ok('code' in launched, 'launch must fail with an execution failure');
    assert.equal((launched as { code: string }).code, 'POOL_PROOF_LAUNCHER_MISMATCH');
  });
});
