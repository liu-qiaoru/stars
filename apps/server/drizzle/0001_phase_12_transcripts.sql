ALTER TABLE "media_assets" ADD COLUMN "text_content" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "text_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("text_content", ''))) STORED;--> statement-breakpoint
CREATE INDEX "media_assets_text_tsv_idx" ON "media_assets" USING gin ("text_tsv");--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_text_chunk_unique" ON "media_assets" USING btree ("file_id","start_time_seconds","end_time_seconds") WHERE "asset_type" = 'text_chunk';
