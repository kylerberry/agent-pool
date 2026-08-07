/**
 * Dependency-free JSON Schema subset validator for the Pool Worker harness.
 *
 * The worker package deliberately has no npm dependencies: it is loaded into a
 * pinned runtime image and must be able to gate an attempt before any paid model
 * call without a dependency install step. This module therefore implements only
 * the keyword subset used by the bundled contract schemas.
 *
 * Supported: $ref (local $defs pointers), type, const, enum, required,
 * properties, additionalProperties (false only), pattern, minLength, minimum,
 * maximum, items, minItems, maxItems, uniqueItems, allOf, anyOf, oneOf, not,
 * if/then/else.
 *
 * Anything outside that subset is a schema-integrity failure rather than a
 * silently ignored keyword — an unrecognised keyword must never be mistaken for
 * a satisfied constraint. `format` is the one exception: it is annotation-only
 * in JSON Schema, so contracts that need a real constraint state it as
 * `pattern` and `format` carries no enforcement here.
 */

const SUPPORTED_KEYWORDS = new Set([
  "$schema", "$id", "$defs", "$ref", "title", "description",
  "type", "const", "enum", "required", "properties", "additionalProperties",
  "pattern", "minLength", "maxLength", "minimum", "maximum", "format",
  "items", "minItems", "maxItems", "uniqueItems",
  "allOf", "anyOf", "oneOf", "not", "if", "then", "else",
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(expected, value) {
  const actual = typeOf(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  return actual === expected;
}

function resolveRef(ref, root) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) {
    throw new Error(`unsupported $ref: ${String(ref)}`);
  }
  let node = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isPlainObject(node) || !Object.hasOwn(node, segment)) {
      throw new Error(`unresolvable $ref: ${ref}`);
    }
    node = node[segment];
  }
  return node;
}

/**
 * Validate `instance` against `schema`. Returns an array of human-readable
 * error strings; an empty array means valid.
 */
export function validateInstance(schema, instance, root = schema, path = "") {
  const errors = [];
  if (schema === true) return errors;
  if (schema === false) return [`${path || "value"} is not allowed`];
  if (!isPlainObject(schema)) return [`${path || "value"} has a non-object schema`];

  if (Object.hasOwn(schema, "$ref")) {
    return validateInstance(resolveRef(schema.$ref, root), instance, root, path);
  }

  const label = path || "value";

  if (Object.hasOwn(schema, "type")) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(t, instance))) {
      errors.push(`${label} must be of type ${types.join(" or ")}`);
      return errors;
    }
  }

  if (Object.hasOwn(schema, "const") && JSON.stringify(instance) !== JSON.stringify(schema.const)) {
    errors.push(`${label} must equal ${JSON.stringify(schema.const)}`);
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(instance))) {
    errors.push(`${label} must be one of ${JSON.stringify(schema.enum)}`);
  }

  if (typeof instance === "string") {
    // No flags: JSON Schema patterns are unanchored ECMA-262 regexes.
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(instance)) {
      errors.push(`${label} does not match required pattern`);
    }
    if (typeof schema.minLength === "number" && instance.length < schema.minLength) {
      errors.push(`${label} is shorter than ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && instance.length > schema.maxLength) {
      errors.push(`${label} is longer than ${schema.maxLength}`);
    }
  }

  if (typeof instance === "number") {
    if (typeof schema.minimum === "number" && instance < schema.minimum) {
      errors.push(`${label} is below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && instance > schema.maximum) {
      errors.push(`${label} is above maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(instance)) {
    if (typeof schema.minItems === "number" && instance.length < schema.minItems) {
      errors.push(`${label} needs at least ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === "number" && instance.length > schema.maxItems) {
      errors.push(`${label} allows at most ${schema.maxItems} items`);
    }
    if (schema.uniqueItems === true) {
      const seen = new Set(instance.map((item) => JSON.stringify(item)));
      if (seen.size !== instance.length) errors.push(`${label} must contain unique items`);
    }
    if (Object.hasOwn(schema, "items")) {
      instance.forEach((item, index) => {
        errors.push(...validateInstance(schema.items, item, root, `${label}[${index}]`));
      });
    }
  }

  if (isPlainObject(instance)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(instance, key)) errors.push(`${label}.${key} is required`);
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(instance)) {
        if (!Object.hasOwn(properties, key)) errors.push(`${label}.${key} is not an allowed property`);
      }
    }
    for (const [key, subSchema] of Object.entries(properties)) {
      if (Object.hasOwn(instance, key)) {
        errors.push(...validateInstance(subSchema, instance[key], root, `${label}.${key}`));
      }
    }
  }

  for (const subSchema of schema.allOf ?? []) {
    errors.push(...validateInstance(subSchema, instance, root, label));
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s) => validateInstance(s, instance, root, label).length === 0)) {
    errors.push(`${label} does not satisfy any allowed variant`);
  }
  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.filter((s) => validateInstance(s, instance, root, label).length === 0);
    if (matched.length !== 1) errors.push(`${label} must satisfy exactly one allowed variant`);
  }
  if (Object.hasOwn(schema, "not") && validateInstance(schema.not, instance, root, label).length === 0) {
    errors.push(`${label} matches a forbidden schema`);
  }
  if (Object.hasOwn(schema, "if")) {
    const branch = validateInstance(schema.if, instance, root, label).length === 0 ? schema.then : schema.else;
    if (branch !== undefined) errors.push(...validateInstance(branch, instance, root, label));
  }

  return errors;
}

