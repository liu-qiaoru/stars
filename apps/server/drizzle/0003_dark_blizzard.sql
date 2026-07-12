CREATE TABLE "evaluation_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"query_id" uuid NOT NULL,
	"candidate_key" text NOT NULL,
	"file_id" uuid NOT NULL,
	"scene_id" text,
	"media_type" text NOT NULL,
	"start_time_seconds" numeric,
	"end_time_seconds" numeric,
	"display_order" integer NOT NULL,
	"primary_pool" boolean DEFAULT true NOT NULL,
	"source_evidence_json" jsonb NOT NULL,
	"current_rank" integer NOT NULL,
	"current_score" numeric NOT NULL,
	"current_included" boolean DEFAULT true NOT NULL,
	"rrf_rank" integer NOT NULL,
	"rrf_score" numeric NOT NULL,
	"rrf_contributions_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation_judgments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"query_id" uuid NOT NULL,
	"candidate_key" text NOT NULL,
	"relevance" integer,
	"unjudgeable" boolean DEFAULT false NOT NULL,
	"diagnosis" text,
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
	"target_scene_id" text,
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
	"error_stage" text,
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
ALTER TABLE "evaluation_candidates" ADD CONSTRAINT "evaluation_candidates_file_id_media_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."media_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_judgments" ADD CONSTRAINT "evaluation_judgments_query_id_evaluation_queries_id_fk" FOREIGN KEY ("query_id") REFERENCES "public"."evaluation_queries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_queries" ADD CONSTRAINT "evaluation_queries_version_id_evaluation_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."evaluation_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_queries" ADD CONSTRAINT "evaluation_queries_target_file_id_media_files_id_fk" FOREIGN KEY ("target_file_id") REFERENCES "public"."media_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_version_id_evaluation_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."evaluation_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_versions" ADD CONSTRAINT "evaluation_versions_set_id_evaluation_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."evaluation_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_candidates_run_query_key_unique" ON "evaluation_candidates" USING btree ("run_id","query_id","candidate_key");--> statement-breakpoint
CREATE INDEX "evaluation_candidates_run_idx" ON "evaluation_candidates" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_judgments_query_candidate_unique" ON "evaluation_judgments" USING btree ("query_id","candidate_key");--> statement-breakpoint
CREATE INDEX "evaluation_queries_version_idx" ON "evaluation_queries" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "evaluation_runs_version_idx" ON "evaluation_runs" USING btree ("version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_versions_set_version_unique" ON "evaluation_versions" USING btree ("set_id","version");