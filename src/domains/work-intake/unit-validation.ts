/**
 * Deterministic mechanical validation for hand-authored work (ADR-028).
 *
 * "Mechanical" is the operative word: every rejection here is a structural
 * property of the payload. No model is consulted, and the same payload always
 * produces the same ordered violation list.
 *
 * All violations are collected rather than short-circuiting on the first, so a
 * caller fixing a hand-authored DAG sees the whole picture in one round trip.
 */

import type { DirectTaskSubmission, DirectTaskUnit, IntakeViolation } from './contracts.ts';
import { INTAKE_LIMITS, SUBMISSION_FIELDS, UNIT_FIELDS } from './contracts.ts';

/** Keys that must never be treated as ordinary data on untrusted input. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const UNIT_FIELD_SET: ReadonlySet<string> = new Set(UNIT_FIELDS);
const SUBMISSION_FIELD_SET: ReadonlySet<string> = new Set(SUBMISSION_FIELDS);

/**
 * A plain data object, and nothing dressed up as one.
 *
 * The prototype check matters: `Object.create({repo, branch, unit})` has no own
 * keys, so an unknown-field scan sees nothing while property reads still
 * resolve through the prototype chain — every field would arrive "valid" and
 * unexamined. `JSON.parse` cannot produce such a value, but this boundary is
 * also called directly by in-process callers, so it does not rely on that.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Read a field only when the object genuinely owns it, so nothing inherited
 * from a prototype is mistaken for caller-supplied data.
 */
function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * Caller-supplied key names are echoed back in violation paths. Truncate them
 * so a caller cannot inflate an error response with a megabyte-long key.
 */
function echoSafe(key: string): string {
  return key.length <= 64 ? key : `${key.slice(0, 64)}…`;
}

/**
 * Own enumerable keys, including any `__proto__` supplied via `JSON.parse`
 * (which creates it as an own property rather than touching the prototype).
 */
function ownKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record);
}

/**
 * Conservative target shapes. `repo` is `owner/name`; `branch` is a git ref
 * without the constructs that make refs dangerous to pass to a command line.
 *
 * Intake is the untrusted boundary, so these are rejected here rather than
 * relied upon downstream. Integration and Delivery may narrow them further —
 * it must not have to widen them.
 */
// The dot-only guard must end at a component boundary, not just end of string,
// or `./repo` and `a/./b` slip through on their trailing components.
const REPO_SEGMENT = String.raw`(?!-)(?!\.+(?:/|$))[A-Za-z0-9._-]+`;
const REPO_PATTERN = new RegExp(`^(?!.*\\.\\.)${REPO_SEGMENT}/${REPO_SEGMENT}$`);

// Git rejects empty path components, so a branch may not contain `//` or begin
// or end with `/`; dot-only components are excluded for the same reason.
const BRANCH_COMPONENT = String.raw`(?!\.+(?:/|$))[A-Za-z0-9._-]+`;
const BRANCH_PATTERN = new RegExp(`^(?!-)(?!.*\\.\\.)${BRANCH_COMPONENT}(?:/${BRANCH_COMPONENT})*$`);

function checkTargetFormat(
  value: string,
  path: string,
  pattern: RegExp,
  violations: IntakeViolation[],
): void {
  if (!pattern.test(value)) {
    violations.push({
      code: 'INVALID_FIELD_FORMAT',
      path,
      message: `${path} is not a well-formed target`,
    });
  }
}

/**
 * Cap on how many violations a single rejection reports. A body carrying a
 * million unknown keys would otherwise produce a million violations and a
 * response far larger than the request that caused it.
 */
const MAX_REPORTED_VIOLATIONS = 100;

/**
 * Violations are sorted into a stable order so two identical payloads always
 * yield byte-identical rejections, independent of check ordering, then capped.
 * Sorting before capping keeps the retained subset deterministic too.
 */
