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
	"start_time_seconds" numeric,
	"end_time_seconds" numeric,
	"frame_time_seconds" numeric,
	"content_hash" text,
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
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_file_id_media_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."media_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vector_refs" ADD CONSTRAINT "vector_refs_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vector_refs" ADD CONSTRAINT "vector_refs_file_id_media_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."media_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vector_refs" ADD CONSTRAINT "vector_refs_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_run_events_run_id_idx" ON "agent_run_events" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_tool_calls_run_tool_call_unique" ON "agent_tool_calls" USING btree ("run_id","tool_call_id");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("status","priority","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "libraries_root_path_unique" ON "libraries" USING btree ("root_path");--> statement-breakpoint
CREATE INDEX "media_assets_file_id_idx" ON "media_assets" USING btree ("file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_files_library_path_unique" ON "media_files" USING btree ("library_id","path");--> statement-breakpoint
CREATE INDEX "media_files_library_id_idx" ON "media_files" USING btree ("library_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vector_refs_collection_point_unique" ON "vector_refs" USING btree ("collection_name","point_id");--> statement-breakpoint
CREATE INDEX "vector_refs_asset_id_idx" ON "vector_refs" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "vector_refs_file_id_idx" ON "vector_refs" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "vector_refs_library_id_idx" ON "vector_refs" USING btree ("library_id");
