-- 阶段 2：重建场景基础设施（与删除 OCR/segment 能力配套）。
-- 新增独立的 video_scenes 表保存视频场景身份与时间边界；media_assets 增加 scene_id 正式外键；
-- media_files 增加 index_generation（阶段 3 purge 重索引时递增）；jobs 增加结构化错误字段
-- （error_code / error_details_json）与单文件任务外键 file_id；补充热路径索引。
-- 删除阶段 2.1 已停用的 6 张旧评测表（阶段 6 会基于正式 video_scenes.id 重建评测）。
-- 注意：media_assets.text_tsv 全文生成列与 GIN 索引由 0001 维护、不在 schema.ts，本迁移不动。

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
ALTER TABLE "video_scenes" ADD CONSTRAINT "video_scenes_file_id_media_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."media_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "video_scenes_file_key_generation_unique" ON "video_scenes" USING btree ("file_id","scene_key","index_generation");--> statement-breakpoint
CREATE INDEX "video_scenes_file_id_idx" ON "video_scenes" USING btree ("file_id");--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "index_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "scene_id" uuid;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_scene_id_video_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."video_scenes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_assets_scene_id_idx" ON "media_assets" USING btree ("scene_id");--> statement-breakpoint
CREATE INDEX "media_assets_file_type_idx" ON "media_assets" USING btree ("file_id","asset_type");--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "error_details_json" jsonb;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "file_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_file_id_media_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."media_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_file_id_idx" ON "jobs" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "vector_refs_collection_status_idx" ON "vector_refs" USING btree ("collection_name","status");--> statement-breakpoint
-- 按外键依赖逆序删除旧评测表，避免遗留引用；源 media_files 不受影响。
DROP TABLE "evaluation_candidates";--> statement-breakpoint
DROP TABLE "evaluation_judgments";--> statement-breakpoint
DROP TABLE "evaluation_runs";--> statement-breakpoint
DROP TABLE "evaluation_queries";--> statement-breakpoint
DROP TABLE "evaluation_versions";--> statement-breakpoint
DROP TABLE "evaluation_sets";
