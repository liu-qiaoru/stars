CREATE TABLE "evaluation_vlm_blind_cases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dataset_id" uuid NOT NULL,
	"proposal_id" text NOT NULL,
	"source_evaluation_run_id" uuid NOT NULL,
	"source_candidate_id" uuid NOT NULL,
	"query_text" text NOT NULL,
	"candidate_key" text NOT NULL,
	"file_id" uuid NOT NULL,
	"scene_id" uuid NOT NULL,
	"start_time_seconds" numeric NOT NULL,
	"end_time_seconds" numeric NOT NULL,
	"proposed_group" text NOT NULL,
	"reviewed_group" text,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"selection_basis" text NOT NULL,
	"review_notes" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation_vlm_blind_conditions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"case_id" uuid NOT NULL,
	"condition_id" text NOT NULL,
	"kind" text NOT NULL,
	"source_text" text NOT NULL,
	"ordinal" integer NOT NULL,
	"first_verdict" text,
	"second_verdict" text,
	"final_verdict" text,
	"label_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation_vlm_blind_datasets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"schema_version" text NOT NULL,
	"status" text DEFAULT 'candidate_review' NOT NULL,
	"target_case_count" integer DEFAULT 60 NOT NULL,
	"proposal_fingerprint" text NOT NULL,
	"frozen_fingerprint" text,
	"frozen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evaluation_vlm_blind_cases" ADD CONSTRAINT "evaluation_vlm_blind_cases_dataset_id_evaluation_vlm_blind_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."evaluation_vlm_blind_datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_vlm_blind_conditions" ADD CONSTRAINT "evaluation_vlm_blind_conditions_case_id_evaluation_vlm_blind_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."evaluation_vlm_blind_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_vlm_blind_cases_dataset_proposal_unique" ON "evaluation_vlm_blind_cases" USING btree ("dataset_id","proposal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_vlm_blind_cases_dataset_candidate_unique" ON "evaluation_vlm_blind_cases" USING btree ("dataset_id","source_candidate_id");--> statement-breakpoint
CREATE INDEX "evaluation_vlm_blind_cases_dataset_status_idx" ON "evaluation_vlm_blind_cases" USING btree ("dataset_id","review_status");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_vlm_blind_conditions_case_condition_unique" ON "evaluation_vlm_blind_conditions" USING btree ("case_id","condition_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_vlm_blind_conditions_case_ordinal_unique" ON "evaluation_vlm_blind_conditions" USING btree ("case_id","ordinal");
