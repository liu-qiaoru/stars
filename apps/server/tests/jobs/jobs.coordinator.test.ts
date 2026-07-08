import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { JobsCoordinatorService } from "../../src/jobs/jobs-coordinator.service.js";
import type { JobsService } from "../../src/jobs/jobs.service.js";
import type { Settings } from "../../src/config/settings.js";

const enabledSettings = {
  jobCoordinatorEnabled: true,
  jobCoordinatorIntervalMs: 1000,
  jobCoordinatorEmbeddingLimit: 25,
  jobCoordinatorOcrLimit: 50,
} as Settings;

function createJobsService() {
  return {
    queuePendingEmbeddingJobs: vi.fn().mockResolvedValue({ scanned: 0, created: 0, skipped: 0 }),
    queuePendingOcrJobs: vi.fn().mockResolvedValue({ scanned: 0, created: 0, skipped: 0 }),
  } as unknown as JobsService;
}

describe("JobsCoordinatorService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("启动后立即协调 pending embedding 和 OCR，并按间隔继续协调", async () => {
    const jobsService = createJobsService();
    const coordinator = new JobsCoordinatorService(jobsService, enabledSettings);

    coordinator.onApplicationBootstrap();
    await Promise.resolve();
    await Promise.resolve();

    expect(jobsService.queuePendingEmbeddingJobs).toHaveBeenCalledWith(25);
    expect(jobsService.queuePendingOcrJobs).toHaveBeenCalledWith({ limit: 50 });

    await vi.advanceTimersByTimeAsync(1000);

    expect(jobsService.queuePendingEmbeddingJobs).toHaveBeenCalledTimes(2);
    expect(jobsService.queuePendingOcrJobs).toHaveBeenCalledTimes(2);

    coordinator.onApplicationShutdown();
  });

  test("关闭自动协调时不启动定时器也不创建任务", async () => {
    const jobsService = createJobsService();
    const coordinator = new JobsCoordinatorService(jobsService, {
      ...enabledSettings,
      jobCoordinatorEnabled: false,
    });

    coordinator.onApplicationBootstrap();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);

    expect(jobsService.queuePendingEmbeddingJobs).not.toHaveBeenCalled();
    expect(jobsService.queuePendingOcrJobs).not.toHaveBeenCalled();
  });

  test("上一轮协调未完成时跳过重入，避免重复创建 active jobs", async () => {
    const jobsService = createJobsService();
    let finishEmbedding!: () => void;
    vi.mocked(jobsService.queuePendingEmbeddingJobs).mockReturnValue(
      new Promise((resolve) => {
        finishEmbedding = () => resolve({ scanned: 0, created: 0, skipped: 0 });
      }),
    );
    const coordinator = new JobsCoordinatorService(jobsService, enabledSettings);

    coordinator.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(1000);

    expect(jobsService.queuePendingEmbeddingJobs).toHaveBeenCalledTimes(1);
    expect(jobsService.queuePendingOcrJobs).not.toHaveBeenCalled();

    finishEmbedding();
    await Promise.resolve();
    await Promise.resolve();

    expect(jobsService.queuePendingOcrJobs).toHaveBeenCalledTimes(1);

    coordinator.onApplicationShutdown();
  });
});
