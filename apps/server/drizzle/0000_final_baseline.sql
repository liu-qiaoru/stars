CREATE TABLE "agent_run_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"tool_call_id" text,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"prompt" text NOT NULL,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_tool_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"tool_call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"status" text NOT NULL,
	"input_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output_json" jsonb,
	"error_message" text,
	"requires_confirmation" boolean DEFAULT false NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_type" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"timeout_seconds" integer DEFAULT 3600 NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"input_json" jsonb NOT NULL,
	"result_json" jsonb,
	"error_message" text,
	"error_code" text,
	"error_details_json" jsonb,
	"file_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "libraries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"root_path" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"file_id" uuid NOT NULL,
	"asset_type" text NOT NULL,
	"path" text,
	"scene_id" uuid,
	"start_time_seconds" numeric,
	"end_time_seconds" numeric,
	"frame_time_seconds" numeric,
	"content_hash" text,
	"text_content" text,
	"text_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce("text_content", ''))) STORED,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"library_id" uuid NOT NULL,
	"path" text NOT NULL,
	"relative_path" text NOT NULL,
	"media_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"mtime_ms" bigint NOT NULL,
	"content_hash" text,
	"index_status" text DEFAULT 'pending' NOT NULL,
	"duration_seconds" numeric,
	"width" integer,
	"height" integer,
	"codec" text,
	"index_generation" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "vector_refs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"asset_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"library_id" uuid NOT NULL,
	"collection_name" text NOT NULL,
	"point_id" uuid NOT NULL,
	"model_name" text NOT NULL,
	"model_version" text NOT NULL,
	"vector_kind" text NOT NULL,
	"vector_dim" integer NOT NULL,
	"distance" text NOT NULL,
	"content_hash" text NOT NULL,
	"index_profile" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video_scenes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"file_id" uuid NOT NULL,
	"scene_key" text NOT NULL,
	"start_time_seconds" numeric NOT NULL,
	"end_time_seconds" numeric NOT NULL,
	"detection_strategy" text NOT NULL,
	"strategy_fingerprint" text NOT NULL,
	"index_generation" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_candidates" ADD CONSTRAINT "evaluation_candidates_run_id_evaluation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."evaluation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_candidates" ADD CONSTRAINT "evaluation_candidates_query_id_evaluation_queries_id_fk" FOREIGN KEY ("query_id") REFERENCES "public"."evaluation_queries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_judgments" ADD CONSTRAINT "evaluation_judgments_candidate_id_evaluation_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."evaluation_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_queries" ADD CONSTRAINT "evaluation_queries_version_id_evaluation_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."evaluation_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_version_id_evaluation_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."evaluation_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_versions" ADD CONSTRAINT "evaluation_versions_set_id_evaluation_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."evaluation_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_file_id_media_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."media_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_file_id_media_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."media_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_scene_id_video_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."video_scenes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vector_refs" ADD CONSTRAINT "vector_refs_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vector_refs" ADD CONSTRAINT "vector_refs_file_id_media_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."media_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vector_refs" ADD CONSTRAINT "vector_refs_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_scenes" ADD CONSTRAINT "video_scenes_file_id_media_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."media_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_run_events_run_id_idx" ON "agent_run_events" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_tool_calls_run_tool_call_unique" ON "agent_tool_calls" USING btree ("run_id","tool_call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_candidates_run_query_key_unique" ON "evaluation_candidates" USING btree ("run_id","query_id","candidate_key");--> statement-breakpoint
CREATE INDEX "evaluation_candidates_run_idx" ON "evaluation_candidates" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_judgments_candidate_unique" ON "evaluation_judgments" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "evaluation_queries_version_idx" ON "evaluation_queries" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "evaluation_runs_version_idx" ON "evaluation_runs" USING btree ("version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_versions_set_version_unique" ON "evaluation_versions" USING btree ("set_id","version");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("status","priority" DESC NULLS LAST,"created_at");--> statement-breakpoint
CREATE INDEX "jobs_file_id_idx" ON "jobs" USING btree ("file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "libraries_root_path_unique" ON "libraries" USING btree ("root_path");--> statement-breakpoint
CREATE INDEX "media_assets_file_id_idx" ON "media_assets" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "media_assets_scene_id_idx" ON "media_assets" USING btree ("scene_id");--> statement-breakpoint
CREATE INDEX "media_assets_file_type_idx" ON "media_assets" USING btree ("file_id","asset_type");--> statement-breakpoint
CREATE INDEX "media_assets_text_tsv_idx" ON "media_assets" USING gin ("text_tsv");--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_text_chunk_unique" ON "media_assets" USING btree ("file_id","start_time_seconds","end_time_seconds") WHERE "media_assets"."asset_type" = 'text_chunk';--> statement-breakpoint
CREATE UNIQUE INDEX "media_files_library_path_unique" ON "media_files" USING btree ("library_id","path");--> statement-breakpoint
CREATE INDEX "media_files_library_id_idx" ON "media_files" USING btree ("library_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vector_refs_collection_point_unique" ON "vector_refs" USING btree ("collection_name","point_id");--> statement-breakpoint
CREATE INDEX "vector_refs_asset_id_idx" ON "vector_refs" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "vector_refs_file_id_idx" ON "vector_refs" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "vector_refs_library_id_idx" ON "vector_refs" USING btree ("library_id");--> statement-breakpoint
CREATE INDEX "vector_refs_collection_status_idx" ON "vector_refs" USING btree ("collection_name","status");--> statement-breakpoint
CREATE UNIQUE INDEX "video_scenes_file_key_generation_unique" ON "video_scenes" USING btree ("file_id","scene_key","index_generation");--> statement-breakpoint
CREATE INDEX "video_scenes_file_id_idx" ON "video_scenes" USING btree ("file_id");