/**
 * Stage 1 fixture job definition.
 */

import type { ProofJob } from '../../../src/domains/agent-execution/index.ts';
import type { FixtureManifest } from './fixture-repository.ts';

export function buildStage1Job(
  manifest: FixtureManifest,
  baseCommit: string,
  nodeId: string,
  attemptId: string,
  workspacePath?: string,
): ProofJob {
  return {
    nodeId,
    attemptId,
    attemptNumber: 1,
    intent: 'Prove one real headless Pool Worker can complete an atomic fixture change.',
    changeSpec: 'Change src/message.js so the fixture test passes.',
    acceptanceCriteria: [
      { id: 'c1', text: 'Fixture test fails at base commit.' },
      { id: 'c2', text: 'Only allowed paths change.' },
      { id: 'c3', text: 'Fixture test passes after the attempt commit.' },
    ],
    criteriaOriginSource: 'direct_task',
    criteriaOriginSourceId: 'pool-proof-stage-1',
    targetRepo: manifest.fixture_name,
    targetBranch: 'main',
    allowedChangedPaths: [...manifest.allowed_changed_paths],
    fixtureTestCommand: [...manifest.fixture_test_command],
    ...(workspacePath !== undefined ? { workspacePath } : {}),
  };
}
