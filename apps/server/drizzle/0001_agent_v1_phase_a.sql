-- Agent V1 Phase A 保留已应用的 0000 基线，以增量迁移建立 Server 租约状态机。
-- 本迁移只改 PostgreSQL 结构和旧 Agent 审计行；不删媒体、不改 Qdrant，也不要求重新索引。
CREATE TABLE "agent_run_authorizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"allow_external_text" boolean DEFAULT false NOT NULL,
	"allow_external_visual" boolean DEFAULT false NOT NULL,
	"text_scope_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"visual_scope_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_run_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"candidate_key" text NOT NULL,
	"file_id" uuid NOT NULL,
	"file_generation" integer NOT NULL,
	"asset_id" uuid NOT NULL,
	"scene_id" uuid,
	"scene_start_seconds" numeric,
	"scene_end_seconds" numeric,
	"rank" integer NOT NULL,
	"retrieval_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_run_inputs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"waiting_step_id" uuid,
	"step_attempt_id" uuid,
	"client_request_id" text NOT NULL,
	"input_type" text NOT NULL,
	"response_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_run_steps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"step_attempt_id" uuid NOT NULL,
	"step_kind" text NOT NULL,
	"status" text NOT NULL,
	"input_fingerprint" text,
	"input_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output_json" jsonb,
	"external_call_status" text DEFAULT 'not_dispatched' NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_side_effects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"effect_key" text NOT NULL,
	"tool_call_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"job_id" uuid,
	"confirmation_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "status" SET DEFAULT 'queued';--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "next_step" text DEFAULT 'extracting_intent' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "enforced_scope_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "lease_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "current_step_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "external_call_status" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "waiting_step_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "waiting_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "error_message" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "agent_run_authorizations" ADD CONSTRAINT "agent_run_authorizations_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_candidates" ADD CONSTRAINT "agent_run_candidates_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_inputs" ADD CONSTRAINT "agent_run_inputs_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_steps" ADD CONSTRAINT "agent_run_steps_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_side_effects" ADD CONSTRAINT "agent_side_effects_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_side_effects" ADD CONSTRAINT "agent_side_effects_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_authorizations_run_unique" ON "agent_run_authorizations" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_candidates_run_key_unique" ON "agent_run_candidates" USING btree ("run_id","candidate_key");--> statement-breakpoint
CREATE INDEX "agent_run_candidates_run_rank_idx" ON "agent_run_candidates" USING btree ("run_id","rank");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_inputs_client_request_unique" ON "agent_run_inputs" USING btree ("run_id","client_request_id");--> statement-breakpoint
CREATE INDEX "agent_run_inputs_run_idx" ON "agent_run_inputs" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_steps_attempt_unique" ON "agent_run_steps" USING btree ("step_attempt_id");--> statement-breakpoint
CREATE INDEX "agent_run_steps_run_idx" ON "agent_run_steps" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_side_effects_run_effect_unique" ON "agent_side_effects" USING btree ("run_id","effect_key");--> statement-breakpoint
CREATE INDEX "agent_runs_claim_idx" ON "agent_runs" USING btree ("status","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_waiting_expiry_idx" ON "agent_runs" USING btree ("status","waiting_expires_at");--> statement-breakpoint
-- 旧 running/waiting_for_confirmation 行没有规范化 step_attempt_id 和逐 run 授权，
-- 因此无法安全恢复或确认。保留它们的审计数据，但明确标记失败，避免新执行器猜测旧 Provider 进度。
UPDATE "agent_runs"
SET
	"status" = 'failed',
	"error_code" = 'AGENT_LEGACY_RUN_NOT_RECOVERABLE',
	"error_message" = 'Phase A 迁移无法安全恢复旧 Agent 活动 run。',
	"finished_at" = COALESCE("finished_at", now()),
	"updated_at" = now()
WHERE "status" IN ('running', 'waiting_for_confirmation');--> statement-breakpoint
-- 历史 run 缺少逐 run 授权事实；默认写入“文本/视觉均未授权”，绝不从旧全局开关推断用户授权。
INSERT INTO "agent_run_authorizations" (
	"id",
	"run_id",
	"allow_external_text",
	"allow_external_visual",
	"text_scope_json",
	"visual_scope_json"
)
SELECT
	"id",
	"id",
	false,
	false,
	'{"fields":[]}'::jsonb,
	'{"fields":[]}'::jsonb
FROM "agent_runs"
ON CONFLICT ("run_id") DO NOTHING;
