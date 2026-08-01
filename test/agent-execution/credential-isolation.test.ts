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

describe('credential isolation for repository commands', () => {
  it('builds the repository-command environment from an allowlist, not a filter', () => {
    const env = buildRepositoryCommandEnv(HOSTILE_ENV);
    assert.equal(isExecutionFailure(env), false);
    assert.ok(!isExecutionFailure(env));
    assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH']);
    assert.equal(env.PATH, '/usr/bin:/bin');
  });

  it('leaks no provider or GitHub credential into a repository command', () => {
    const env = buildRepositoryCommandEnv(HOSTILE_ENV);
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
    const env = buildRepositoryCommandEnv({ ...HOSTILE_ENV, FUTURE_PROVIDER_XYZ: 'value' });
    assert.ok(!isExecutionFailure(env));
    assert.equal('FUTURE_PROVIDER_XYZ' in env, false);
  });

  it('refuses to allowlist a credential-shaped variable', () => {
    const result = buildRepositoryCommandEnv(HOSTILE_ENV, { additionalAllowed: ['GITHUB_TOKEN'] });
    assert.ok(isExecutionFailure(result));
    assert.equal(result.code, 'CAPABILITY_DENIED');
  });

  it('allows a benign additional variable', () => {
    const env = buildRepositoryCommandEnv({ ...HOSTILE_ENV, CARGO_HOME: '/opt/cargo' }, {
      additionalAllowed: ['CARGO_HOME'],
    });
    assert.ok(!isExecutionFailure(env));
    assert.equal(env.CARGO_HOME, '/opt/cargo');
  });

  it('omits allowlisted variables that are absent from the host environment', () => {
    const env = buildRepositoryCommandEnv({ PATH: '/bin' });
    assert.ok(!isExecutionFailure(env));
    assert.deepEqual(Object.keys(env), ['PATH']);
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
    const env = buildTrustedOperationEnv(HOSTILE_ENV, 'model-call');
    assert.ok(!isExecutionFailure(env));
    assert.equal(env.OPENAI_API_KEY, 'sk-secret');
    assert.equal(env.MOONSHOT_API_KEY, 'ms-secret');
    assert.equal('GITHUB_TOKEN' in env, false);
    assert.equal('SSH_AUTH_SOCK' in env, false);
  });

  it('gives host-side GitHub delivery forge credentials only', () => {
    const env = buildTrustedOperationEnv(HOSTILE_ENV, 'github-delivery');
    assert.ok(!isExecutionFailure(env));
    assert.equal(env.GITHUB_TOKEN, 'ghp_secret');
    assert.equal('OPENAI_API_KEY' in env, false);
    assert.equal('MOONSHOT_API_KEY' in env, false);
  });

  it('rejects an unknown trusted operation', () => {
    const result = buildTrustedOperationEnv(HOSTILE_ENV, 'repository-command' as never);
    assert.ok(isExecutionFailure(result));
    assert.equal(result.code, 'CAPABILITY_DENIED');
  });

  it('fails closed on an inherited operation name rather than throwing', () => {
    for (const operation of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      const result = buildTrustedOperationEnv(HOSTILE_ENV, operation as never);
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
