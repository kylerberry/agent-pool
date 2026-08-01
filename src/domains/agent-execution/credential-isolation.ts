/**
 * Credential isolation for untrusted repository commands.
 *
 * Repository code and generated tests are untrusted. They must never inherit
 * provider or GitHub credentials (ADR-032): a test file is an arbitrary program
 * that can read `process.env` and exfiltrate anything in it.
 *
 * The control is an allowlist, not a denylist. A denylist fails open on the one
 * case that matters — a credential variable nobody thought to name — so the
 * repository-command environment is built from an empty base and only known-safe
 * variables are copied in. The denylist below is a second, independent assertion
 * that catches an operator mistakenly allowlisting a secret-shaped name; it is
 * not the primary boundary.
 */

import {
  createExecutionFailure,
  deepFreeze,
  isExecutionFailure,
  type ExecutionFailure,
} from './contracts.ts';

export type EnvRecord = Readonly<Record<string, string>>;

/**
 * Variables an untrusted repository command may inherit. Deliberately minimal:
 * enough to run a toolchain, nothing that identifies or authenticates anyone.
 */
export const REPOSITORY_COMMAND_ALLOWLIST: readonly string[] = Object.freeze([
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'SHELL',
  'TERM',
  'CI',
  'NODE_ENV',
  'NO_COLOR',
]);

/** Name fragments that mark a variable as credential-bearing, matched case-insensitively. */
const SECRET_NAME_FRAGMENTS: readonly string[] = Object.freeze([
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'CREDENTIAL',
  'PRIVATE_KEY',
  'APIKEY',
  'API_KEY',
  'ACCESS_KEY',
  'SESSION',
  'COOKIE',
  'BEARER',
  'SIGNATURE',
  'AUTH',
]);

/** Provider and forge namespaces whose variables are credential-bearing by convention. */
const SECRET_NAME_PREFIXES: readonly string[] = Object.freeze([
  'GITHUB_',
  'GH_',
  'GITLAB_',
  'OPENAI_',
  'ANTHROPIC_',
  'MOONSHOT_',
  'AWS_',
  'AZURE_',
  'GOOGLE_',
  'GCP_',
  'NPM_',
  'PI_',
  'AGENT_POOL_PROVIDER_',
]);

/** Exact names that are credential-bearing without matching a fragment or prefix. */
const SECRET_NAME_EXACT: readonly string[] = Object.freeze([
  'SSH_AUTH_SOCK',
  'NETRC',
  'GIT_ASKPASS',
  'GIT_SSH_COMMAND',
]);

/** True when a variable name looks credential-bearing. */
export function isCredentialVariableName(name: string): boolean {
  const upper = name.toUpperCase();
  if (SECRET_NAME_EXACT.includes(upper)) return true;
  if (SECRET_NAME_PREFIXES.some((prefix) => upper.startsWith(prefix))) return true;
  return SECRET_NAME_FRAGMENTS.some((fragment) => upper.includes(fragment));
}

export type BuildRepositoryCommandEnvOptions = {
  /**
   * Extra variable names the attempt needs. Each is still checked against the
   * credential heuristics, so this cannot be used to smuggle a secret through.
   */
  readonly additionalAllowed?: readonly string[];
};

/**
 * Build the environment for an untrusted repository command from an empty base.
 * Returns a typed failure rather than a filtered environment when the caller
 * asks for a credential-shaped variable, so the mistake is visible instead of
 * silently dropped.
 */
export function buildRepositoryCommandEnv(
  sourceEnv: Readonly<Record<string, string | undefined>>,
  options: BuildRepositoryCommandEnvOptions = {},
): EnvRecord | ExecutionFailure {
  const allowed = [...REPOSITORY_COMMAND_ALLOWLIST, ...(options.additionalAllowed ?? [])];

  for (const name of allowed) {
    if (isCredentialVariableName(name)) {
      return createExecutionFailure('CAPABILITY_DENIED', `credential-bearing variable requested: ${name}`);
    }
  }

  const env: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const name of allowed) {
    const value = sourceEnv[name];
    if (typeof value === 'string') env[name] = value;
  }
  return deepFreeze(env) as EnvRecord;
}

export type TrustedOperation = 'model-call' | 'github-delivery';

/**
 * Credentials each trusted operation is permitted to see. A model call never
 * receives GitHub credentials and host-side delivery never receives provider
 * credentials, so compromising one operation does not yield the other's secrets.
 */
const TRUSTED_OPERATION_CREDENTIALS: Readonly<Record<TrustedOperation, readonly string[]>> = Object.freeze({
  'model-call': Object.freeze(['OPENAI_API_KEY', 'MOONSHOT_API_KEY']),
  'github-delivery': Object.freeze(['GITHUB_TOKEN']),
});

/**
 * Build the environment for a trusted orchestration operation. Credentials are
 * scoped to the single operation being performed; this environment is never
 * handed to repository commands.
 */
export function buildTrustedOperationEnv(
  sourceEnv: Readonly<Record<string, string | undefined>>,
  operation: TrustedOperation,
): EnvRecord | ExecutionFailure {
  // Own-property lookup only: an inherited name such as `toString` must fail
  // closed rather than resolve to a function and blow up mid-spawn.
  if (!Object.hasOwn(TRUSTED_OPERATION_CREDENTIALS, operation)) {
    return createExecutionFailure('CAPABILITY_DENIED', 'unknown trusted operation');
  }
  const permitted = TRUSTED_OPERATION_CREDENTIALS[operation];

  const base = buildRepositoryCommandEnv(sourceEnv);
  if (isExecutionFailure(base)) return base;

  const env: Record<string, string> = Object.create(null) as Record<string, string>;
  Object.assign(env, base);
  for (const name of permitted) {
    const value = sourceEnv[name];
    if (typeof value === 'string') env[name] = value;
  }
  return deepFreeze(env) as EnvRecord;
}

/**
 * Assert that an environment carries no credential-bearing variable. Used at the
 * point of spawn as a last check, and by tests as the direct expression of the
 * acceptance criterion.
 */
export function assertNoCredentials(env: Readonly<Record<string, string | undefined>>): ExecutionFailure | null {
  for (const name of Object.keys(env)) {
    if (isCredentialVariableName(name)) {
      return createExecutionFailure('CAPABILITY_DENIED', `credential variable present: ${name}`);
    }
  }
  return null;
}
