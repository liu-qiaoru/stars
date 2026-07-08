# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

Local-first multimodal media search and editing agent. TypeScript/NestJS main API (`apps/server`), Python worker (`apps/worker-py`) + separate Python model service for media/model tasks, Next.js frontend (`apps/web`), shared schemas (`packages/shared`). ~1 TB personal media library target (video-heavy). Default config: external LLM **off**; all retrieval runs on local models (SigLIP, faster-whisper, PaddleOCR).

## Commands

```bash
pnpm install

# Full workspace check (shared + server + web: typecheck + test; shared also regenerates JSON schemas)
pnpm check

# Per workspace
pnpm --filter @local-media-agent/shared check     # generate:schemas + typecheck + test
pnpm --filter @local-media-agent/server check      # typecheck + test
pnpm --filter @local-media-agent/web check         # typecheck + test + next build

# Dev (runs server :4000 and web :3000 in parallel; NOT the Python services)
pnpm dev
pnpm --filter @local-media-agent/server dev        # server on SERVER_PORT (default 4000)
pnpm --filter @local-media-agent/web dev           # web on :3000

# Python worker tests (from repo root)
PYTHONPATH=apps/worker-py python3.12 -m unittest discover apps/worker-py/tests

# Single test
pnpm --filter @local-media-agent/server exec vitest run tests/search/search.service.test.ts   # by file
pnpm --filter @local-media-agent/server exec vitest run -t "returns ocr_match"                 # by test name
PYTHONPATH=apps/worker-py python3.12 -m unittest discover -s apps/worker-py/tests -p test_ocr_worker.py

# Database migration (does NOT run with `dev`; apply manually after pulling new migrations)
corepack pnpm --filter @local-media-agent/server exec drizzle-kit generate   # generate from schema changes
corepack pnpm --filter @local-media-agent/server db:migrate                   # apply migrations

# Docker services (PostgreSQL, Qdrant; Redis is opt-in via --profile realtime)
docker compose --env-file .env -f infra/docker-compose.yml up -d postgres qdrant
docker compose --env-file .env -f infra/docker-compose.yml config             # validate config

# Python runtime
python3.12 -m venv .venv && .venv/bin/python -m pip install -r apps/worker-py/requirements.txt
PYTHONPATH=apps/worker-py .venv/bin/python -m media_agent_worker                # worker
PYTHONPATH=apps/worker-py .venv/bin/python -m media_agent_worker.model_service  # model service on :4020
```

If bare `pnpm` fails, use `corepack pnpm` (or `corepack enable`). Regenerate JSON schemas (`shared check` does this) before running server/Python tests whenever a Zod job schema changed.

## Local Runtime Topology

End-to-end retrieval needs **five** things running; this is the part that requires reading several files to piece together:

1. **PostgreSQL + Qdrant** via `infra/docker-compose.yml`.
2. **NestJS server** (`:4000`) — HTTP API, job creation, Qdrant reads, FTS reads, agent runtime. Owns schema.
3. **Python worker** (`media_agent_worker`) — claims jobs from PostgreSQL (`FOR UPDATE SKIP LOCKED`), runs scan/probe/index/embed/transcribe/OCR/clip. Writes Qdrant points + `media_assets` + `vector_refs`.
4. **Python model service** (`model_service`, `:4020`) — localhost HTTP service wrapping SigLIP. **Distinct from the worker**: the server calls it *synchronously* at search time to embed the query text. Without it, `/search` vector retrieval is unavailable (batch media embedding still works via worker jobs).
5. **Next.js web** (`:3000`).

## Architecture

### Monorepo Layout

- `apps/server` — NestJS API (Express adapter, ESM). Business logic, HTTP endpoints, DB access, Qdrant reads, agent runtime, search.
- `apps/worker-py` — Python 3.12 worker. Claims jobs, executes media/model tasks. Raw SQL only (no ORM). Also hosts `model_service.py` (the synchronous embedding HTTP service).
- `packages/shared` — Zod schemas, TypeScript types, constants, generated JSON Schema for the Python worker, API client. **TypeScript owns all schemas.**
- `apps/web` — Next.js 16 / React 19 / Tailwind 4 frontend.
- `infra/` — Docker Compose for PostgreSQL, Qdrant, optional Redis.
- `docs/` — Architecture, API contract, job protocol, vector index design, implementation plan, task tracking.

### Key Patterns

**TypeScript is the schema authority.** Drizzle schema in `apps/server/src/database/schema.ts`. Zod job schemas in `packages/shared/schemas/`. Python reads the generated `packages/shared/generated/job-schemas.json` (via `jsonschema`), never imports TS code, has no independent models.

**PostgreSQL-backed job queue.** TS server creates jobs (`status='queued'`). Python worker claims with `SELECT ... FOR UPDATE SKIP LOCKED`. No Dramatiq/Celery/BullMQ. See `docs/job-protocol.md`.

