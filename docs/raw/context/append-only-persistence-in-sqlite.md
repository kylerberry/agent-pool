---
title: Append-Only Persistence in SQLite
audience: repository-builder
subject: product-runtime
created: 2026-08-03
---

# Append-Only Persistence in SQLite

Canonical technical constraints for any table in this system that must be
append-only. Established during `attempt-provenance-store` attempt-1, where a
working bypass was found against a table that already carried both of the
obvious guards.

## The guarantee we need

Builder routing — the model actually selected at dispatch — is reusable now.
Phase-artifact history is latent until runtime CRAFTS persists artifacts.
Evaluator-execution provenance and Tier-2 independence are deliberately deferred:
they must be recorded when an evaluator actually runs, never inferred from
builder dispatch. If a recorded `needs_fix` outcome can be rewritten to `passed`,
independent evaluation is theatre. "No row is ever updated or deleted" must hold
against any writer, not merely against the code paths we happen to have written.

## `BEFORE UPDATE` and `BEFORE DELETE` triggers are not sufficient

`INSERT OR REPLACE` resolves a uniqueness conflict by deleting the conflicting
row and inserting the replacement. SQLite fires `BEFORE DELETE` for that implicit
delete **only when `recursive_triggers` is enabled**, and it is off by default.

Demonstrated against a table carrying both `BEFORE UPDATE` and `BEFORE DELETE`
`RAISE(ABORT)` triggers: `INSERT OR REPLACE` succeeded and changed a row's status
from `needs_fix` to `passed` with neither trigger firing. `ON CONFLICT DO UPDATE`
and plain `UPDATE` were correctly blocked, so the gap is specific to REPLACE
semantics rather than a general trigger failure.

## `PRAGMA recursive_triggers` cannot carry the guarantee

Enabling `recursive_triggers` on the store connection does close the bypass *for
that connection*. It is not a fix, because the pragma is per-connection: it
constrains only connections the store opens — which never issue REPLACE — while
every other writer inherits the default of off.

This was caught by mutation testing. With the pragma removed the whole suite
stayed green, proving it was never the protection.

**Rule:** an invariant that must hold against all writers belongs in the schema.
Connection-level settings are defence in depth at best.

## The guard that works

A `BEFORE INSERT` conflict guard, because REPLACE is still an INSERT:

```sql
CREATE TRIGGER trg_phase_artifacts_no_replace
BEFORE INSERT ON phase_artifacts
WHEN EXISTS (
  SELECT 1 FROM phase_artifacts
  WHERE attempt_id = NEW.attempt_id AND phase = NEW.phase AND revision = NEW.revision
)
BEGIN SELECT RAISE(ABORT, 'phase_artifacts is append-only'); END;
```

Verified against a connection using default pragmas: `INSERT OR REPLACE`,
duplicate `INSERT`, and `DELETE` are all refused while a normal append succeeds.

An append-only table therefore needs all three: `BEFORE UPDATE`, `BEFORE DELETE`,
and a `BEFORE INSERT` conflict guard.

## Monotonic counters must be allocated inside the INSERT

Reading `SELECT MAX(revision)` and then issuing a separate `INSERT` is a
read-modify-write race. Correctness then depends on every writer taking
`BEGIN IMMEDIATE` before the read — lock discipline that no in-process test can
constrain, because `node:sqlite` is synchronous.

Allocate inside the statement so the race cannot exist:

```sql
INSERT INTO phase_artifacts (attempt_id, phase, revision, ...)
SELECT ?, ?, COALESCE(MAX(revision), 0) + 1, ...
FROM phase_artifacts WHERE attempt_id = ? AND phase = ?;
```

Retain the `UNIQUE` constraint as the backstop. Prefer removing an invariant over
asserting one that cannot be tested.

## Verification requirements

- **Mutation-test the guard.** Remove the mechanism; the test claiming to protect
  it must fail. Both defects found in this area were found this way and neither by
  reading.
- **Probe from a default-pragma connection**, not one the store opened. A test
  that configures the attacking connection is testing itself.
- **`Promise.all` does not test concurrency here.** `node:sqlite` is synchronous
  and these store methods contain no `await`, so calls serialize and the test
  passes even with the mechanism removed.

## Referential integrity and retention

A phase artifact must reference an existing attempt. The schema enforces that
relationship with `ON DELETE RESTRICT`: unknown artifacts are rejected, while an
attempt cannot be silently removed with its evidence. Routing decisions remain
append-only historical evidence without a cascading foreign key. This v1 choice
means an operator must resolve any future attempt-retention policy explicitly;
it is not a production caller or a complete deletion workflow.

## Known residual

Anything able to alter the schema — `DROP TRIGGER`, `PRAGMA writable_schema`, or
direct file manipulation — defeats these guards. Not assessed; belongs with backup
and recovery tooling in `single-host-operations`. Consumers must still realpath-
contain artifact locators before opening them, and no production Pool Proof caller
exists yet.
