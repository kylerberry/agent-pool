/** Stage 2 proof report builder and strict defense-in-depth validator. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isApprovedModelId } from '../../../src/domains/model-routing-and-evaluation/approved-models.ts';
import { COMMITMENT_FIELDS, attemptBindingHash as bind, canonicalize, type IsolationCommitments } from './stage-2-isolation.ts';
// @ts-expect-error worker-harness JSON schema validator has no type declarations
import { validateInstance } from '../../worker-harness/lib/json-schema-subset.mjs';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(readFileSync(join(packageRoot, 'contracts', 'stage-2-proof-report.schema.json'), 'utf8')) as Record<string, unknown>;

export type Stage2AttemptReport = { readonly attempt_id: string; readonly node_id: string; readonly slot_index: number; readonly status: 'passed' | 'failed'; readonly builder_model: string; readonly commit_sha: string | null; readonly failure_code: string | null; readonly verifier_checks: readonly { readonly name: string; readonly passed: boolean }[]; readonly isolation: IsolationCommitments & { readonly attempt_binding_hash: string } };
export type Stage2ProofReport = { readonly schema_version: 3; readonly stage1_provenance: { readonly report_path: string; readonly report_sha256: string; readonly model: string; readonly base_commit: string; readonly result_commit: string }; readonly slot_count: 2; readonly attempts: readonly Stage2AttemptReport[]; readonly deferred_work: readonly string[]; readonly next_follow_up: string; readonly diagnostics: { readonly started_at: string; readonly finished_at: string; readonly timing_points: readonly { readonly label: string; readonly timestamp: string }[] }; readonly cleanup_disposition: { readonly workspace_removed: boolean; readonly session_removed: boolean }; readonly residual_warning: string };
const REQUIRED_DEFERRALS = ['free-form decomposition and Gate 1','predicted-touch and Graphify scheduling','full DAG retry/budget/reconciliation/branch policy','Tier-2 evaluation and builder calibration','full CRAFTS and revision-history activation','integration and GitHub delivery/webhooks','full backup/restore/operational audit work'];
export function attemptBindingHash(attempt: Pick<Stage2AttemptReport, 'attempt_id'|'node_id'|'status'|'commit_sha'|'isolation'>): string { const { attempt_binding_hash: _discard, ...commitments } = attempt.isolation; return bind({ attemptId: attempt.attempt_id, nodeId: attempt.node_id, status: attempt.status, commitSha: attempt.commit_sha, commitments }); }
export function sha256File(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function is40(value: string): boolean { return /^[0-9a-f]{40}$/.test(value); }
export function validateStage2Report(report: unknown): { ok: true } | { ok: false; error: string } {
 const schemaErrors = validateInstance(schema, report); if (schemaErrors.length) return { ok:false, error:`schema validation failed: ${schemaErrors.join('; ')}` }; const obj=report as Stage2ProofReport;
 if (!isApprovedModelId(obj.stage1_provenance.model)) return {ok:false,error:'stage1_provenance.model is not an approved builder model'};
 if (obj.attempts.length!==3) return {ok:false,error:'report must contain exactly three attempts'};
 const attempts=new Set<string>(), nodes=new Set<string>(), commits=new Set<string>(), slots=new Set<number>(); let passed=0, failed=0;
 const seen=new Map<string,Set<string>>(COMMITMENT_FIELDS.map(f=>[f,new Set<string>()]));
 for(const a of obj.attempts) { if(attempts.has(a.attempt_id)||nodes.has(a.node_id)) return {ok:false,error:'duplicate attempt or node identity'}; attempts.add(a.attempt_id); nodes.add(a.node_id); slots.add(a.slot_index); if(!isApprovedModelId(a.builder_model))return {ok:false,error:`attempt ${a.attempt_id} uses unapproved builder model`};
  for(const f of COMMITMENT_FIELDS){const v=a.isolation[f];if(!/^[0-9a-f]{64}$/.test(v))return {ok:false,error:`attempt ${a.attempt_id} has invalid ${f}`}; if(seen.get(f)!.has(v))return {ok:false,error:`duplicate ${f}`};seen.get(f)!.add(v)}
  if(a.isolation.attempt_binding_hash!==attemptBindingHash(a))return {ok:false,error:`attempt ${a.attempt_id} has invalid attempt_binding_hash`};
  if(a.status==='passed'){passed++;if(a.failure_code!==null||a.commit_sha===null||!is40(a.commit_sha)||commits.has(a.commit_sha)||!a.verifier_checks.length||!a.verifier_checks.every(c=>c.passed))return {ok:false,error:`passed attempt ${a.attempt_id} has invalid result`};commits.add(a.commit_sha)} else {failed++;if(a.commit_sha!==null||a.failure_code!=='INJECTED_WORKER_FAILURE'||a.verifier_checks.every(c=>c.passed))return {ok:false,error:`failed attempt ${a.attempt_id} has invalid result`}}
 }
 if(passed!==2||failed!==1||slots.size!==2||!slots.has(0)||!slots.has(1))return {ok:false,error:'attempt outcome or slot algebra invalid'};
 if(!REQUIRED_DEFERRALS.every(d=>obj.deferred_work.some(x=>x.toLowerCase().includes(d.toLowerCase()))))return {ok:false,error:'missing required deferral'};
 if(!obj.next_follow_up.toLowerCase().includes('agent-pool dogfood')||/\b(complete|completed|done|finished|gate\s*1\s+passed|bypass)\b/i.test(obj.next_follow_up))return {ok:false,error:'next_follow_up is invalid'};
 if(!obj.cleanup_disposition.workspace_removed||!obj.cleanup_disposition.session_removed)return {ok:false,error:'cleanup_disposition incomplete'};
 if(!Number.isFinite(new Date(obj.diagnostics.started_at).getTime())||new Date(obj.diagnostics.finished_at)<new Date(obj.diagnostics.started_at))return {ok:false,error:'diagnostics timestamps are incoherent'}; return {ok:true};
}
export function buildStage2Report(input: { readonly stage1Provenance: Stage2ProofReport['stage1_provenance']; readonly attempts: readonly Stage2AttemptReport[]; readonly timingPoints: readonly {readonly label:string;readonly timestamp:Date}[]; readonly cleanupDisposition:{readonly workspaceRemoved:boolean;readonly sessionRemoved:boolean};readonly startedAt:Date;readonly finishedAt:Date }):Stage2ProofReport{return {schema_version:3,stage1_provenance:input.stage1Provenance,slot_count:2,attempts:input.attempts,deferred_work:REQUIRED_DEFERRALS,next_follow_up:'Run one separately reviewed agent-pool dogfood task through the same Minimal Pool Runtime.',diagnostics:{started_at:input.startedAt.toISOString(),finished_at:input.finishedAt.toISOString(),timing_points:input.timingPoints.map(t=>({label:t.label,timestamp:t.timestamp.toISOString()}))},cleanup_disposition:{workspace_removed:input.cleanupDisposition.workspaceRemoved,session_removed:input.cleanupDisposition.sessionRemoved},residual_warning:'This controlled fixture proof is not production authorization for arbitrary repositories.'};}
export { canonicalize };
