import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  REPOSITORY_COMMAND_ALLOWLIST,
  assertNoCredentials,
  buildRepositoryCommandEnv,
  buildTrustedOperationEnv,
  isCredentialVariableName,
  isExecutionFailure,
} from '../../src/domains/agent-execution/index.ts';

/** A hostile host environment: every credential shape a worker host plausibly carries. */
const HOSTILE_ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/home/worker',
  LANG: 'C',
  GITHUB_TOKEN: 'ghp_secret',
  GH_TOKEN: 'gh_secret',
  OPENAI_API_KEY: 'sk-secret',
  ANTHROPIC_API_KEY: 'sk-ant-secret',
  MOONSHOT_API_KEY: 'ms-secret',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  NPM_TOKEN: 'npm-secret',
  PI_AUTH_TOKEN: 'pi-secret',
  DATABASE_PASSWORD: 'hunter2',
  SESSION_COOKIE: 'sid=1',
  SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
  GIT_ASKPASS: '/usr/bin/askpass',
  SOME_SIGNATURE: 'sig',
});

const WORKSPACE_HOME = '/workspace/attempt-1/home';
const OPTS = { workspaceHome: WORKSPACE_HOME };

describe('credential isolation for repository commands', () => {
  it('builds the repository-command environment from an allowlist, not a filter', () => {
    const env = buildRepositoryCommandEnv(HOSTILE_ENV, OPTS);
    assert.equal(isExecutionFailure(env), false);
    assert.ok(!isExecutionFailure(env));
    assert.equal(env.PATH, '/usr/bin:/bin');
    assert.equal(env.LANG, 'C');
  });

  it('never propagates the host home directory', () => {
    // Stripping credential *variables* while handing over the real home leaves
    // ~/.git-credentials, ~/.netrc, ~/.npmrc and ~/.config/gh/hosts.yml readable.
    const env = buildRepositoryCommandEnv(HOSTILE_ENV, OPTS);
    assert.ok(!isExecutionFailure(env));
    assert.equal(env.HOME, WORKSPACE_HOME);
    assert.notEqual(env.HOME, HOSTILE_ENV.HOME);
    assert.equal(JSON.stringify(env).includes('/home/worker'), false);
  });

  it('repoints home-scoped and git config paths inside the workspace', () => {
    const env = buildRepositoryCommandEnv(HOSTILE_ENV, OPTS);
    assert.ok(!isExecutionFailure(env));
    for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'TMPDIR', 'GIT_CONFIG_GLOBAL']) {
      assert.ok(env[name]?.startsWith(WORKSPACE_HOME), `${name} must live under the workspace home`);
    }
    assert.equal(env.GIT_CONFIG_SYSTEM, '/dev/null');
  });

  it('requires a workspace-scoped absolute home rather than defaulting to the host', () => {
    for (const workspaceHome of ['', 'relative/home', '/workspace/../etc', undefined as unknown as string]) {
      const result = buildRepositoryCommandEnv(HOSTILE_ENV, { workspaceHome });
      assert.ok(isExecutionFailure(result), `${String(workspaceHome)} must be rejected`);
      assert.equal(result.code, 'CAPABILITY_DENIED');
    }
  });

  it('refuses to let a caller allowlist a home-scoped variable back in', () => {
    const result = buildRepositoryCommandEnv(HOSTILE_ENV, { ...OPTS, additionalAllowed: ['HOME'] });
    assert.ok(isExecutionFailure(result));
    assert.equal(result.code, 'CAPABILITY_DENIED');
  });

  it('leaks no provider or GitHub credential into a repository command', () => {
    const env = buildRepositoryCommandEnv(HOSTILE_ENV, OPTS);
    assert.ok(!isExecutionFailure(env));
    assert.equal(assertNoCredentials(env), null);
    for (const secret of Object.keys(HOSTILE_ENV).filter(isCredentialVariableName)) {
      assert.equal(secret in env, false, `${secret} must not reach repository commands`);
    }
    assert.equal(JSON.stringify(env).includes('secret'), false);
  });

  it('rejects an unknown provider credential even though no rule names it', () => {
    // The allowlist is the boundary: a variable nobody anticipated is simply not
    // copied, which is the case a denylist would miss.
    const env = buildRepositoryCommandEnv({ ...HOSTILE_ENV, FUTURE_PROVIDER_XYZ: 'value' }, OPTS);
    assert.ok(!isExecutionFailure(env));
    assert.equal('FUTURE_PROVIDER_XYZ' in env, false);
  });

  it('refuses to allowlist a credential-shaped variable', () => {
    const result = buildRepositoryCommandEnv(HOSTILE_ENV, { ...OPTS, additionalAllowed: ['GITHUB_TOKEN'] });
    assert.ok(isExecutionFailure(result));
    assert.equal(result.code, 'CAPABILITY_DENIED');
  });

  it('allows a benign additional variable', () => {
    const env = buildRepositoryCommandEnv({ ...HOSTILE_ENV, CARGO_HOME: '/opt/cargo' }, {
      ...OPTS,
      additionalAllowed: ['CARGO_HOME'],
    });
    assert.ok(!isExecutionFailure(env));
    assert.equal(env.CARGO_HOME, '/opt/cargo');
  });

  it('omits allowlisted variables that are absent from the host environment', () => {
    const env = buildRepositoryCommandEnv({ PATH: '/bin' }, OPTS);
    assert.ok(!isExecutionFailure(env));
    assert.equal('LANG' in env, false);
    assert.equal(env.PATH, '/bin');
  });

  it('keeps the standing allowlist free of credential-shaped names', () => {
    for (const name of REPOSITORY_COMMAND_ALLOWLIST) {
      assert.equal(isCredentialVariableName(name), false, `${name} must not be allowlisted`);
    }
  });

  it('recognises credential names case-insensitively and by prefix', () => {
    for (const name of [
      'github_token',
      'Gh_Token',
      'OPENAI_API_KEY',
      'my_password',
      'X_ACCESS_KEY_ID',
      'SSH_AUTH_SOCK',
      'AZURE_CLIENT_SECRET',
    ]) {
      assert.equal(isCredentialVariableName(name), true, `${name} should be treated as a credential`);
    }
    for (const name of ['PATH', 'HOME', 'NODE_ENV', 'TZ']) {
      assert.equal(isCredentialVariableName(name), false, `${name} should not be treated as a credential`);
    }
  });
});

