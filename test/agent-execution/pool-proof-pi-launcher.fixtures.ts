import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createFakePersistentContainerDriver,
  createPoolProofPiLauncher,
  type FakeContainerDriver,
  type PackageProfileVerifier,
  type PoolProofLaunchExpectations,
  type ProofJob,
} from '../../src/domains/agent-execution/index.ts';

export function makeJob(): ProofJob {
  return {
    nodeId: 'single-worker-pool-proof',
    attemptId: 'att://proof/single-worker-pool-proof/1',
    attemptNumber: 1,
    intent: 'test',
    changeSpec: 'test',
    acceptanceCriteria: [{ id: 'c1', text: 'test' }],
    criteriaOriginSource: 'direct_task',
    criteriaOriginSourceId: 'test',
    targetRepo: 'fixture',
    targetBranch: 'main',
    allowedChangedPaths: ['src/message.js'],
    fixtureTestCommand: ['node', '--test', 'test/message.test.js'],
  };
}

export function digestFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function digestDirectory(dir: string): string {
  const hash = createHash('sha256');
  const entries = readdirSync(dir).sort();
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      hash.update(`dir:${entry}\n`);
      hash.update(digestDirectory(full));
    } else {
      hash.update(`file:${entry}\n`);
      hash.update(readFileSync(full));
    }
  }
  return hash.digest('hex');
}

export type IdentityDirs = {
  packagePath: string;
  profilePath: string;
  packageDigest: string;
  profileDigest: string;
  verify: PackageProfileVerifier;
};

export function makeIdentityDirs(runtimeRoot: string): IdentityDirs {
  const packagePath = join(runtimeRoot, 'pkg');
  const profilePath = join(runtimeRoot, 'profile');
  mkdirSync(join(packagePath, 'lib'), { recursive: true });
  mkdirSync(join(profilePath, 'extensions'), { recursive: true });
  mkdirSync(join(profilePath, 'agents'), { recursive: true });
  writeFileSync(join(packagePath, 'package.json'), JSON.stringify({ name: 'agent-pool-worker-harness' }));
  writeFileSync(join(packagePath, 'lib', 'broker.mjs'), 'export default function broker() {}');
  writeFileSync(
    join(profilePath, 'profile.json'),
    JSON.stringify({
      name: 'pool-proof-builder',
      actor: 'pool-worker',
      agents: ['./agents/pool-proof-builder.md'],
      extensions: ['./extensions/trusted-bootstrap.ts'],
    }),
  );
  writeFileSync(
    join(profilePath, 'agents', 'pool-proof-builder.md'),
    `---\nname: pool-proof-builder\nsystemPromptMode: replace\n---\n\nYou are the pool-proof-builder Pool Worker agent.`,
  );
  writeFileSync(join(profilePath, 'extensions', 'trusted-bootstrap.ts'), 'export default function bootstrap() {}');

  const packageDigest = digestDirectory(packagePath);
  const profileDigest = digestDirectory(profilePath);

  return {
    packagePath,
    profilePath,
    packageDigest,
    profileDigest,
    verify: (_pkgPath: string, expectedPkgDigest: string, _profilePath: string, expectedProfileDigest: string) =>
      digestDirectory(packagePath) === expectedPkgDigest && digestDirectory(profilePath) === expectedProfileDigest,
  };
}

export function buildMarker(expectations: PoolProofLaunchExpectations): Record<string, unknown> {
  const now = new Date();
  return {
    schema_version: 3,
    actor: 'pool-worker',
    node_id: expectations.nodeId,
    attempt_id: expectations.attemptId,
    attempt_nonce: 'a'.repeat(64),
    issued_by: 'agent-pool-runtime',
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 179_000).toISOString(),
    max_age_seconds: 180,
    target_repo: expectations.targetRepo,
    target_branch: expectations.targetBranch,
    workspace_path: expectations.workspacePath,
    pi_runtime_parent: expectations.piRuntimeParent,
    pi_session_dir: expectations.piSessionDir,
    pi_executable_identity: {
      path: expectations.piExecutablePath,
      version: expectations.piExecutableVersion,
      digest: expectations.piExecutableDigest,
    },
    package_identity: {
      path: expectations.packagePath,
      profile: expectations.packageProfile,
      digest: expectations.packageDigest,
    },
    profile_identity: {
      name: expectations.profileName,
      path: expectations.profilePath,
      digest: expectations.profileDigest,
    },
    selected_model: expectations.selectedModel,
    tool_grants: expectations.toolGrants,
    result_destination: { kind: 'sqlite', id: expectations.resultDestinationId },
  };
}

