CREATE TABLE "evaluation_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"query_id" uuid NOT NULL,
	"candidate_key" text NOT NULL,
	"asset_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"scene_id" uuid,
	"file_generation" integer NOT NULL,
	"media_type" text NOT NULL,
	"start_time_seconds" numeric,
	"end_time_seconds" numeric,
	"source_evidence_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"current_rank" integer,
	"rrf_rank" integer,
	"blind_order" integer NOT NULL,
	"label_status" text DEFAULT 'pending' NOT NULL,
	"primary_pool" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation_judgments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"relevance" integer,
	"unjudgeable" boolean DEFAULT false NOT NULL,
	"diagnosis_json" jsonb,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation_queries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version_id" uuid NOT NULL,
	"query_text" text NOT NULL,
	"query_type" text NOT NULL,
	"intent_category" text NOT NULL,
	"must_have_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"optional_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exclusions_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"target_file_id" uuid,
	"target_scene_id" uuid,
	"target_asset_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"library_ids_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"config_json" jsonb NOT NULL,
	"corpus_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"report_json" jsonb,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "evaluation_sets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"set_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"frozen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evaluation_candidates" ADD CONSTRAINT "evaluation_candidates_run_id_evaluation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."evaluation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_candidates" ADD CONSTRAINT "evaluation_candidates_query_id_evaluation_queries_id_fk" FOREIGN KEY ("query_id") REFERENCES "public"."evaluation_queries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_judgments" ADD CONSTRAINT "evaluation_judgments_candidate_id_evaluation_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."evaluation_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_queries" ADD CONSTRAINT "evaluation_queries_version_id_evaluation_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."evaluation_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_version_id_evaluation_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."evaluation_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_versions" ADD CONSTRAINT "evaluation_versions_set_id_evaluation_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."evaluation_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_candidates_run_query_key_unique" ON "evaluation_candidates" USING btree ("run_id","query_id","candidate_key");--> statement-breakpoint
CREATE INDEX "evaluation_candidates_run_idx" ON "evaluation_candidates" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_judgments_candidate_unique" ON "evaluation_judgments" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "evaluation_queries_version_idx" ON "evaluation_queries" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "evaluation_runs_version_idx" ON "evaluation_runs" USING btree ("version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_versions_set_version_unique" ON "evaluation_versions" USING btree ("set_id","version");