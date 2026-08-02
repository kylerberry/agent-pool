# T — Tighten: `work-contracts-direct-intake`

**Scope:** diff `2531624..HEAD` on `slice/work-contracts-direct-intake`, limited to `src/domains/work-intake/`.
**Date:** 2026-08-01
**Reviewer independence:** **NOT MET.** See "Independence gap" below. This is a self-review by the implementing agent.

## Trust boundaries

C declared four boundaries for this slice. Each gets evidence, a finding, or explicit non-applicability.

### 1. Caller-supplied JSON body (untrusted, arbitrary shape and size)

**Spoofing / Tampering.** Every field is own-property read via `own()` after `isPlainObject` requires `Object.prototype` or a null prototype (`unit-validation.ts`). An object with populated prototype and no own keys previously passed validation with nothing examined; that path is closed and tested.

Unknown fields are rejected rather than ignored, including the ADR-018 exclusions (`status`, `retry_count`, `budget_spent`, `required_role`, `complexity`) and the prototype-pollution key names. `JSON.parse` materializes `__proto__` as an own data property, so it is caught by the unknown-field scan without altering any prototype — asserted directly.

**Denial of service — FINDING (fixed this phase).** Per-field limits multiplied: 500 units x 100 criteria x 4,000 chars = a ~211MB submission satisfying every individual limit, then canonicalized (a full copy), hashed, deep-frozen, and retained. Added `INTAKE_LIMITS.maxTotalContentChars` (1,000,000), checked after shape validation and **before** canonicalization so an oversized payload is never copied.

Remaining bounded: violation lists sorted then capped at 100; echoed key names truncated to 64 chars; `canonicalize` depth-limited to 32; Kahn's is linear in nodes plus edges with `depends_on` capped per unit; `REPO_PATTERN`/`BRANCH_PATTERN` probed for catastrophic backtracking (sub-ms on 5,000-char adversarial input against a 400-char cap).

**Not mitigated here — out of scope.** Total *request* size and connection-level rate limiting belong to the HTTP server and controller, not this domain. The body arrives already parsed. Flag for whoever composes the real server.

### 2. Idempotency key and caller identity

**Elevation of privilege / spoofing.** `caller_id` comes only from the injected `authenticate()` result, never the body — `caller_id` in a body is an unknown-field rejection. Asserted, including that a caller-set header cannot influence recorded provenance.

Scope components are length-prefixed (`idempotencyScopeKey`), so no crafted caller id and key can collide with a different pair. Tested with an adjacent-boundary payload.

**Ordering.** Key validation, then payload validation, then the stored-hash comparison. A malformed body is rejected on its own merits and never recorded, so a caller cannot burn their own key with a bad payload — and cannot probe the store with an invalid body.

**Denial of service — FINDING (fixed this phase).** `InMemoryIdempotencyStore` was unbounded and never evicted; combined with boundary 1, a caller could exhaust process memory. Now bounded and **fail-closed**: it throws `IdempotencyCapacityExceededError` rather than evicting, because eviction silently breaks the guarantee the store exists to provide — a replay after eviction re-executes as a fresh submission. The durable SQLite store must not evict either.

### 3. `repo` / `branch` flowing toward downstream git operations

Conservative allowlists reject shell metacharacters, whitespace, leading `-` (argument injection, e.g. `--upload-pack=`), `..` traversal, `//`, and dot-only path components. Validated at intake rather than relied upon downstream.

**Explicitly not a complete git-ref validator.** Integration and Delivery owns the actual git invocation and must not pass these to a shell. These patterns may be narrowed there; they should not need widening. **Integration seam — confirm against that slice.**

### 4. Error responses echoing caller-controlled key names

**Information disclosure.** Violation paths include caller-supplied key names, truncated to 64 chars and capped at 100 violations, so responses cannot be amplified beyond the request. Bodies are JSON-encoded, so echoed content is data, not markup or injection.

Status distinctions (202 new / 200 replay / 409 mismatch) reveal only the *caller's own* prior key use, because the scope is caller-partitioned. No cross-caller existence oracle. No credentials, internal ids, or stack traces appear in any rejection.

## Non-applicable to this slice

- **Authentication mechanics** (token format, expiry, rotation) — `authenticate()` is injected; the pool bearer scheme lives outside the domain.
- **Audit logging of rejections** — the audit trail is controller-owned (ADR-014).
- **Secrets management** — this domain holds no credentials by design, confirmed by the boundary test forbidding cross-domain imports.
- **SQL injection / XSS / SSRF** — no database, no rendering, no outbound fetch; the module-graph test proves nothing outside the domain and Node builtins is reachable.

## Independence gap

CRAFTS requires T to run on a different model from the implementer. Two dispatches to the Codex-backed reviewer failed: the first hung ~14 hours mid-review with no findings; the second died at thread startup. The A phase did complete on that model and its security-relevant findings (prototype bypass, unbounded violation list) are fixed and tested.

**This T artifact is therefore self-review and should be treated as unverified by the integration owner.** The two findings above were found and fixed by the implementing agent, which is exactly the arrangement T exists to avoid relying on.

## Verification

`npm run typecheck` PASS; `npm test` 272/272; `npm run test:worker` 18/18.
