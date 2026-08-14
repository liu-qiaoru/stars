CREATE TABLE "evaluation_vlm_blind_fake_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"fake_run_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"status" text NOT NULL,
	"output_json" jsonb,
	"error_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation_vlm_blind_fake_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"labeling_session_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"provider" text DEFAULT 'fake' NOT NULL,
	"protocol_version" text DEFAULT 'vlm-review-v1' NOT NULL,
	"case_count" integer DEFAULT 0 NOT NULL,
	"succeeded_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"not_applicable_count" integer DEFAULT 0 NOT NULL,
	"external_call_count" integer DEFAULT 0 NOT NULL,
	"metrics_json" jsonb,
	"error_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "evaluation_vlm_blind_labeling_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dataset_id" uuid NOT NULL,
	"status" text DEFAULT 'labeling' NOT NULL,
	"labels_fingerprint" text,
	"labels_frozen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evaluation_vlm_blind_conditions" ADD COLUMN "first_labeled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "evaluation_vlm_blind_conditions" ADD COLUMN "second_labeled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "evaluation_vlm_blind_conditions" ADD COLUMN "final_labeled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "evaluation_vlm_blind_fake_results" ADD CONSTRAINT "evaluation_vlm_blind_fake_results_fake_run_id_evaluation_vlm_blind_fake_runs_id_fk" FOREIGN KEY ("fake_run_id") REFERENCES "public"."evaluation_vlm_blind_fake_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_vlm_blind_fake_results" ADD CONSTRAINT "evaluation_vlm_blind_fake_results_case_id_evaluation_vlm_blind_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."evaluation_vlm_blind_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_vlm_blind_fake_runs" ADD CONSTRAINT "evaluation_vlm_blind_fake_runs_labeling_session_id_evaluation_vlm_blind_labeling_sessions_id_fk" FOREIGN KEY ("labeling_session_id") REFERENCES "public"."evaluation_vlm_blind_labeling_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_vlm_blind_labeling_sessions" ADD CONSTRAINT "evaluation_vlm_blind_labeling_sessions_dataset_id_evaluation_vlm_blind_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."evaluation_vlm_blind_datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_vlm_blind_fake_results_run_case_unique" ON "evaluation_vlm_blind_fake_results" USING btree ("fake_run_id","case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_vlm_blind_fake_runs_session_unique" ON "evaluation_vlm_blind_fake_runs" USING btree ("labeling_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_vlm_blind_labeling_sessions_dataset_unique" ON "evaluation_vlm_blind_labeling_sessions" USING btree ("dataset_id");