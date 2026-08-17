CREATE TABLE "agent_rerank_feedback" (
	"id" uuid PRIMARY KEY NOT NULL,
	"rerank_run_id" uuid NOT NULL,
	"verdict" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_rerank_rankings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"rerank_run_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"candidate_key" text NOT NULL,
	"rrf_rank" integer NOT NULL,
	"rerank_rank" integer,
	"relevance_score" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_rerank_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"protocol_version" text NOT NULL,
	"status" text DEFAULT 'preparing_evidence' NOT NULL,
	"external_call_status" text DEFAULT 'not_dispatched' NOT NULL,
	"provider" text DEFAULT 'dashscope' NOT NULL,
	"requested_model" text DEFAULT 'qwen3-vl-rerank' NOT NULL,
	"provider_request_id" text,
	"response_model" text,
	"model_snapshot" text,
	"region" text,
	"max_cost_cny" numeric NOT NULL,
	"query_fingerprint" text,
	"evidence_fingerprint" text,
	"response_fingerprint" text,
	"request_bytes" bigint,
	"input_tokens" integer,
	"output_tokens" integer,
	"total_tokens" integer,
	"billed_cost_cny" numeric,
	"estimated_cost_cny" numeric,
	"latency_ms" bigint,
	"error_code" text,
	"error_message" text,
	"error_details_json" jsonb,
	"dispatched_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_rerank_feedback" ADD CONSTRAINT "agent_rerank_feedback_rerank_run_id_agent_rerank_runs_id_fk" FOREIGN KEY ("rerank_run_id") REFERENCES "public"."agent_rerank_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_rerank_rankings" ADD CONSTRAINT "agent_rerank_rankings_rerank_run_id_agent_rerank_runs_id_fk" FOREIGN KEY ("rerank_run_id") REFERENCES "public"."agent_rerank_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_rerank_rankings" ADD CONSTRAINT "agent_rerank_rankings_candidate_id_agent_run_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."agent_run_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_rerank_runs" ADD CONSTRAINT "agent_rerank_runs_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_rerank_feedback_run_unique" ON "agent_rerank_feedback" USING btree ("rerank_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_rerank_rankings_candidate_unique" ON "agent_rerank_rankings" USING btree ("rerank_run_id","candidate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_rerank_rankings_rank_unique" ON "agent_rerank_rankings" USING btree ("rerank_run_id","rerank_rank");--> statement-breakpoint
CREATE INDEX "agent_rerank_rankings_run_rrf_idx" ON "agent_rerank_rankings" USING btree ("rerank_run_id","rrf_rank");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_rerank_runs_agent_run_unique" ON "agent_rerank_runs" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "agent_rerank_runs_status_idx" ON "agent_rerank_runs" USING btree ("status","created_at");