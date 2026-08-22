/**
 * Compatibility re-export of the production TaskManifest validator.
 * Production code must not import this package.
 */
export {
  parseTaskManifest,
  loadTaskManifest,
} from '../../../src/composition/task-manifest.ts';
export type {
  TaskManifest,
  TaskManifestAcceptanceCriterion,
  TaskManifestRejection,
  ValidatedTaskManifest,
} from '../../../src/composition/task-manifest.ts';
