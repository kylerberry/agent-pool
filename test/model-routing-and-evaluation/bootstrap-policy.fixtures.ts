import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerFixturePath = join(__dirname, '../../packages/worker-harness/config/model-routing.bootstrap.json');
const orchestratorFixturePath = join(__dirname, '../../packages/orchestrator-harness/config/model-routing.bootstrap.json');

export const workerFixture = JSON.parse(readFileSync(workerFixturePath, 'utf8'));
export const orchestratorFixture = JSON.parse(readFileSync(orchestratorFixturePath, 'utf8'));
