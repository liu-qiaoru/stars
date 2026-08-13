-- 实际账单费用与本地预算估算必须分开。新增列只保存按图片最高单价计算的保守估算，
-- 不回填历史运行，也不把估算值冒充 Provider 返回的 billed_cost_cny。
ALTER TABLE "evaluation_shadow_attempts" ADD COLUMN "estimated_cost_cny" numeric;--> statement-breakpoint
ALTER TABLE "evaluation_shadow_runs" ADD COLUMN "estimated_cost_cny" numeric;
