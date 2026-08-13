-- DashScope qwen3-vl-rerank 只返回 total_tokens，不返回输入/输出拆分或实际账单费用。
-- 放宽这三个汇总列使未知事实保存为 NULL；不改历史运行、不删除任何 Evaluation 数据。
ALTER TABLE "evaluation_shadow_runs" ALTER COLUMN "input_tokens" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "evaluation_shadow_runs" ALTER COLUMN "input_tokens" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "evaluation_shadow_runs" ALTER COLUMN "output_tokens" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "evaluation_shadow_runs" ALTER COLUMN "output_tokens" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "evaluation_shadow_runs" ALTER COLUMN "billed_cost_cny" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "evaluation_shadow_runs" ALTER COLUMN "billed_cost_cny" DROP NOT NULL;
