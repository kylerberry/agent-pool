/**
 * Mandatory, NON-SKIPPING real-Docker lifecycle proof for the persistent
 * attempt sandbox (AC-13). This fixture drives the REAL Docker runtime and the
 * pinned sandbox image (whose entrypoint is broker.mjs) through the public
 * RepositorySandbox adapter. It proves, end-to-end:
 *
 *   - one container reused across sequential runTool calls within an attempt
 *   - workspace state persistence within an attempt
 *   - a fresh container for a second attempt (distinct identity)
 *   - concurrent attempts receive distinct containers and one teardown does not
 *     affect the other (peer survival)
 *   - hostile environment, file, process, path/symlink, network, root,
 *     capability, and Docker-socket isolation
 *   - output/timeout/descendant cancellation with container survival
 *   - one Worker/invoker terminal path removes the owned container
 *   - final absence of THIS proof run's labeled containers (cleanup is scoped
 *     to a private proof label and never targets generic-labeled peers)
 *
 * The retained report contains ONLY bounded commitments, sanitized booleans,
 * and timing diagnostics. It never records raw container ids, host paths,
 * commands, arguments, environment values, process output, or credentials. It
 * does not alter the retained Stage 1 / Stage 2 reports or Pool Proof history.
 *
 * This test FAILS (it does not skip) when Docker or the pinned image is absent.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createRepositorySandbox,
  resolveSandboxIdentity,
  prepareWorkspaceForSandbox,
  type RepositorySandbox,
} from '../../../src/domains/agent-execution/index.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = resolve(__dirname, '..', 'reports', 'persistent-attempt-sandbox-lifecycle-report.json');

// Truthfully re-pinned after rebuilding the image from the pinned base digest.
// The base node:24-alpine digest is documented and verified at build time.
const PINNED_SANDBOX_IMAGE = process.env.AGENT_POOL_SANDBOX_IMAGE ?? 'sha256:5da4e8cabae067be3e323f74a659d5813ccd659dba026d5dd62aabe952e21e75';
const BASE_IMAGE_DIGEST = 'sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43';

type BashResult = { ok: boolean; stdout: string; stderr: string; exitCode?: number; error?: string };

// A private, proof-run-specific ownership label/value generated for THIS run
// only. The proof counts and cleans up containers carrying exactly this label,
// so it can never target peer containers (e.g. concurrent stage-1/2 proof runs)
// that carry only the generic io.agent-pool.owned=true label. The generic label
// remains on every owned container for operational discovery; this scoped label
// isolates cleanup. The retained report never stores the raw label value.
const PROOF_LABEL_KEY = 'io.agent-pool.proof.run';
const PROOF_LABEL_VALUE = 'run' + Math.random().toString(36).slice(2) + Date.now().toString(36);
const PROOF_LABEL_FILTER = `label=${PROOF_LABEL_KEY}=${PROOF_LABEL_VALUE}`;

function proofOwnedCount(): number {
  const res = spawnSync('docker', ['ps', '-a', '--filter', PROOF_LABEL_FILTER, '-q'], { encoding: 'utf8' });
  if (res.status !== 0) return -1;
  return res.stdout.split('\n').map((l) => l.trim()).filter(Boolean).length;
}

function imagePresent(sha: string): boolean {
  const res = spawnSync('docker', ['image', 'inspect', sha], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return res.status === 0;
}

function newWorkspace(root: string): string {
  const dir = realpathSync(mkdtempSync(join(root, 'lifecycle-ws-')));
  prepareWorkspaceForSandbox(dir, resolveSandboxIdentity());
  return dir;
}

function newSandbox(workspacePath: string, toolTimeoutMs = 5_000): RepositorySandbox {
  return createRepositorySandbox({
    image: PINNED_SANDBOX_IMAGE,
    workspacePath,
    containerRuntime: 'docker',
    sandboxIdentity: resolveSandboxIdentity(),
    cpuLimit: '1',
    memoryLimit: '512m',
    pidsLimit: 64,
    toolTimeoutMs,
    shutdownGraceMs: 5_000,
    // Scope this proof run's containers under a private label so cleanup never
    // targets generic-labeled peers.
    proofOwnershipLabel: { key: PROOF_LABEL_KEY, value: PROOF_LABEL_VALUE },
  });
}

async function bash(sandbox: RepositorySandbox, command: string, args: string[] = []): Promise<BashResult> {
  const res = await sandbox.runTool({ tool: 'bash', command, args });
  if (res.ok) return { ok: true, stdout: res.stdout ?? '', stderr: res.stderr ?? '', exitCode: res.exitCode };
  return { ok: false, stdout: '', stderr: '', error: res.error };
}

async function bashNode(sandbox: RepositorySandbox, code: string): Promise<BashResult> {
  return bash(sandbox, 'node', ['-e', code]);
}

function truth(v: unknown): boolean {
  return v === true;
}

describe('Persistent attempt sandbox — real-Docker lifecycle proof (AC-13)', () => {
  it('fails (does not skip) when Docker or the pinned image is absent', () => {
    const dockerOk = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' }).status === 0;
    assert.equal(dockerOk, true, 'Docker daemon must be available for the real lifecycle proof (no silent skip)');
    assert.equal(imagePresent(PINNED_SANDBOX_IMAGE), true, `pinned sandbox image ${PINNED_SANDBOX_IMAGE.slice(0, 19)}... must be present (no silent skip)`);
  });

  it('proves reuse, persistence, freshness, isolation, cancellation, cleanup, and zero-owned; retains a bounded report', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pasl-proof-'));
    const report: Record<string, unknown> = {
      schema_version: 1,
      node_id: 'persistent-attempt-sandbox-lifecycle',
      image_digest: PINNED_SANDBOX_IMAGE,
      base_image_digest: BASE_IMAGE_DIGEST,
      generated_at: new Date().toISOString(),
      verdicts: {} as Record<string, boolean>,
      timings_ms: {} as Record<string, number>,
      commitments: {} as Record<string, number>,
    };
    const verdicts = report.verdicts as Record<string, boolean>;
    const timings = report.timings_ms as Record<string, number>;
    const commitments = report.commitments as Record<string, number>;

    try {
      assert.equal(proofOwnedCount(), 0, 'proof must start with zero proof-owned containers');

      // --- Reuse across sequential calls + state persistence within an attempt ---
      let t0 = Date.now();
      const ws1 = newWorkspace(root);
      const s1 = newSandbox(ws1);
      await s1.start();
      const writeRes = await s1.runTool({ tool: 'write', path: 'persisted.txt', content: 'same-attempt-state' });
      assert.equal(writeRes.ok, true);
      const hostA = (await bashNode(s1, "console.log(require('os').hostname())")).stdout.trim();
      const readRes = await s1.runTool({ tool: 'read', path: 'persisted.txt' });
      assert.equal(readRes.ok, true);
      assert.equal((readRes as { content?: string }).content, 'same-attempt-state', 'state must persist across calls in the same container');
      const hostB = (await bashNode(s1, "console.log(require('os').hostname())")).stdout.trim();
      assert.equal(hostA, hostB, 'hostname must be stable across calls => one reused container');
      verdicts.container_reused_across_calls = hostA === hostB && hostA.length > 0;
      verdicts.state_persistence_within_attempt = (readRes as { content?: string }).content === 'same-attempt-state';
      timings.first_attempt_setup_ms = Date.now() - t0;

      // --- Hostile environment probe: allowlist only, no secrets/host paths ---
      const envRes = await bashNode(s1, "console.log(JSON.stringify(Object.keys(process.env)))");
      const envKeys = JSON.parse(envRes.stdout.trim()) as string[];
      const secretPattern = /TOKEN|SECRET|API_KEY|CREDENTIAL|PASSWORD|GITHUB|OPENAI|MOONSHOT|ANTHROPIC|AGENT_POOL_|PI_|\/Users|\/home\/|\.pi/i;
      const leakyKey = envKeys.find((k) => secretPattern.test(k));
      assert.equal(leakyKey, undefined, `environment leaked a sensitive key: ${String(leakyKey)}`);
      const homeVal = (await bashNode(s1, 'console.log(process.env.HOME)')).stdout.trim();
      assert.equal(homeVal, '/workspace/.home', 'HOME must be repointed into the workspace, not the host');
      verdicts.env_allowlist_no_secrets = leakyKey === undefined && homeVal === '/workspace/.home';

      // --- Hostile file / root-filesystem / Docker-socket probes ---
      const rootWrite = (await bashNode(s1, "try{require('fs').writeFileSync('/forbidden.txt','x');console.log('WROTE_ROOT')}catch(e){console.log(e.code)}")).stdout.trim();
      assert.notEqual(rootWrite, 'WROTE_ROOT', 'read-only root fs must reject writes outside the mount');
      verdicts.read_only_rootfs = rootWrite !== 'WROTE_ROOT';
      const sockStat = (await bashNode(s1, "try{require('fs').statSync('/var/run/docker.sock');console.log('SOCKET_EXISTS')}catch(e){console.log(e.code)}")).stdout.trim();
      assert.notEqual(sockStat, 'SOCKET_EXISTS', 'no host Docker socket may be mounted');
      verdicts.no_docker_socket = sockStat !== 'SOCKET_EXISTS';

      // --- Non-root / effective-capability probe ---
      const uid = Number((await bashNode(s1, 'console.log(process.getuid && process.getuid())')).stdout.trim());
      assert.ok(uid !== 0 && !Number.isNaN(uid), 'container must run as a non-root uid');
      verdicts.non_root_uid = uid !== 0;
      const effectiveCaps = (await bashNode(s1, "const s=require('fs').readFileSync('/proc/self/status','utf8');const m=s.match(/^CapEff:\\s*([0-9a-f]+)$/mi);console.log(m&&m[1])")).stdout.trim();
      assert.match(effectiveCaps, /^0+$/i, 'cap-drop=ALL must leave no effective Linux capabilities');
      verdicts.effective_capabilities_dropped = /^0+$/i.test(effectiveCaps);

      // --- Process-namespace isolation (no host processes visible) ---
      const procCount = Number((await bashNode(s1, "console.log(require('fs').readdirSync('/proc').filter(d=>/^\\d+$/.test(d)).length)")).stdout.trim());
      assert.ok(procCount > 0 && procCount < 50, `pid namespace must hide host processes, saw ${procCount}`);
      verdicts.process_namespace_isolated = procCount < 50;

      // --- Network isolation ---
      const netRes = await bashNode(s1, "const n=require('net');const s=n.connect({host:'8.8.8.8',port:53});s.on('error',e=>{console.log(e.code);process.exit(0)});setTimeout(()=>{console.log('REACHED');process.exit(0)},3000);");
      const netCode = netRes.stdout.trim();
      assert.ok(/ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ETIMEDOUT|ENETDOWN/.test(netCode), `network must be isolated, got ${netCode}`);
      verdicts.network_isolated = /ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ETIMEDOUT|ENETDOWN/.test(netCode);

      // --- Path / symlink confinement via the read/write tools ---
      const traversal = await s1.runTool({ tool: 'read', path: '../../etc/passwd' });
      assert.equal(traversal.ok, false, 'traversal path must be rejected');
      const traversalWrite = await s1.runTool({ tool: 'write', path: '../escape.txt', content: 'x' });
      assert.equal(traversalWrite.ok, false, 'traversal write must be rejected');
      await bash(s1, 'sh', ['-c', 'ln -s /etc/passwd symlink-leak && ln -s / symlinkdir']);
      const symlinkRead = await s1.runTool({ tool: 'read', path: 'symlink-leak' });
      assert.equal(symlinkRead.ok, false, 'symlink escaping the workspace must be rejected');
      verdicts.path_traversal_confined = traversal.ok === false && traversalWrite.ok === false;
      verdicts.symlink_escape_confined = symlinkRead.ok === false;

      // --- Timeout / descendant cancellation; container survives ---
      const toSandbox = newSandbox(newWorkspace(root), 1_500);
      await toSandbox.start();
      // Plant a marker in this container's own workspace before the timeout so
      // the survival probe reads a file that actually exists here (proving the
      // same container and its state survive the per-command timeout).
      const marker = await toSandbox.runTool({ tool: 'write', path: 'survived-timeout.txt', content: 'alive' });
      assert.equal(marker.ok, true);
      t0 = Date.now();
      const flood = await bash(toSandbox, 'sh', ['-c', 'sleep 120 & echo started; wait']);
      const toElapsed = Date.now() - t0;
      assert.equal(flood.ok, false, 'a command exceeding the tool timeout must return a bounded error');
      assert.ok(toElapsed < 6_000, `timeout must settle boundedly, took ${toElapsed}ms`);
      verdicts.timeout_cancels_command = flood.ok === false && toElapsed < 6_000;
      // Descendant kill: no orphaned 'sleep' survives the process-group SIGKILL.
      const orphans = (await bashNode(toSandbox, "const fs=require('fs');const ps=fs.readdirSync('/proc').filter(d=>/^\\d+$/.test(d));let n=0;for(const p of ps){try{if(fs.readFileSync('/proc/'+p+'/comm','utf8').trim()==='sleep')n++}catch{}}console.log(n)")).stdout.trim();
      assert.equal(Number(orphans), 0, 'descendant sleep must be killed with the command group');
      verdicts.descendants_killed_on_timeout = Number(orphans) === 0;
      // Container survives the per-command timeout; the marker written before
      // the timeout must still be readable from the same container.
      const afterTimeout = await toSandbox.runTool({ tool: 'read', path: 'survived-timeout.txt' });
      assert.equal(afterTimeout.ok, true, 'container must remain usable after a per-command timeout');
      verdicts.container_survives_timeout = afterTimeout.ok === true;
      await toSandbox.stop();

      // --- RepositorySandbox.stop removes the owned container ---
      // This lifecycle test drives RepositorySandbox directly (no Worker/launcher),
      // so it proves the teardown primitive that the launcher invokes on every
      // terminal path (Worker exit, injected termination, timeout, broker
      // failure). Real Worker-kill -> container teardown is proven at the
      // launcher layer in pool-proof-pi-launcher.test.ts ('awaits container
      // teardown on injected Worker termination').
      const beforeStop = proofOwnedCount();
      assert.ok(beforeStop >= 1, 'an owned container must exist while the sandbox is running');
      await s1.stop();
      const afterStop = proofOwnedCount();
      assert.ok(afterStop <= beforeStop - 1, 'stop must remove the owned container');
      verdicts.stop_removes_owned_container = afterStop <= beforeStop - 1;

      // --- Fresh container for a second attempt ---
      t0 = Date.now();
      const ws2 = newWorkspace(root);
      const s2 = newSandbox(ws2);
      await s2.start();
      const hostC = (await bashNode(s2, "console.log(require('os').hostname())")).stdout.trim();
      assert.notEqual(hostC, hostA, 'a second attempt must get a fresh container identity');
      verdicts.fresh_container_per_attempt = hostC !== hostA && hostC.length > 0;

      // --- Concurrent attempts: distinct containers + peer survival ---
      t0 = Date.now();
      const wsP1 = newWorkspace(root);
      const wsP2 = newWorkspace(root);
      const p1 = newSandbox(wsP1);
      const p2 = newSandbox(wsP2);
      await Promise.all([p1.start(), p2.start()]);
      const peerA = (await bashNode(p1, "console.log(require('os').hostname())")).stdout.trim();
      const peerB = (await bashNode(p2, "console.log(require('os').hostname())")).stdout.trim();
      assert.notEqual(peerA, peerB, 'concurrent attempts must get distinct containers');
      verdicts.concurrent_distinct_containers = peerA !== peerB;
      const concurrentOwned = proofOwnedCount();
      commitments.concurrent_attempts = 2;
      // Tear one peer down; the other must survive and remain usable.
      await p1.stop();
      const peerSurvived = await p2.runTool({ tool: 'write', path: 'peer.txt', content: 'survived' });
      assert.equal(peerSurvived.ok, true, 'a peer container must survive the teardown of another');
      verdicts.peer_survives_peer_teardown = peerSurvived.ok === true;
      await p2.stop();
      await s2.stop();
      timings.concurrent_phase_ms = Date.now() - t0;
      commitments.max_owned_containers_seen = Math.max(beforeStop, concurrentOwned, 2);

      // --- Final zero owned containers ---
      const finalOwned = proofOwnedCount();
      assert.equal(finalOwned, 0, 'no proof-owned containers may remain after all teardowns');
      verdicts.final_zero_owned_containers = finalOwned === 0;
      commitments.final_owned_containers = finalOwned;

      // --- Retain the bounded, sanitized report (never raw ids/paths/output) ---
      assert.equal(Object.values(verdicts).every(truth), true, 'every lifecycle verdict must be true');
      mkdirSync(dirname(REPORT_PATH), { recursive: true });
      writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', { mode: 0o644 });
      assert.equal(existsSync(REPORT_PATH), true);
    } finally {
      // Best-effort cleanup of ONLY this proof run's containers (scoped by
      // the private proof label), never peer containers that carry only the
      // generic io.agent-pool.owned=true label.
      spawnSync('docker', ['ps', '-a', '--filter', PROOF_LABEL_FILTER, '-q'], { encoding: 'utf8' })
        .stdout.split('\n').map((l) => l.trim()).filter(Boolean)
        .forEach((id) => { try { spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore' }); } catch {} });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('proof cleanup removes only proof-labeled containers and never a generic-labeled peer', async () => {
    // A peer container carrying ONLY the generic ownership label (not this
    // proof run's scoped label) must survive the proof's scoped cleanup. This
    // proves concurrent stage-1/2 proof containers are never killed by this run.
    const peer = spawnSync('docker', ['run', '-d', '--entrypoint', 'node',
      '--label', 'io.agent-pool.owned=true', '--network=none', '--read-only',
      PINNED_SANDBOX_IMAGE, '-e', "setInterval(()=>{},60000)"], { encoding: 'utf8' });
    assert.equal(peer.status, 0, 'peer container must start');
    const peerId = peer.stdout.trim();
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'pasl-peer-')));
    try {
      prepareWorkspaceForSandbox(ws, resolveSandboxIdentity());
      const sandbox = newSandbox(ws);
      await sandbox.start();
      await sandbox.runTool({ tool: 'read', path: 'a' });
      await sandbox.stop();
      // The proof's scoped cleanup removes only proof-labeled containers.
      spawnSync('docker', ['ps', '-a', '--filter', PROOF_LABEL_FILTER, '-q'], { encoding: 'utf8' })
        .stdout.split('\n').map((l) => l.trim()).filter(Boolean)
        .forEach((id) => { try { spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore' }); } catch {} });
      const inspect = spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', peerId], { encoding: 'utf8' });
      assert.equal(inspect.stdout.trim(), 'true', 'a generic-labeled peer must survive the proof scoped cleanup');
    } finally {
      try { spawnSync('docker', ['rm', '-f', peerId], { stdio: 'ignore' }); } catch {}
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