describe('credential scoping for trusted operations', () => {
  it('gives a model call provider credentials only', () => {
    const env = buildTrustedOperationEnv(HOSTILE_ENV, 'model-call', OPTS);
    assert.ok(!isExecutionFailure(env));
    assert.equal(env.OPENAI_API_KEY, 'sk-secret');
    assert.equal(env.MOONSHOT_API_KEY, 'ms-secret');
    assert.equal('GITHUB_TOKEN' in env, false);
    assert.equal('SSH_AUTH_SOCK' in env, false);
  });

  it('gives host-side GitHub delivery forge credentials only', () => {
    const env = buildTrustedOperationEnv(HOSTILE_ENV, 'github-delivery', OPTS);
    assert.ok(!isExecutionFailure(env));
    assert.equal(env.GITHUB_TOKEN, 'ghp_secret');
    assert.equal('OPENAI_API_KEY' in env, false);
    assert.equal('MOONSHOT_API_KEY' in env, false);
  });

  it('rejects an unknown trusted operation', () => {
    const result = buildTrustedOperationEnv(HOSTILE_ENV, 'repository-command' as never, OPTS);
    assert.ok(isExecutionFailure(result));
    assert.equal(result.code, 'CAPABILITY_DENIED');
  });

  it('fails closed on an inherited operation name rather than throwing', () => {
    for (const operation of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      const result = buildTrustedOperationEnv(HOSTILE_ENV, operation as never, OPTS);
      assert.ok(isExecutionFailure(result), `${operation} must fail closed`);
      assert.equal(result.code, 'CAPABILITY_DENIED');
    }
  });

  it('reports credentials present in an environment about to be handed to repo code', () => {
    const failure = assertNoCredentials({ PATH: '/bin', GITHUB_TOKEN: 'ghp_secret' });
    assert.ok(isExecutionFailure(failure));
    assert.equal(failure.code, 'CAPABILITY_DENIED');
  });
});
