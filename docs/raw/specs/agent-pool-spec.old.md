# Warm Agent Pool — Specification

**Version:** 0.2-draft
**Author:** Kyler Berry
**Status:** Pre-implementation

---

## 1. Purpose

A self-hosted, always-warm pool of coding agents that accepts tasks via webhook, processes them autonomously using the Pi framework, and delivers results directly to GitHub — as a PR, issue, or comment. Agents can fail over between coding backends mid-task without losing progress, and can be re-invoked later to address PR review feedback with full context of the original session.

---

## 2. Guiding Constraints

| Constraint | Decision |
|---|---|
| Infrastructure budget | $20–$50/month (target: ~$8–$10/month) |
| LLM cost posture | Token-lean by default; model is configurable per task |
| Task surface | Coding and coding-adjacent tasks only (v1) |
| Output surface | GitHub: PR, issue, or issue comment |
| Trigger | Manual — curl or a shell script from Kyler's machine; PR-comment follow-ups triggered by Kyler's own GitHub Action |
| Task intake | HTTP webhook (POST) |
| Agent framework | earendil-works/pi |
| Coding backend | Agent decides based on task; fallback chain on failure (see Section 9) |
| Task routing | Agent-driven, not dispatcher-driven — task description carries full context, agent assesses scope itself |
| Continuation | Same workspace/branch resumed on backend failover; session context persisted for PR-comment follow-ups |
| Isolation | Docker Compose — one container per agent |
| Host | Hetzner CX32 (4 vCPU / 8 GB RAM / ~$6/month) |

---

## 3. System Architecture

```
Kyler's Machine
  curl -X POST https://pool.yourdomain.com/task -d '{...}'
        |
        v
GitHub Action (Kyler-authored, runs on PR review comment)
  - Applies own filtering (reviewer allowlist, trigger phrase)
  - POST https://pool.yourdomain.com/continue
        |
        v  (same X-Pool-Secret auth as /task)
Hetzner CX32  (Docker Compose stack)

  dispatcher (Fastify + BullMQ)  :3000
    - /task, /continue, /status routes
        |
        v  BullMQ job queue
  Redis (queue + KV + AOF)  :6379 internal only
    - job queue
    - session:<task_id>
    - pr:<repo>:<pr#> -> task_id
        |
    +---+---+---+
    |       |       |
  agent-1  agent-2  agent-3   (identical, expandable, Pi SDK)
    |       |       |
    +---+---+---+
        |
  Ephemeral workspace volume
  /workspace/<task_id>/  (wiped after each round)
        |
        v  git push + GitHub API
  GitHub (PR / issue / comment)
```

---

## 4. Infrastructure

### 4.1 Host

**Hetzner CX32**

| Spec | Value |
|---|---|
| vCPU | 4 |
| RAM | 8 GB |
| Disk | 80 GB SSD |
| Network | 20 TB/month |
| Cost | ~EUR 5.79/month (~$6.30 USD) |
| OS | Ubuntu 24.04 LTS |

Leaves $14–$44/month of headroom for additional agents or a larger instance if needed.

### 4.2 Domain + TLS

- Point a subdomain (e.g. `pool.yourdomain.com`) to the Hetzner IP.
- Run **Caddy** as a reverse proxy in the Compose stack — auto-provisions Let's Encrypt TLS with zero config.

### 4.3 Redis Persistence

Redis now stores more than transient queue state — it holds session records that must survive a task completing, the workspace being wiped, and days passing before a PR comment triggers a follow-up. **AOF (append-only file) persistence is enabled** so this data survives container restarts. Negligible cost impact; text-sized JSON records on an 80 GB disk.

---

## 5. Services (Docker Compose)

