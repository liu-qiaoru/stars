-- 任一已外发请求若结果未知，run 汇总 token/耗时也必须保持 NULL，不能按零或部分值
-- 低估费用与观察窗口。本迁移只放宽 Phase E 汇总列，不修改 attempt 或历史候选排名。
ALTER TABLE "evaluation_shadow_runs" ALTER COLUMN "total_tokens" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "evaluation_shadow_runs" ALTER COLUMN "total_tokens" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "evaluation_shadow_runs" ALTER COLUMN "latency_ms" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "evaluation_shadow_runs" ALTER COLUMN "latency_ms" DROP NOT NULL;
