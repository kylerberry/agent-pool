import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Test-only owned root; registering cleanup at creation prevents retained /tmp fixtures. */
export function createTempRoot(t: { after: (fn: () => void) => void }, prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }));
  return root;
}
