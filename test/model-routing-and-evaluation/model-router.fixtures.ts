import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadWorkerBootstrapPolicy } from '../../src/domains/model-routing-and-evaluation/bootstrap-policy.ts';
import { validateAvailability } from '../../src/domains/model-routing-and-evaluation/model-router.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerFixturePath = join(__dirname, '../../packages/worker-harness/config/model-routing.bootstrap.json');
const workerFixture = JSON.parse(readFileSync(workerFixturePath, 'utf8'));

export const workerPolicy = loadWorkerBootstrapPolicy(workerFixture);

export function allAvailable() {
  return validateAvailability([
    { fullId: 'openai-codex/gpt-5.6-luna' },
    { fullId: 'moonshot/kimi-k2.7-code' },
    { fullId: 'openai-codex/gpt-5.6-terra' },
    { fullId: 'moonshot/kimi-k3' },
    { fullId: 'openai-codex/gpt-5.6-sol' },
  ]);
}