```yaml
# docker-compose.yml (abbreviated)
services:
  caddy:
    image: caddy:2-alpine
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: redis-server --appendonly yes
    volumes:
      - redis_data:/data
    # internal only — no exposed port

  dispatcher:
    build: ./dispatcher
    restart: unless-stopped
    environment:
      - REDIS_URL=redis://redis:6379
      - WEBHOOK_SECRET=${WEBHOOK_SECRET}
      - GITHUB_TOKEN=${GITHUB_TOKEN}
    depends_on: [redis]

  agent-1:
    build: ./agent
    restart: unless-stopped
    environment:
      - AGENT_ID=agent-1
      - REDIS_URL=redis://redis:6379
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - GITHUB_TOKEN=${GITHUB_TOKEN}
    volumes:
      - workspace:/workspace
    depends_on: [redis]

  agent-2:
    extends:
      service: agent-1
    environment:
      - AGENT_ID=agent-2

  agent-3:
    extends:
      service: agent-1
    environment:
      - AGENT_ID=agent-3

volumes:
  caddy_data:
  redis_data:
  workspace:
```

---

## 6. Task Schema

### 6.1 New Task

Submitted as JSON POST body to `POST /task`.

```jsonc
{
  // Required
  "description": "Refactor the auth middleware to use jose instead of jsonwebtoken",
  "repo": "kylerberry/my-project",          // owner/repo
  "base_branch": "main",                    // branch to base work on

  // Optional — sensible defaults applied if omitted
  "task_id": "uuid-v4",                     // auto-generated if absent
  "output_type": "pr",                      // "pr" | "issue" | "comment"
  "issue_number": null,                     // required if output_type = "comment"
  "output_branch": "agent/task-{task_id}", // auto-generated if absent
  "model": "anthropic/claude-sonnet-4-6",  // any Pi-supported provider/model string; agent may override if it judges the task needs a different model
  "coding_backend": null,                  // optional override — if set, skips agent's own backend judgment (see Section 9)
  "context": {
    // Freeform additional context passed into the agent system prompt
    "notes": "Prefer async/await, avoid callbacks"
  }
}
```

### 6.2 Continuation Task (PR follow-up)

Submitted as JSON POST body to `POST /continue`, normally by Kyler's GitHub Action in response to a PR review comment.

```jsonc
{
  // One of these two ways to identify the original task
  "parent_task_id": "uuid-v4",              // if known
  "repo": "kylerberry/my-project",          // used with pr_number to resolve parent_task_id via Redis
  "pr_number": 42,

  // Required
  "comment_body": "This breaks if the token is expired but not yet revoked — handle that case",
  "comment_author": "kylerberry",
  "comment_url": "https://github.com/kylerberry/my-project/pull/42#discussion_r123456"
}
```

Dispatcher resolves `parent_task_id` via the `pr:<repo>:<pr_number>` Redis index if not supplied directly, loads the session record, and enqueues a continuation job.

### 6.3 Default Model Strategy

Pi's unified LLM API is model-agnostic. Default recommendation: `anthropic/claude-haiku-4-5` for routine tasks (cheap, fast), with `anthropic/claude-sonnet-4-6` as an explicit upgrade for harder tasks. The agent may deviate from the requested model if it judges the task requires more capability — this is logged in the session record.

---

## 7. Dispatcher Service

**Stack:** Node.js + Fastify + BullMQ

### 7.1 Routes

| Method | Path | Description |
|---|---|---|
| `POST` | `/task` | Enqueue a new task |
| `POST` | `/continue` | Enqueue a continuation job against an existing PR/session |
| `GET` | `/status/:task_id` | Poll task status + result |
| `GET` | `/health` | Liveness check |
| `GET` | `/queue` | Queue depth + agent states (dev only, internal) |

### 7.2 Auth

All POST requests must include the header `X-Pool-Secret: <WEBHOOK_SECRET>`. This applies uniformly to `/task` and `/continue` — the pool never receives raw, unfiltered GitHub webhook events directly. Filtering logic (which reviewers, which trigger phrases) lives in Kyler's own GitHub Action, upstream of the pool. Dispatcher rejects with `401` if the secret is missing or wrong.

### 7.3 Task Lifecycle

```
PENDING -> CLAIMED -> RUNNING -> DONE
                            \-> FALLBACK (backend failed, handing off to next in chain)
                            \-> FAILED (retryable, all backends exhausted)
                            \-> DEAD (max retries exceeded)
```

