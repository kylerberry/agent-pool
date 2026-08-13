import type { ContainerDriver } from '../../src/domains/agent-execution/index.ts';

export const PINNED_IMAGE = 'sha256:' + '1'.repeat(64);
export const SAFE_IDENTITY = { uid: 1001, gid: 1001, isPinned: true };

export function baseOptions(driver: ContainerDriver) {
  return {
    image: PINNED_IMAGE,
    workspacePath: '/tmp/fake-workspace',
    sandboxIdentity: SAFE_IDENTITY,
    driver,
    toolTimeoutMs: 1000,
    cpuLimit: '1',
    memoryLimit: '512m',
    pidsLimit: 64,
  };
}