export function makeExpectations(workspacePath: string, piPath: string, identity: IdentityDirs): PoolProofLaunchExpectations {
  return {
    nodeId: 'single-worker-pool-proof',
    attemptId: 'att://proof/single-worker-pool-proof/1',
    targetRepo: 'fixture',
    targetBranch: 'main',
    workspacePath,
    piRuntimeParent: join(workspacePath, '.pi-runtime'),
    piSessionDir: join(workspacePath, '.pi-runtime', 'session'),
    piExecutablePath: piPath,
    piExecutableVersion: '0.84.1',
    piExecutableDigest: digestFile(piPath),
    packagePath: identity.packagePath,
    packageProfile: 'pool-proof-builder',
    packageDigest: identity.packageDigest,
    profileName: 'pool-proof-builder',
    profilePath: identity.profilePath,
    profileDigest: identity.profileDigest,
    selectedModel: 'openai-codex/gpt-5.6-terra',
    toolGrants: ['read', 'edit', 'write', 'bash', 'actor_identity'],
    resultDestinationId: 'result-1',
  };
}

export function makeFakePiScript(runtimeRoot: string, options: { rejectFlag?: string; timeoutMs?: number; includePrompt?: string; captureArtifacts?: boolean }): string {
  const script = join(runtimeRoot, 'fake-pi');
  const nodePath = process.execPath;
  const code = `#!${nodePath}
const args = process.argv.slice(2);
const allowed = new Set(['--mode', '--print', '--no-builtin-tools', '--tools', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-extensions', '-e', '--model', '--session-dir', '--system-prompt', '--append-system-prompt']);
// The last argument is the task prompt; do not validate it as a flag.
const flagArgs = args.slice(0, args.length - 1);
for (let i = 0; i < flagArgs.length; i++) {
  const arg = flagArgs[i];
  if (arg === '--mode' || arg === '--tools' || arg === '-e' || arg === '--model' || arg === '--session-dir' || arg === '--system-prompt' || arg === '--append-system-prompt') { i++; continue; }
  if (arg && !allowed.has(arg)) {
    console.error('unknown flag: ' + arg);
    process.exit(2);
  }
}
if (!flagArgs.includes('--mode') || !flagArgs.includes('--print') || !flagArgs.includes('--no-builtin-tools')) {
  console.error('missing required flags');
  process.exit(2);
}
const prompt = args[args.length - 1];
if (!prompt || !prompt.includes('${options.includePrompt ?? 'Attempt contract'}')) {
  console.error('prompt not received');
  process.exit(3);
}
${options.captureArtifacts ? `const fs = require('node:fs');
const contextJson = fs.readFileSync(process.env.AGENT_POOL_EXECUTION_CONTEXT, 'utf8');
const contextDir = require('node:path').dirname(process.env.AGENT_POOL_EXECUTION_CONTEXT);
const contractJson = fs.readFileSync(require('node:path').join(contextDir, 'attempt-contract.json'), 'utf8');
const actorIdentityJson = fs.readFileSync(process.env.AGENT_POOL_ACTOR_IDENTITY, 'utf8');
console.log(JSON.stringify({ done: true, prompt, contextJson, contractJson, actorIdentityJson })); process.exit(0);` : options.timeoutMs ? `setTimeout(() => { console.log(JSON.stringify({ done: true })); process.exit(0); }, ${options.timeoutMs});` : `console.log(JSON.stringify({ done: true })); process.exit(0);`}
`;
  writeFileSync(script, code, { mode: 0o700 });
  return script;
}

