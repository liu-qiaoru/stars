CREATE TABLE "evaluation_shadow_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shadow_run_id" uuid NOT NULL,
	"query_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"external_call_status" text DEFAULT 'not_dispatched' NOT NULL,
	"provider_request_id" text,
	"response_model" text,
	"model_snapshot" text,
	"region" text,
	"query_fingerprint" text,
	"evidence_fingerprint" text,
	"response_fingerprint" text,
	"request_bytes" bigint,
	"input_tokens" integer,
	"output_tokens" integer,
	"total_tokens" integer,
	"latency_ms" bigint,
	"billed_cost_cny" numeric,
	"actual_candidate_count" integer DEFAULT 0 NOT NULL,
	"actual_result_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"error_details_json" jsonb,
	"not_applicable_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "evaluation_shadow_rankings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"attempt_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"candidate_key" text NOT NULL,
	"rrf_rank" integer NOT NULL,
	"shadow_rank" integer,
	"relevance_score" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation_shadow_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"evaluation_run_id" uuid NOT NULL,
	"protocol_version" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider" text DEFAULT 'dashscope' NOT NULL,
	"requested_model" text DEFAULT 'qwen3-vl-rerank' NOT NULL,
	"response_model" text,
	"model_snapshot" text,
	"region" text,
	"query_count" integer DEFAULT 0 NOT NULL,
	"succeeded_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"not_applicable_count" integer DEFAULT 0 NOT NULL,
	"actual_sample_count" integer DEFAULT 0 NOT NULL,
	"request_bytes" bigint DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" bigint DEFAULT 0 NOT NULL,
	"billed_cost_cny" numeric DEFAULT '0' NOT NULL,
	"error_code" text,
	"error_message" text,
	"error_details_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "evaluation_queries" ADD COLUMN "search_scope" text;--> statement-breakpoint
ALTER TABLE "evaluation_shadow_attempts" ADD CONSTRAINT "evaluation_shadow_attempts_shadow_run_id_evaluation_shadow_runs_id_fk" FOREIGN KEY ("shadow_run_id") REFERENCES "public"."evaluation_shadow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_shadow_attempts" ADD CONSTRAINT "evaluation_shadow_attempts_query_id_evaluation_queries_id_fk" FOREIGN KEY ("query_id") REFERENCES "public"."evaluation_queries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_shadow_rankings" ADD CONSTRAINT "evaluation_shadow_rankings_attempt_id_evaluation_shadow_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."evaluation_shadow_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_shadow_rankings" ADD CONSTRAINT "evaluation_shadow_rankings_candidate_id_evaluation_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."evaluation_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_shadow_runs" ADD CONSTRAINT "evaluation_shadow_runs_evaluation_run_id_evaluation_runs_id_fk" FOREIGN KEY ("evaluation_run_id") REFERENCES "public"."evaluation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_shadow_attempts_query_unique" ON "evaluation_shadow_attempts" USING btree ("shadow_run_id","query_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_shadow_attempts_idempotency_unique" ON "evaluation_shadow_attempts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "evaluation_shadow_attempts_status_idx" ON "evaluation_shadow_attempts" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_shadow_rankings_candidate_unique" ON "evaluation_shadow_rankings" USING btree ("attempt_id","candidate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_shadow_rankings_rank_unique" ON "evaluation_shadow_rankings" USING btree ("attempt_id","shadow_rank");--> statement-breakpoint
CREATE INDEX "evaluation_shadow_rankings_attempt_idx" ON "evaluation_shadow_rankings" USING btree ("attempt_id","rrf_rank");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_shadow_runs_identity_unique" ON "evaluation_shadow_runs" USING btree ("evaluation_run_id","protocol_version");--> statement-breakpoint
CREATE INDEX "evaluation_shadow_runs_status_idx" ON "evaluation_shadow_runs" USING btree ("status","created_at");