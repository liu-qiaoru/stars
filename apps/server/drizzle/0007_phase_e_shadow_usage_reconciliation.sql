CREATE TABLE "evaluation_shadow_usage_reconciliations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"attempt_id" uuid NOT NULL,
	"source" text NOT NULL,
	"provider_request_id" text NOT NULL,
	"total_tokens" integer NOT NULL,
	"text_input_tokens" integer NOT NULL,
	"image_input_tokens" integer NOT NULL,
	"estimated_cost_cny" numeric NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evaluation_shadow_usage_reconciliations" ADD CONSTRAINT "evaluation_shadow_usage_reconciliations_attempt_id_evaluation_shadow_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."evaluation_shadow_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_shadow_usage_reconciliations_attempt_unique" ON "evaluation_shadow_usage_reconciliations" USING btree ("attempt_id");