function sortViolations(violations: IntakeViolation[]): IntakeViolation[] {
  return [...violations]
    .sort((a, b) => {
      if (a.path !== b.path) return a.path < b.path ? -1 : 1;
      if (a.code !== b.code) return a.code < b.code ? -1 : 1;
      return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
    })
    .slice(0, MAX_REPORTED_VIOLATIONS);
}

function checkString(
  value: unknown,
  path: string,
  maxLength: number,
  violations: IntakeViolation[],
  unitId?: string,
): boolean {
  if (typeof value !== 'string') {
    violations.push({
      code: value === undefined ? 'MISSING_FIELD' : 'INVALID_FIELD_TYPE',
      path,
      message: value === undefined ? `${path} is required` : `${path} must be a string`,
      ...(unitId === undefined ? {} : { unit_id: unitId }),
    });
    return false;
  }
  if (value.trim().length === 0) {
    violations.push({
      code: 'MISSING_FIELD',
      path,
      message: `${path} must not be blank`,
      ...(unitId === undefined ? {} : { unit_id: unitId }),
    });
    return false;
  }
  if (value.length > maxLength) {
    violations.push({
      code: 'FIELD_TOO_LONG',
      path,
      message: `${path} exceeds ${maxLength} characters`,
      ...(unitId === undefined ? {} : { unit_id: unitId }),
    });
    return false;
  }
  return true;
}

/**
 * Validate one unit in isolation: shape, unknown fields, and acceptance
 * criteria. Cross-unit concerns (duplicate ids, edges, cycles) are handled by
 * `validateSubmission` once every unit's identity is known.
 */
function validateUnitShape(raw: unknown, path: string, violations: IntakeViolation[]): void {
  if (!isPlainObject(raw)) {
    violations.push({
      code: 'INVALID_FIELD_TYPE',
      path,
      message: `${path} must be an object`,
    });
    return;
  }

  const rawId = own(raw, 'id');
  const unitId = typeof rawId === 'string' ? rawId : undefined;

  for (const key of ownKeys(raw)) {
    if (FORBIDDEN_KEYS.has(key) || !UNIT_FIELD_SET.has(key)) {
      violations.push({
        code: 'UNKNOWN_FIELD',
        path: `${path}.${echoSafe(key)}`,
        message: `${echoSafe(key)} is not an accepted unit field`,
        ...(unitId === undefined ? {} : { unit_id: unitId }),
      });
    }
  }

  checkString(rawId, `${path}.id`, INTAKE_LIMITS.maxIdLength, violations, unitId);
  checkString(own(raw, 'intent'), `${path}.intent`, INTAKE_LIMITS.maxIntentLength, violations, unitId);
  checkString(
    own(raw, 'change_spec'),
    `${path}.change_spec`,
    INTAKE_LIMITS.maxChangeSpecLength,
    violations,
    unitId,
  );

  validateAcceptanceCriteria(
    own(raw, 'acceptance_criteria'),
    `${path}.acceptance_criteria`,
    violations,
    unitId,
  );
  validateDependsOn(own(raw, 'depends_on'), `${path}.depends_on`, violations, unitId);
}