/**
 * Structural integrity check for a contract schema itself, run at preflight so a
 * corrupted or silently-widened contract file fails the attempt before any paid
 * work rather than at first use.
 *
 * Verifies every `$ref` resolves, every keyword is one this validator actually
 * enforces, `additionalProperties` is never `true`, and every `required` name is
 * a declared property in the same schema object.
 */
export function checkSchemaIntegrity(schema, root = schema, path = "#") {
  const errors = [];
  if (typeof schema === "boolean") return errors;
  if (!isPlainObject(schema)) return [`${path} is not a schema object`];

  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) errors.push(`${path} uses unsupported keyword ${keyword}`);
  }
  if (Object.hasOwn(schema, "$ref")) {
    try {
      resolveRef(schema.$ref, root);
    } catch (error) {
      errors.push(`${path}: ${error.message}`);
    }
  }
  if (schema.additionalProperties === true) {
    errors.push(`${path} must not allow unconstrained additional properties`);
  }
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  if (schema.additionalProperties === false) {
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(properties, name)) {
        errors.push(`${path} requires undeclared property ${name}`);
      }
    }
  }
  for (const [name, subSchema] of Object.entries(properties)) {
    errors.push(...checkSchemaIntegrity(subSchema, root, `${path}/properties/${name}`));
  }
  for (const [name, subSchema] of Object.entries(isPlainObject(schema.$defs) ? schema.$defs : {})) {
    errors.push(...checkSchemaIntegrity(subSchema, root, `${path}/$defs/${name}`));
  }
  for (const keyword of ["items", "not", "if", "then", "else"]) {
    if (Object.hasOwn(schema, keyword)) {
      errors.push(...checkSchemaIntegrity(schema[keyword], root, `${path}/${keyword}`));
    }
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    (schema[keyword] ?? []).forEach((subSchema, index) => {
      errors.push(...checkSchemaIntegrity(subSchema, root, `${path}/${keyword}/${index}`));
    });
  }
  return errors;
}

/**
 * Recursively reject DAG topology anywhere in an untrusted payload.
 *
 * `additionalProperties: false` already blocks these at the top level; this is
 * the defence-in-depth pass that also covers nested free-form objects, so a
 * worker can never be handed structure it is specified not to see (ADR-010).
 */
export const DAG_TOPOLOGY_KEYS = Object.freeze([
  "depends_on", "dependson", "dependencies", "dag", "dag_id", "nodes", "edges",
  "ready_frontier", "frontier", "downstream", "upstream", "successors",
  "predecessors", "topology", "graph", "sibling_nodes", "node_graph",
]);

export function findDagTopology(value, path = "payload", seen = new Set()) {
  if (!isPlainObject(value) && !Array.isArray(value)) return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findDagTopology(value[i], `${path}[${i}]`, seen);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (DAG_TOPOLOGY_KEYS.includes(key.toLowerCase())) return `${path}.${key}`;
    const hit = findDagTopology(child, `${path}.${key}`, seen);
    if (hit) return hit;
  }
  return null;
}