BullMQ handles retry backoff. Max attempts per backend: 1. Max backends in fallback chain: 3 (see Section 9).

---

## 8. Agent Worker

Each agent container runs a single BullMQ worker process.

### 8.1 New Task Flow

```
1. Pull/clone repo at base_branch into /workspace/<task_id>/
2. Create output branch: agent/<task_id>
3. Agent assesses the task itself and selects a coding backend (see Section 9),
   unless task.coding_backend was explicitly set
4. Build Pi agent session (createAgentSession) with:
   - systemPrompt from task.description + task.context
   - model from task.model (or agent's own judgment)
5. Run session -> session.prompt(task.description)
   - On backend failure (rate limit, error, timeout): trigger fallback (Section 9),
     do NOT wipe the workspace
6. On completion:
   a. git add -A
   b. git commit -m "chore: <task_id> — <first 80 chars of description>"
   c. git push origin <output_branch>
   d. GitHub API -> open PR / create issue / post comment (per output_type)
7. Generate a compressed session summary (~150 words, one cheap LLM call)
8. Write session record to Redis: session:<task_id> (see Section 10.1)
9. Write PR index to Redis: pr:<repo>:<pr_number> -> task_id (if output_type = pr)
10. Write result (PR URL, issue URL) back to BullMQ job result
11. Wipe /workspace/<task_id>/ — the branch persists on GitHub and can be re-cloned;
    the session record in Redis is what persists locally, not the workspace
```

### 8.2 Continuation Flow (PR comment follow-up)

```
1. Resolve session record from Redis (session:<task_id>)
2. Clone the EXISTING PR branch (not base_branch) into fresh /workspace/<task_id>/
3. Build resume prompt:
   - original task description
   - compressed summary of all prior rounds
   - the new comment_body + comment_author
4. Run agent session against the resume prompt
5. On completion:
   a. git add -A / commit / push to the SAME branch (updates the existing PR)
   b. GitHub API -> reply on the comment thread (optional, if configured)
6. Append this round's summary to the session record's `rounds` array
7. Wipe /workspace/<task_id>/ again
```

### 8.3 GitHub Output Types

| `output_type` | Action |
|---|---|
| `pr` | Push branch → `POST /repos/{owner}/{repo}/pulls` |
| `issue` | `POST /repos/{owner}/{repo}/issues` with description as body |
| `comment` | `POST /repos/{owner}/{repo}/issues/{issue_number}/comments` |

Auth: GitHub PAT with `repo` scope, injected via `GITHUB_TOKEN` env var.

---

## 9. Fallback Chain

### 9.1 Backend Selection

