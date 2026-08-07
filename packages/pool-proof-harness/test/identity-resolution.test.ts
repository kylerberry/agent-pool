import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolvePiIdentity,
  resolvePackageIdentity,
  resolveProfileIdentity,
  verifySandboxImage,
  listPackageIdentityFiles,
  listProfileIdentityFiles,
} from '../src/identity-resolution.ts';

describe('Identity Resolution', () => {
  it('resolves the real Pi executable and reports 0.83.0', () => {
    const identity = resolvePiIdentity('/Users/kylerberry/.nvm/versions/node/v24.18.0/bin/pi');
    assert.ok(!('error' in identity), 'expected Pi identity');
    assert.equal(identity.version.includes('0.83.0'), true);
    assert.equal(identity.digest.length, 64);
  });

  it('rejects a missing Pi executable', () => {
    const identity = resolvePiIdentity('/nonexistent/pi');
    assert.ok('error' in identity);
  });

  it('resolves package and profile identities with hex digests', () => {
    const pkg = resolvePackageIdentity();
    assert.equal(pkg.profile, 'pool-proof-builder');
    assert.equal(pkg.digest.length, 64);

    const profile = resolveProfileIdentity();
    assert.equal(profile.name, 'pool-proof-builder');
    assert.equal(profile.digest.length, 64);
  });

  it('deduplicates package and profile identity file lists', () => {
    const pkgFiles = listPackageIdentityFiles();
    assert.equal(pkgFiles.length, new Set(pkgFiles).size);
    assert.ok(pkgFiles.some((f) => f.endsWith('contracts/pool-worker-execution-context.schema.json')));
    assert.ok(pkgFiles.some((f) => f.endsWith('scripts/preflight.mjs')));

    const profileFiles = listProfileIdentityFiles();
    assert.equal(profileFiles.length, new Set(profileFiles).size);
    assert.ok(profileFiles.some((f) => f.endsWith('broker.mjs')));
    assert.ok(profileFiles.some((f) => f.endsWith('trusted-bootstrap.ts')));
  });

  it('produces stable package and profile digests across repeated calls', () => {
    assert.equal(resolvePackageIdentity().digest, resolvePackageIdentity().digest);
    assert.equal(resolveProfileIdentity().digest, resolveProfileIdentity().digest);
  });

  it('rejects :latest sandbox images', () => {
    const result = verifySandboxImage('docker', 'agent-pool/pool-proof-sandbox:latest');
    assert.equal(result.verified, false);
    assert.ok(result.reason?.includes('sha256:<id>'));
  });

  it('rejects name@sha256 references and tags', () => {
    const result = verifySandboxImage('docker', 'agent-pool/pool-proof-sandbox@sha256:' + 'a'.repeat(64));
    assert.equal(result.verified, false);
    assert.ok(result.reason?.includes('64-character hex'));
  });

  it('rejects a sha256 reference that is not exactly 64 hex characters', () => {
    assert.equal(verifySandboxImage('docker', 'sha256:short').verified, false);
    assert.equal(verifySandboxImage('docker', 'sha256:' + 'g'.repeat(64)).verified, false);
    assert.equal(verifySandboxImage('docker', 'sha256:' + 'a'.repeat(63)).verified, false);
  });
});
