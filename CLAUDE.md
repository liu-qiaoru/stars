# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Local-first multimodal media search and editing agent. TypeScript/NestJS main API, Python worker for media/model tasks, Next.js frontend (not yet implemented). ~1 TB personal media library target (video-heavy).

## Commands

```bash
# Install
pnpm install

# Full workspace check (typecheck + test for all packages)
pnpm check

# Server only
pnpm --filter @local-media-agent/server check    # typecheck + test
pnpm --filter @local-media-agent/server dev       # dev server on :4010 (or SERVER_PORT)

# Shared package only
pnpm --filter @local-media-agent/shared check     # generate schemas + typecheck + test

# Python worker tests (from repo root)
PYTHONPATH=apps/worker-py python3 -m unittest discover apps/worker-py/tests

# Database migration
pnpm --filter @local-media-agent/server exec drizzle-kit generate   # generate migration from schema changes
pnpm --filter @local-media-agent/server exec drizzle-kit migrate     # apply migrations

# Docker services
docker compose --env-file .env -f infra/docker-compose.yml up -d postgres qdrant
docker compose --env-file .env -f infra/docker-compose.yml config    # validate config
```

## Architecture

### Monorepo Layout

- `apps/server` — NestJS API (Express adapter, ESM). All business logic, HTTP endpoints, database access, Qdrant reads, agent runtime.
- `apps/worker-py` — Python worker. Claims jobs from PostgreSQL, executes media/model tasks (scan, probe, embed, transcribe, OCR, clip export). Writes to PostgreSQL and Qdrant.
- `packages/shared` — Zod schemas, TypeScript types, constants, generated JSON Schema for Python worker. **TypeScript owns all schemas.** Python reads generated JSON Schema, never imports TS code.
- `apps/web` — Next.js frontend. Not yet implemented (Phase 7).
- `infra/` — Docker Compose for PostgreSQL, Qdrant, optional Redis.
- `docs/` — Architecture decisions, API contract, job protocol, vector index design, implementation plan, task tracking.

### Key Patterns

**TypeScript is the schema authority.** Drizzle schema in `apps/server/src/database/schema.ts`. Zod job schemas in `packages/shared/schemas/`. Python uses raw SQL only — no ORM, no independent models.

**PostgreSQL-backed job queue.** TS server creates jobs (`INSERT INTO jobs ... status='queued'`). Python worker claims with `SELECT ... FOR UPDATE SKIP LOCKED`. No Dramatiq/Celery/BullMQ. See `docs/job-protocol.md`.

**Cross-language schema sync.** `packages/shared/scripts/generate-json-schemas.ts` converts Zod schemas to JSON Schema → `packages/shared/generated/job-schemas.json`. Python worker uses this for input validation. Run `generate:schemas` before tests if schemas changed.

**Qdrant write boundary.** Python worker writes all Qdrant points (mock vectors now, real embeddings later). TypeScript server only manages collections and reads for search. This avoids passing large vectors between processes.

**NestJS module structure.** Each domain is a standalone module (ConfigModule, HealthModule, DatabaseModule, LibrariesModule, JobsModule, etc.). Services use `@Inject(DATABASE)` for Drizzle, `@Inject(SETTINGS)` for config. No direct imports of infrastructure.

**Testing.** Server tests use PGlite (in-process PostgreSQL) for repository tests via `tests/database/test-db.ts`. No real PostgreSQL needed for unit tests. Health tests mock dependency checks. Python tests use in-memory repository doubles.

**API responses use snake_case.** Controller `toResponse()` methods convert Drizzle camelCase rows to snake_case JSON matching `docs/api-contract.md`.

## Node/pnpm Notes

- Node >=22 required (`.nvmrc` is `22`)
- ESM throughout (`"type": "module"` in package.json)
- If bare `pnpm` fails, use `corepack pnpm` or enable corepack: `corepack enable`
- Imports must use `.js` extension for local TS files (e.g., `import { foo } from "./bar.js"`)

## Documentation Map

- `docs/architecture.md` — Full architecture, module boundaries, tech stack decisions
- `docs/api-contract.md` — HTTP API contract between frontend and backend
- `docs/job-protocol.md` — Job types, input/output schemas, claim rules, worker boundaries
- `docs/vector-index-design.md` — Qdrant collections, point structure, payload fields
- `docs/implementation-plan.md` — 18-phase plan with deliverables and acceptance criteria
- `docs/tasks/todo.md` — Phase tracking with checkboxes and review notes
- `docs/tasks/lessons.md` — Architectural decisions and reasoning