export function makeFakePiAuthDumpScript(runtimeRoot: string): string {
  const piPath = join(runtimeRoot, 'fake-pi-auth-dump');
  writeFileSync(
    piPath,
    `#!${process.execPath}
const fs = require('fs');
const home = process.env.HOME;
const authPath = require('path').join(home, 'auth.json');
let auth = {};
try { auth = JSON.parse(fs.readFileSync(authPath, 'utf8')); } catch {}
console.log(JSON.stringify({ done: true, auth }));
process.exit(0);
`,
    { mode: 0o700 },
  );
  return piPath;
}

export function makeFakePiPromptDumpScript(runtimeRoot: string): string {
  const piPath = join(runtimeRoot, 'fake-pi-prompt-dump');
  writeFileSync(
    piPath,
    `#!${process.execPath}
const args = process.argv.slice(2);
const systemIdx = args.indexOf('--system-prompt');
const userPrompt = args[args.length - 1];
console.log(JSON.stringify({
  done: true,
  hasSystemPrompt: systemIdx >= 0,
  systemPrompt: systemIdx >= 0 ? args[systemIdx + 1] : null,
  userPrompt,
}));
process.exit(0);
`,
    { mode: 0o700 },
  );
  return piPath;
}

export function makeFakePiIdentityCapsuleDumpScript(runtimeRoot: string): string {
  const piPath = join(runtimeRoot, 'fake-pi-prompt-dump');
  writeFileSync(
    piPath,
    `#!${process.execPath}
const args = process.argv.slice(2);
const systemIdx = args.indexOf('--system-prompt');
console.log(JSON.stringify({
  done: true,
  systemPrompt: systemIdx >= 0 ? args[systemIdx + 1] : null,
}));
process.exit(0);
`,
    { mode: 0o700 },
  );
  return piPath;
}

export function hostIdentity() {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
    throw new Error('uid/gid required for sandbox identity');
  }
  return { uid: process.getuid(), gid: process.getgid(), isPinned: false };
}

export function brokerSetup(runtimeRoot: string): { driver: FakeContainerDriver; workspacePath: string; socketPath: string } {
  const workspacePath = realpathSync(mkdtempSync(join(runtimeRoot, 'ws-')));
  const socketPath = join(runtimeRoot, `broker-${Math.random().toString(36).slice(2)}.sock`);
  const driver = createFakePersistentContainerDriver();
  return { driver, workspacePath, socketPath };
}

export function writeExitPi(runtimeRoot: string, exitCode: number): string {
  const script = join(runtimeRoot, `pi-exit-${exitCode}`);
  writeFileSync(
    script,
    `#!${process.execPath}
console.log(JSON.stringify({ done: true }));
process.exit(${exitCode});
`,
    { mode: 0o700 },
  );
  return script;
}

export function makeBrokerLauncher(opts: {
  runtimeRoot: string;
  driver: FakeContainerDriver;
  workspacePath: string;
  socketPath: string;
  piPath: string;
  identity: IdentityDirs;
  timeoutMs?: number;
  injectFault?: boolean;
}) {
  const expectations = makeExpectations(opts.workspacePath, opts.piPath, opts.identity);
  return createPoolProofPiLauncher({
    expectations,
    job: makeJob(),
    verifyPackageAndProfile: opts.identity.verify,
    timeoutMs: opts.timeoutMs,
    injectFaultForAttemptId: opts.injectFault ? expectations.attemptId : undefined,
    brokerOptions: {
      socketPath: opts.socketPath,
      workspacePath: opts.workspacePath,
      containerRuntime: 'docker',
      image: 'sha256:' + 'a'.repeat(64),
      sandboxIdentity: hostIdentity(),
      cpuLimit: '1',
      memoryLimit: '512m',
      pidsLimit: 64,
      driver: opts.driver,
    },
  });
}