Routing is **agent-driven, not dispatcher-driven**. The dispatcher only has the task description text — the agent can actually inspect the repo (file count, structure, existing patterns) before choosing a backend. Default judgment heuristic (encoded in the agent's own planning prompt, not hardcoded logic):

- Simple, mechanical, single/few-file changes (scaffolding, boilerplate, straightforward refactors) → **Pi coding agent** (in-process, cheaper, faster startup)
- Complex, multi-file, ambiguous, or architecturally significant work → **Claude Code** (subprocess, stronger multi-file reasoning)

`task.coding_backend`, if explicitly set on the task payload, overrides this judgment entirely.

### 9.2 Fallback Order

| Order | Backend | Mechanism | Notes |
|---|---|---|---|
| 1 | Claude Code | Subprocess (`claude` CLI) | Primary for complex tasks |
| 2 | Pi coding agent (OpenAI/Codex model) | In-process SDK, `createAgentSession()` | First fallback — different provider, avoids shared rate limits with backend 1 |
| 3 | Pi coding agent (Anthropic model) | In-process SDK, `createAgentSession()` | Final fallback |

If backend 1 is Pi (agent chose it as primary for a simple task), the chain still has two more Pi-backed model fallbacks available before failing the task entirely.

### 9.3 Handoff Mechanism

The workspace is the checkpoint — nothing is restarted from scratch.

```
1. Backend N fails (rate limit, crash, timeout)
2. Worker does NOT wipe /workspace/<task_id>/
3. Worker captures handoff_context:
   - `git log --oneline` since base_branch
   - `git diff` of any uncommitted changes
   - last N lines of backend N's output/transcript, if captured
4. Backend N+1 is invoked with a resume prompt:
   "You are continuing work on this task: <original description>.
    Previous progress (by <backend_N_name>): <commit log + diff summary>.
    Continue from here — check git state directly before assuming anything."
5. Backend N+1 operates in the SAME workspace, SAME branch
6. Job status transitions to FALLBACK during handoff, back to RUNNING once
   backend N+1 starts, and to FAILED/DEAD only after backend 3 also fails
```

Backends are instructed via system prompt not to assume they're starting fresh — always check `git log` / `git diff` / read files directly before acting.

---

## 10. Session Persistence & Continuation

### 10.1 Session Record (Redis)

Key: `session:<task_id>` — JSON value, persisted via Redis AOF.

```jsonc
{
  "task_id": "uuid-v4",
  "repo": "kylerberry/my-project",
  "pr_number": 42,
  "pr_branch": "agent/task-uuid-v4",
  "original_description": "Refactor the auth middleware to use jose instead of jsonwebtoken",
  "output_type": "pr",
  "backend_history": ["claude-code", "pi/openai-codex"],
  "rounds": [
    {
      "trigger": "initial",
      "backend": "claude-code",
      "summary": "Replaced jsonwebtoken with jose across auth middleware. Updated 4 files, added token expiry test.",
      "commit_sha": "abc1234",
      "timestamp": "2026-07-01T14:22:00Z"
    },
    {
      "trigger": "pr_comment",
      "comment_author": "kylerberry",
      "comment_url": "https://github.com/.../discussion_r123456",
      "backend": "claude-code",
      "summary": "Added handling for expired-but-not-revoked token case per review comment. 1 file changed.",
      "commit_sha": "def5678",
      "timestamp": "2026-07-01T16:05:00Z"
    }
  ],
  "transcript_path": "/data/sessions/uuid-v4/transcript.jsonl"
}
```

Key: `pr:<repo>:<pr_number>` → `task_id` — simple index so `/continue` requests can resolve a session from repo + PR number alone, without the Action needing to track `task_id` itself.

### 10.2 What Gets Fed Into Resume Prompts

The **compressed summary** (concatenation of `rounds[].summary`) plus git history plus the new comment — not the raw transcript. This keeps resume prompts small and cheap regardless of how many rounds a PR goes through. The raw transcript is retained on disk purely as a manual debugging aid, never auto-injected into a prompt.

### 10.3 Workspace vs. Session Record

| | Lifetime | Where |
|---|---|---|
| Git workspace (`/workspace/<task_id>/`) | Ephemeral — wiped after every round | Docker volume |
| Session record (`session:<task_id>`) | Durable — survives indefinitely | Redis (AOF-persisted) |
| PR branch | Durable — lives on GitHub | GitHub |
| Raw transcript | Durable, but write-once / rarely read | Docker volume, `/data/sessions/` |

This resolves cleanly: the workspace never needs to survive between rounds because the branch (on GitHub) and the session record (in Redis) together contain everything needed to resume.

---

## 11. Concurrency Model

- Each agent worker processes **one task at a time**.
- A pool of 3 agents = 3 tasks running in parallel maximum.
- Additional tasks queue in BullMQ and are picked up as agents free up.
- Queue and session data are durable — Redis AOF persists both across restarts.
- To increase parallelism: add an `agent-4`, `agent-5` service to `docker-compose.yml`.

---

## 12. Secrets Management

All secrets are injected via a `.env` file on the host (never committed). Compose reads it automatically.

```bash
# .env (host only, gitignored)
WEBHOOK_SECRET=<random-32-char-string>
GITHUB_TOKEN=ghp_...
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...         # required for Codex fallback (backend 2)
```

Rotate secrets by updating `.env` and running `docker compose up -d` (zero-downtime for env-only changes on restart).

---

## 13. Operational Runbook

### Start the pool
```bash
docker compose up -d
```

### Submit a new task
```bash
curl -X POST https://pool.yourdomain.com/task \
  -H "Content-Type: application/json" \
  -H "X-Pool-Secret: $POOL_SECRET" \
  -d '{
    "description": "Add input validation to the /api/users POST route using zod",
    "repo": "kylerberry/my-project",
    "base_branch": "main",
    "output_type": "pr"
  }'
```

### Trigger a continuation (normally called by your GitHub Action, not by hand)
```bash
curl -X POST https://pool.yourdomain.com/continue \
  -H "Content-Type: application/json" \
  -H "X-Pool-Secret: $POOL_SECRET" \
  -d '{
    "repo": "kylerberry/my-project",
    "pr_number": 42,
    "comment_body": "This breaks if the token is expired but not yet revoked",
    "comment_author": "kylerberry",
    "comment_url": "https://github.com/kylerberry/my-project/pull/42#discussion_r123456"
  }'
```

### Check task status
```bash
curl https://pool.yourdomain.com/status/<task_id> \
  -H "X-Pool-Secret: $POOL_SECRET"
```

### View logs
```bash
docker compose logs -f agent-1
docker compose logs -f dispatcher
```

### Scale pool to 5 agents
Add `agent-4` and `agent-5` services to `docker-compose.yml` (copy `agent-3`), then:
```bash
docker compose up -d --no-recreate
```

### Restart a stuck agent
```bash
docker compose restart agent-2
```

---

## 14. Repository Structure

```
agent-pool/
├── docker-compose.yml
├── Caddyfile
├── .env.example
├── dispatcher/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.ts          # Fastify server
│       ├── queue.ts          # BullMQ producer
│       ├── session.ts        # Redis session record read/write helpers
│       └── routes/
│           ├── task.ts
│           ├── continue.ts
│           └── status.ts
├── agent/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── worker.ts         # BullMQ consumer
│       ├── runner.ts         # Pi session orchestrator, fallback chain logic
│       ├── summary.ts        # compressed session summary generator
│       ├── backends/
│       │   ├── pi.ts         # createAgentSession wrapper (Anthropic + OpenAI models)
│       │   └── claude-code.ts # subprocess wrapper
│       └── github.ts         # PR / issue / comment API calls
├── github-action/
│   └── pr-comment-trigger.yml # Kyler-authored Action: filters comments, calls /continue
└── scripts/
    ├── submit-task.sh        # curl wrapper for task submission
    └── check-status.sh
```

---

## 15. Open Decisions (Deferred)

| Decision | Options | Note |
|---|---|---|
| ~~Agent specialization~~ | ~~All identical vs. named specialists~~ | **Resolved:** All agents are identical. Each carries the full tool set. Task description drives behavior; no routing logic needed. |
| ~~Workspace cleanup strategy~~ | ~~Delete immediately vs. retain for debugging~~ | **Resolved:** Workspace wiped after every round; session record in Redis + PR branch on GitHub are the durable state. Raw transcript retained on disk as a manual debugging fallback. |
| Task UI | Bull Board (BullMQ dashboard) vs. remain curl-only | Low priority; add Bull Board behind auth if queue visibility becomes useful |
| Notification on completion | None (poll `/status`) vs. push (Telegram/Slack) | Easy add — dispatcher emits a webhook or message on job completion |
| GitHub Action filter design | Reviewer allowlist, trigger phrase, or both | Kyler owns this — lives outside the pool's codebase entirely |

---

## 16. Cost Summary

| Line item | Monthly |
|---|---|
| Hetzner CX32 | ~$6.30 |
| Domain (amortized) | ~$1.00 |
| Backups (optional, Hetzner) | ~$1.20 |
| **Infrastructure total** | **~$8.50** |
| LLM API (usage-based, incl. summary generation calls) | Variable |

Well inside the $20–$50/month infra ceiling, with room to upgrade to a CX42 (8 vCPU / 16 GB) at ~$17/month if agent load grows. Redis AOF persistence and session record storage add negligible disk usage on the 80 GB volume.
