CREATE TABLE "evaluation_vlm_blind_real_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"repetition" integer NOT NULL,
	"attempt_number" integer DEFAULT 1 NOT NULL,
	"retry_of_attempt_id" uuid,
	"step_attempt_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"external_call_status" text DEFAULT 'not_dispatched' NOT NULL,
	"request_fingerprint" text,
	"response_fingerprint" text,
	"response_model" text,
	"provider_request_id" text,
	"request_bytes" integer,
	"image_count" integer,
	"actual_sample_count" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"total_tokens" integer,
	"billed_cost_cny" numeric,
	"derived_status" text,
	"error_json" jsonb,
	"dispatched_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation_vlm_blind_real_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"attempt_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"derived_status" text NOT NULL,
	"output_json" jsonb,
	"error_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation_vlm_blind_real_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"labeling_session_id" uuid NOT NULL,
	"authorization_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider" text DEFAULT 'rightapi' NOT NULL,
	"requested_model" text DEFAULT 'qwen3.7-plus' NOT NULL,
	"protocol_version" text NOT NULL,
	"prompt_version" text NOT NULL,
	"dataset_fingerprint" text NOT NULL,
	"labels_fingerprint" text NOT NULL,
	"evidence_fingerprint" text NOT NULL,
	"case_count" integer NOT NULL,
	"planned_call_count" integer NOT NULL,
	"external_call_count" integer DEFAULT 0 NOT NULL,
	"succeeded_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"unknown_count" integer DEFAULT 0 NOT NULL,
	"max_calls" integer NOT NULL,
	"max_cost_cny" numeric NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"total_tokens" integer,
	"billed_cost_cny" numeric,
	"metrics_json" jsonb,
	"error_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "evaluation_vlm_blind_visual_authorizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"labeling_session_id" uuid NOT NULL,
	"dataset_fingerprint" text NOT NULL,
	"labels_fingerprint" text NOT NULL,
	"evidence_fingerprint" text NOT NULL,
	"preflight_fingerprint" text NOT NULL,
	"max_calls" integer NOT NULL,
	"max_cost_cny" numeric NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evaluation_vlm_blind_real_attempts" ADD CONSTRAINT "evaluation_vlm_blind_real_attempts_run_id_evaluation_vlm_blind_real_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."evaluation_vlm_blind_real_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_vlm_blind_real_attempts" ADD CONSTRAINT "evaluation_vlm_blind_real_attempts_case_id_evaluation_vlm_blind_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."evaluation_vlm_blind_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_vlm_blind_real_attempts" ADD CONSTRAINT "evaluation_vlm_blind_real_attempts_retry_of_attempt_id_evaluation_vlm_blind_real_attempts_id_fk" FOREIGN KEY ("retry_of_attempt_id") REFERENCES "public"."evaluation_vlm_blind_real_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_vlm_blind_real_results" ADD CONSTRAINT "evaluation_vlm_blind_real_results_attempt_id_evaluation_vlm_blind_real_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."evaluation_vlm_blind_real_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_vlm_blind_real_results" ADD CONSTRAINT "evaluation_vlm_blind_real_results_case_id_evaluation_vlm_blind_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."evaluation_vlm_blind_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_vlm_blind_real_runs" ADD CONSTRAINT "evaluation_vlm_blind_real_runs_labeling_session_id_evaluation_vlm_blind_labeling_sessions_id_fk" FOREIGN KEY ("labeling_session_id") REFERENCES "public"."evaluation_vlm_blind_labeling_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_vlm_blind_real_runs" ADD CONSTRAINT "evaluation_vlm_blind_real_runs_authorization_id_evaluation_vlm_blind_visual_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."evaluation_vlm_blind_visual_authorizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_vlm_blind_visual_authorizations" ADD CONSTRAINT "evaluation_vlm_blind_visual_authorizations_labeling_session_id_evaluation_vlm_blind_labeling_sessions_id_fk" FOREIGN KEY ("labeling_session_id") REFERENCES "public"."evaluation_vlm_blind_labeling_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_vlm_blind_real_attempts_slot_unique" ON "evaluation_vlm_blind_real_attempts" USING btree ("run_id","case_id","repetition","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_vlm_blind_real_attempts_step_unique" ON "evaluation_vlm_blind_real_attempts" USING btree ("step_attempt_id");--> statement-breakpoint
CREATE INDEX "evaluation_vlm_blind_real_attempts_run_status_idx" ON "evaluation_vlm_blind_real_attempts" USING btree ("run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_vlm_blind_real_results_attempt_unique" ON "evaluation_vlm_blind_real_results" USING btree ("attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_vlm_blind_real_runs_authorization_unique" ON "evaluation_vlm_blind_real_runs" USING btree ("authorization_id");--> statement-breakpoint
CREATE INDEX "evaluation_vlm_blind_real_runs_session_idx" ON "evaluation_vlm_blind_real_runs" USING btree ("labeling_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_vlm_blind_visual_authorizations_preflight_unique" ON "evaluation_vlm_blind_visual_authorizations" USING btree ("preflight_fingerprint");--> statement-breakpoint
CREATE INDEX "evaluation_vlm_blind_visual_authorizations_session_idx" ON "evaluation_vlm_blind_visual_authorizations" USING btree ("labeling_session_id");