function validateAcceptanceCriteria(
  raw: unknown,
  path: string,
  violations: IntakeViolation[],
  unitId?: string,
): void {
  const withUnit = unitId === undefined ? {} : { unit_id: unitId };

  if (raw === undefined) {
    violations.push({
      code: 'MISSING_ACCEPTANCE_CRITERIA',
      path,
      message: 'acceptance_criteria is required on every unit',
      ...withUnit,
    });
    return;
  }
  if (!Array.isArray(raw)) {
    violations.push({
      code: 'INVALID_FIELD_TYPE',
      path,
      message: 'acceptance_criteria must be an array of strings',
      ...withUnit,
    });
    return;
  }
  if (raw.length === 0) {
    violations.push({
      code: 'MISSING_ACCEPTANCE_CRITERIA',
      path,
      message: 'acceptance_criteria must not be empty',
      ...withUnit,
    });
    return;
  }
  if (raw.length > INTAKE_LIMITS.maxCriteriaPerUnit) {
    violations.push({
      code: 'FIELD_TOO_LONG',
      path,
      message: `acceptance_criteria exceeds ${INTAKE_LIMITS.maxCriteriaPerUnit} entries`,
      ...withUnit,
    });
    return;
  }

  raw.forEach((criterion, index) => {
    if (typeof criterion !== 'string') {
      violations.push({
        code: 'INVALID_FIELD_TYPE',
        path: `${path}[${index}]`,
        message: 'each acceptance criterion must be a string',
        ...withUnit,
      });
      return;
    }
    if (criterion.trim().length === 0) {
      violations.push({
        code: 'MISSING_ACCEPTANCE_CRITERIA',
        path: `${path}[${index}]`,
        message: 'acceptance criteria must not be blank',
        ...withUnit,
      });
      return;
    }
    if (criterion.length > INTAKE_LIMITS.maxCriterionLength) {
      violations.push({
        code: 'FIELD_TOO_LONG',
        path: `${path}[${index}]`,
        message: `acceptance criterion exceeds ${INTAKE_LIMITS.maxCriterionLength} characters`,
        ...withUnit,
      });
    }
  });
}

function validateDependsOn(
  raw: unknown,
  path: string,
  violations: IntakeViolation[],
  unitId?: string,
): void {
  if (raw === undefined) return;
  const withUnit = unitId === undefined ? {} : { unit_id: unitId };

  if (!Array.isArray(raw)) {
    violations.push({
      code: 'INVALID_FIELD_TYPE',
      path,
      message: 'depends_on must be an array of unit ids',
      ...withUnit,
    });
    return;
  }
  if (raw.length > INTAKE_LIMITS.maxDependenciesPerUnit) {
    violations.push({
      code: 'FIELD_TOO_LONG',
      path,
      message: `depends_on exceeds ${INTAKE_LIMITS.maxDependenciesPerUnit} entries`,
      ...withUnit,
    });
    return;
  }

  const seen = new Set<string>();
  raw.forEach((dependency, index) => {
    if (typeof dependency !== 'string' || dependency.trim().length === 0) {
      violations.push({
        code: 'INVALID_FIELD_TYPE',
        path: `${path}[${index}]`,
        message: 'each dependency must be a non-empty unit id',
        ...withUnit,
      });
      return;
    }
    if (unitId !== undefined && dependency === unitId) {
      violations.push({
        code: 'SELF_DEPENDENCY',
        path: `${path}[${index}]`,
        message: `unit ${unitId} cannot depend on itself`,
        ...withUnit,
      });
      return;
    }
    if (seen.has(dependency)) {
      violations.push({
        code: 'DUPLICATE_DEPENDENCY',
        path: `${path}[${index}]`,
        message: `dependency ${dependency} is listed more than once`,
        ...withUnit,
      });
      return;
    }
    seen.add(dependency);
  });
}

/**
 * Kahn's algorithm over the declared edges. Returns the ids that could not be
 * ordered — every member of a cycle, and anything downstream of one — sorted so
 * the rejection is byte-stable.
 *
 * Only runs once ids are known to be unique and every edge resolves, so the
 * result is unambiguous.
 */
export function findUnorderableUnits(units: readonly DirectTaskUnit[]): readonly string[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const unit of units) {
    indegree.set(unit.id, 0);
    dependents.set(unit.id, []);
  }

  for (const unit of units) {
    for (const dependency of unit.depends_on ?? []) {
      indegree.set(unit.id, (indegree.get(unit.id) ?? 0) + 1);
      dependents.get(dependency)?.push(unit.id);
    }
  }

  const ready = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
  let ordered = 0;

  while (ready.length > 0) {
    const current = ready.pop() as string;
    ordered += 1;
    for (const dependent of dependents.get(current) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) ready.push(dependent);
    }
  }

  if (ordered === units.length) return [];

  return [...indegree.entries()]
    .filter(([, degree]) => degree > 0)
    .map(([id]) => id)
    .sort();
}

