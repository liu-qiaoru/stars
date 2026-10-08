-- Agent 审计与最终重排恢复：安全调用摘要单独保存，未知尝试不覆盖、不自动重放。
-- 旧表每个任务仅一行，attempt_no=1 能保留全部历史；之后按任务与尝试编号唯一。
-- completion_status 保存重排交接的目标状态，重启后无需重新调用决策模型。
CREATE TABLE "agent_run_trace_spans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"span_id" uuid NOT NULL,
	"parent_span_id" uuid,
	"component" text NOT NULL,
	"operation" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"attempt_no" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" bigint,
	"external_call_status" text DEFAULT 'not_dispatched' NOT NULL,
	"request_summary_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_summary_json" jsonb,
	"error_code" text,
	"error_message" text,
	"attributes_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "agent_rerank_runs_agent_run_unique";--> statement-breakpoint
ALTER TABLE "agent_rerank_runs" ADD COLUMN "attempt_no" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_rerank_runs" ADD COLUMN "completion_status" text;--> statement-breakpoint
ALTER TABLE "agent_run_trace_spans" ADD CONSTRAINT "agent_run_trace_spans_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_trace_spans_run_span_unique" ON "agent_run_trace_spans" USING btree ("run_id","span_id");--> statement-breakpoint
CREATE INDEX "agent_run_trace_spans_run_started_idx" ON "agent_run_trace_spans" USING btree ("run_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_rerank_runs_agent_attempt_unique" ON "agent_rerank_runs" USING btree ("agent_run_id","attempt_no");