**Two embedding paths — do not conflate.**
- *Batch media embedding* (indexing): `index_media` creates `pending` `vector_refs` → worker `embed_image`/`embed_video_frame` jobs write Qdrant + flip `vector_refs.status='indexed'`. Large vectors never cross the TS↔Python boundary as args; worker reads/writes Qdrant directly.
- *Synchronous query embedding* (search): `/search` → `SearchQueryVectorService` → `ModelGatewayService.embedText` → `model_service:4020`. Must be synchronous — putting it on the job queue would stall search behind indexing.

**Job pipeline auto-triggers + coordination endpoints.** In-worker, one handler completing creates the next jobs: `scan_library → probe_media → index_media`; `index_media` then fans out to `transcribe_audio`, `embed_*` (via pending `vector_refs`), and `run_ocr` (for image/video_frame assets). The server's two catch-up endpoints re-scan and fan out whatever the auto-trigger missed: `POST /jobs/embedding/queue-pending` (pending `vector_refs`) and `POST /jobs/ocr/queue-pending` (image/video_frame assets lacking OCR).

**Full-text search is co-located on `media_assets`.** `media_assets.text_content` + a generated `text_tsv` tsvector (`to_tsvector('simple', ...)`) + GIN index. Transcript (`text_chunk`) and OCR (`image`/`video_frame`) **both write into the same column**; no separate search table. `SearchService` queries `text_chunk`/`image`/`video_frame` and maps `reason` by asset type: `text_chunk → text_match`, `image`/`video_frame → ocr_match`.

**NestJS module structure.** Each domain is a standalone module (config, health, database, libraries, jobs, media, search, clips, agent, qdrant, model-gateway). DI via Symbol tokens: `DATABASE` (Drizzle), `SETTINGS` (parsed env), `QDRANT_CLIENT`, `PG_POOL`. No direct imports of infrastructure.

**Cross-language point_id parity.** Qdrant point IDs are deterministic UUIDv5 (namespace `f3f4e35a-...`, inputs joined with `|`). TS `deterministicPointId` and Python `uuid.uuid5` must produce identical IDs — both are the source of truth for idempotent upserts.

**API responses use snake_case.** Controller `toResponse()` methods convert Drizzle camelCase rows to snake_case JSON matching `docs/api-contract.md`.

**Testing.** Server repo tests use PGlite (in-process PostgreSQL) for repository/search/jobs tests via `tests/database/test-db.ts` — no real PostgreSQL needed for unit tests. Health tests mock dependency checks. Python tests use in-memory repository doubles; OCR/transcribe tests inject fakes so CI never downloads PaddleOCR/Whisper weights.

### Python model deps by phase

- Phase 10: SigLIP (`torch`, `transformers`, `pillow`) — image/frame embeddings.
- Phase 11: `scenedetect` — video scene detection.
- Phase 12: faster-whisper (CTranslate2) — transcription.
- Phase 13: PaddleOCR — image/keyframe OCR.

## Node/pnpm Notes

- Node >=22 (`.nvmrc` is `22`); pnpm >=10 (`packageManager: pnpm@10.12.1`).
- ESM throughout (`"type": "module"`).
- Local TS imports must use `.js` extension (e.g. `import { foo } from './bar.js'`).
- pnpm runs each workspace from its own dir; the server loads `.env` from the monorepo root when present.

## Documentation Map

- `docs/architecture.md` — full architecture, module boundaries, tech stack decisions.
- `docs/api-contract.md` — HTTP API contract between frontend and backend.
- `docs/job-protocol.md` — job types, input/output schemas, claim rules, worker write boundaries.
- `docs/vector-index-design.md` — Qdrant collections, point structure, payload fields, FTS.
- `docs/implementation-plan.md` — phased plan (currently through Phase 13) with deliverables and acceptance criteria.
- `docs/tasks/todo.md` — phase tracking with checkboxes and review notes.
- `docs/tasks/lessons.md` — architectural decisions and reasoning.


1. Fail Fast / Errors Never Pass Silently：不要在代码里藏兜底逻辑来吞掉错误、隐藏问题。出了问题就应该让它爆出来，否则你永远找不到真实问题。
2. Fix the Cause, Not the Symptom / Don't Paper Over Bugs：当一个问题出现时，不要用各种 small fix、针对性补丁来掩盖它。必须定位真实根因，彻底修复。在 bug 上糊纸只会让系统积累你不知道的危险暗病。
3. Make It Observable：即使问题很难定位，也绝不要偷懒做表面修复。应该给项目增加充分的日志和可观测性，保证下次问题再现时你有足够信息去定位。问题无法修复时，只需要诚实告诉我信息不足、需新增日志，不要假装修好了。
4. Design for Debugging / Traceability：始终注意在关键路径上给自己留足排查日志，确保每一个关键节点都是可追溯的。
5. Living Documentation / Single Source of Truth：当项目关键技术栈或产品方向发生变更时，同步更新 agents.md。文档必须随代码一起演进，不能让它变成过时的谎言。


必须用中文回复。
