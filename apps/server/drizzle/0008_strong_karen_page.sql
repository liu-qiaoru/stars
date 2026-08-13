DROP INDEX "evaluation_shadow_runs_identity_unique";--> statement-breakpoint
ALTER TABLE "evaluation_shadow_runs" ADD COLUMN "execution_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_shadow_runs_identity_unique" ON "evaluation_shadow_runs" USING btree ("evaluation_run_id","protocol_version","execution_number");