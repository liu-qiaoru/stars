CREATE TABLE "candidate_evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"candidate_key" text NOT NULL,
	"file_id" uuid NOT NULL,
	"file_generation" integer NOT NULL,
	"asset_id" uuid NOT NULL,
	"scene_id" uuid NOT NULL,
	"strategy" text NOT NULL,
	"protocol_version" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"job_id" uuid,
	"manifest_json" jsonb,
	"input_sha256" text,
	"artifact_sha256" text,
	"artifact_path" text,
	"artifact_mime_type" text,
	"artifact_width" integer,
	"artifact_height" integer,
	"artifact_byte_size" bigint,
	"error_code" text,
	"error_message" text,
	"error_details_json" jsonb,
	"retention_class" text DEFAULT 'cache_24h' NOT NULL,
	"expires_at" timestamp with time zone,
	"frozen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "candidate_evidence" ADD CONSTRAINT "candidate_evidence_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_evidence_identity_unique" ON "candidate_evidence" USING btree ("source_type","source_id","candidate_key","file_generation","strategy","protocol_version");--> statement-breakpoint
CREATE INDEX "candidate_evidence_job_idx" ON "candidate_evidence" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "candidate_evidence_expiry_idx" ON "candidate_evidence" USING btree ("retention_class","expires_at");