/** Total caller-supplied string content, the quantity the memory cap governs. */
function measureContent(units: readonly DirectTaskUnit[], body: Record<string, unknown>): number {
  let total = String(own(body, 'repo') ?? '').length + String(own(body, 'branch') ?? '').length;
  for (const unit of units) {
    total += unit.id.length + unit.intent.length + unit.change_spec.length;
    for (const criterion of unit.acceptance_criteria) total += criterion.length;
    for (const dependency of unit.depends_on ?? []) total += dependency.length;
  }
  return total;
}

export type ValidatedSubmission = {
  readonly repo: string;
  readonly branch: string;
  readonly units: readonly DirectTaskUnit[];
  readonly shape: 'single_unit' | 'hand_authored_dag';
};

export type SubmissionValidation =
  | { readonly ok: true; readonly value: ValidatedSubmission }
  | { readonly ok: false; readonly violations: readonly IntakeViolation[] };

/**
 * Validate a raw, untrusted submission body. One direct unit and a flat unit
 * array travel the same path and land in the same normalized shape — the only
 * difference recorded is `shape`.
 */
export function validateSubmission(body: unknown): SubmissionValidation {
  const violations: IntakeViolation[] = [];

  if (!isPlainObject(body)) {
    return {
      ok: false,
      violations: [{ code: 'MALFORMED_BODY', path: '$', message: 'request body must be a JSON object' }],
    };
  }

  for (const key of ownKeys(body)) {
    if (FORBIDDEN_KEYS.has(key) || !SUBMISSION_FIELD_SET.has(key)) {
      violations.push({
        code: 'UNKNOWN_FIELD',
        path: `$.${echoSafe(key)}`,
        message: `${echoSafe(key)} is not an accepted submission field`,
      });
    }
  }

  const rawRepo = own(body, 'repo');
  const rawBranch = own(body, 'branch');
  if (checkString(rawRepo, '$.repo', INTAKE_LIMITS.maxRepoLength, violations)) {
    checkTargetFormat(rawRepo as string, '$.repo', REPO_PATTERN, violations);
  }
  if (checkString(rawBranch, '$.branch', INTAKE_LIMITS.maxBranchLength, violations)) {
    checkTargetFormat(rawBranch as string, '$.branch', BRANCH_PATTERN, violations);
  }

  const rawUnit = own(body, 'unit');
  const rawUnitArray = own(body, 'units');
  const hasUnit = rawUnit !== undefined;
  const hasUnits = rawUnitArray !== undefined;

  if (hasUnit && hasUnits) {
    violations.push({
      code: 'AMBIGUOUS_SUBMISSION_SHAPE',
      path: '$',
      message: 'provide exactly one of unit or units, not both',
    });
    return { ok: false, violations: sortViolations(violations) };
  }
  if (!hasUnit && !hasUnits) {
    violations.push({
      code: 'EMPTY_SUBMISSION',
      path: '$',
      message: 'provide exactly one of unit or units',
    });
    return { ok: false, violations: sortViolations(violations) };
  }

  const shape: 'single_unit' | 'hand_authored_dag' = hasUnit ? 'single_unit' : 'hand_authored_dag';
  let rawUnits: unknown[];

  if (hasUnit) {
    rawUnits = [rawUnit];
    validateUnitShape(rawUnit, '$.unit', violations);
    // A one-unit submission has nothing to depend on; a non-empty edge list
    // here is always a dangling reference, so reject it as a shape error.
    if (isPlainObject(rawUnit)) {
      const edges = own(rawUnit, 'depends_on');
      if (Array.isArray(edges) && edges.length > 0) {
        violations.push({
          code: 'SINGLE_UNIT_HAS_DEPENDENCIES',
          path: '$.unit.depends_on',
          message: 'a single-unit submission cannot declare dependencies; use units for a DAG',
        });
      }
    }
  } else {
    const candidate = rawUnitArray;
    if (!Array.isArray(candidate)) {
      violations.push({
        code: 'INVALID_FIELD_TYPE',
        path: '$.units',
        message: 'units must be an array',
      });
      return { ok: false, violations: sortViolations(violations) };
    }
    if (candidate.length === 0) {
      violations.push({ code: 'EMPTY_SUBMISSION', path: '$.units', message: 'units must not be empty' });
      return { ok: false, violations: sortViolations(violations) };
    }
    if (candidate.length > INTAKE_LIMITS.maxUnits) {
      violations.push({
        code: 'TOO_MANY_UNITS',
        path: '$.units',
        message: `units exceeds ${INTAKE_LIMITS.maxUnits} entries`,
      });
      return { ok: false, violations: sortViolations(violations) };
    }
    rawUnits = candidate;
    candidate.forEach((unit, index) => validateUnitShape(unit, `$.units[${index}]`, violations));
  }

  // Cross-unit checks need every id to be well-formed first; running them on a
  // partially-invalid set would emit misleading dangling-edge errors.
  if (violations.length > 0) {
    return { ok: false, violations: sortViolations(violations) };
  }

  const units = rawUnits as DirectTaskUnit[];

  // Every string is known well-formed by now, so the aggregate is meaningful.
  // Checked before canonicalization so an oversized payload is never copied.
  const totalContent = measureContent(units, body);
  if (totalContent > INTAKE_LIMITS.maxTotalContentChars) {
    return {
      ok: false,
      violations: [
        {
          code: 'PAYLOAD_TOO_LARGE',
          path: '$',
          message: `submission content exceeds ${INTAKE_LIMITS.maxTotalContentChars} characters`,
        },
      ],
    };
  }
  const basePath = shape === 'single_unit' ? '$.unit' : '$.units';

  const seenIds = new Set<string>();
  units.forEach((unit, index) => {
    const path = shape === 'single_unit' ? `${basePath}.id` : `${basePath}[${index}].id`;
    if (seenIds.has(unit.id)) {
      violations.push({
        code: 'DUPLICATE_UNIT_ID',
        path,
        message: `unit id ${unit.id} is declared more than once`,
        unit_id: unit.id,
      });
      return;
    }
    seenIds.add(unit.id);
  });

  if (violations.length > 0) {
    return { ok: false, violations: sortViolations(violations) };
  }

  units.forEach((unit, index) => {
    (unit.depends_on ?? []).forEach((dependency, edgeIndex) => {
      if (!seenIds.has(dependency)) {
        violations.push({
          code: 'UNKNOWN_DEPENDENCY',
          path:
            shape === 'single_unit'
              ? `${basePath}.depends_on[${edgeIndex}]`
              : `${basePath}[${index}].depends_on[${edgeIndex}]`,
          message: `dependency ${dependency} does not match any submitted unit id`,
          unit_id: unit.id,
        });
      }
    });
  });

  if (violations.length > 0) {
    return { ok: false, violations: sortViolations(violations) };
  }

  const unorderable = findUnorderableUnits(units);
  if (unorderable.length > 0) {
    violations.push({
      code: 'DEPENDENCY_CYCLE',
      path: basePath,
      // Kahn's leaves both the cycle members and everything downstream of them
      // unordered, so this names the affected set, not the cycle exactly.
      message: `dependency cycle reaches these units: ${unorderable.join(', ')}`,
    });
    return { ok: false, violations: sortViolations(violations) };
  }

  return {
    ok: true,
    value: {
      repo: rawRepo as string,
      branch: rawBranch as string,
      units,
      shape,
    },
  };
}

export type { DirectTaskSubmission };
