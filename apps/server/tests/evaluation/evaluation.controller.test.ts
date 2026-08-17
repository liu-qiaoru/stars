import { Test } from '@nestjs/testing'
import { describe, expect, test, vi } from 'vitest'
import { EvaluationController } from '../../src/evaluation/evaluation.controller.js'
import { EvaluationService } from '../../src/evaluation/evaluation.service.js'
import { ShadowRerankService } from '../../src/evaluation/shadow-rerank.service.js'
import { VlmBlindDatasetService } from '../../src/evaluation/vlm-blind-dataset.service.js'
import { VlmBlindCapabilityService } from '../../src/evaluation/vlm-blind-capability.service.js'
import { VlmBlindLabelingService } from '../../src/evaluation/vlm-blind-labeling.service.js'

describe('evaluation controller dependency injection', () => {
  test('NestJS 向 Controller 注入 EvaluationService，使真实 HTTP 路由可以调用评测能力', async () => {
    // 开发模式由 tsx 直接运行 TypeScript，不能依赖编译器隐式生成的构造器类型元数据。
    // 这个测试复现 /evaluation/* 路由曾因 service=undefined 返回 HTTP 500 的问题。
    const service = {
      randomTargets: vi.fn().mockResolvedValue({ items: [] }),
      listRuns: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 25, offset: 0 }),
    }
    const shadowRerank = {
      findByEvaluationRun: vi.fn().mockResolvedValue(null),
      preview: vi.fn().mockResolvedValue({ external_call_count: 0, items: [] }),
      reconcileUsage: vi.fn().mockResolvedValue({ id: 'attempt-1' }),
      retryAndSchedule: vi.fn().mockResolvedValue({ id: 'shadow-run-2', execution_number: 2 }),
    }
    const vlmBlindDatasets = {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue({ id: 'dataset-1' }),
      importCandidateReviewPacket: vi.fn(),
      reviewCandidate: vi.fn(),
    }
    const vlmBlindLabeling = {
      get: vi.fn().mockResolvedValue({ dataset_id: 'dataset-1', candidate_status: 'frozen' }),
    }
    const vlmBlindCapability = {
      preflight: vi.fn().mockResolvedValue({ external_call_count: 0 }),
      smokePreflight: vi
        .fn()
        .mockResolvedValue({ execution_mode: 'smoke', external_call_count: 0 }),
      smokeRecoveryPreflight: vi
        .fn()
        .mockResolvedValue({ execution_mode: 'smoke_recovery', external_call_count: 0 }),
    }
    const moduleRef = await Test.createTestingModule({
      controllers: [EvaluationController],
      providers: [
        { provide: EvaluationService, useValue: service },
        { provide: ShadowRerankService, useValue: shadowRerank },
        { provide: VlmBlindDatasetService, useValue: vlmBlindDatasets },
        { provide: VlmBlindLabelingService, useValue: vlmBlindLabeling },
        { provide: VlmBlindCapabilityService, useValue: vlmBlindCapability },
      ],
    }).compile()

    try {
      const controller = moduleRef.get(EvaluationController)
      await expect(controller.randomTargets(undefined, '10', 'phase8')).resolves.toEqual({
        items: [],
      })
      expect(service.randomTargets).toHaveBeenCalledWith({
        libraryId: undefined,
        limit: 10,
        seed: 'phase8',
      })
      await expect(controller.listRuns('25', '0', undefined)).resolves.toMatchObject({ total: 0 })
      expect(service.listRuns).toHaveBeenCalledWith({
        limit: 25,
        offset: 0,
        versionId: undefined,
      })
      await expect(controller.getShadowRerank('run-id')).resolves.toBeNull()
      await expect(controller.previewShadowRerank('run-id')).resolves.toMatchObject({
        external_call_count: 0,
      })
      expect(shadowRerank.preview).toHaveBeenCalledWith('run-id')
      const reconciliationBody = {
        source: 'aliyun_model_monitor' as const,
        provider_request_id: 'provider-request-1',
        total_tokens: 25_640,
        text_input_tokens: 1_200,
        image_input_tokens: 24_440,
      }
      await expect(
        controller.reconcileShadowUsage('attempt-1', reconciliationBody),
      ).resolves.toEqual({ id: 'attempt-1' })
      expect(shadowRerank.reconcileUsage).toHaveBeenCalledWith('attempt-1', {
        source: 'aliyun_model_monitor',
        providerRequestId: 'provider-request-1',
        totalTokens: 25_640,
        textInputTokens: 1_200,
        imageInputTokens: 24_440,
      })
      await expect(controller.retryShadowRerank('run-id')).resolves.toMatchObject({
        execution_number: 2,
      })
      expect(shadowRerank.retryAndSchedule).toHaveBeenCalledWith('run-id')
      await expect(controller.preflightVlmBlindReal('dataset-1')).resolves.toMatchObject({
        external_call_count: 0,
      })
      expect(vlmBlindCapability.preflight).toHaveBeenCalledWith('dataset-1')
      await expect(controller.preflightVlmBlindSmoke('dataset-1')).resolves.toMatchObject({
        execution_mode: 'smoke',
        external_call_count: 0,
      })
      expect(vlmBlindCapability.smokePreflight).toHaveBeenCalledWith('dataset-1')
      await expect(controller.preflightVlmBlindSmokeRecovery('run-1')).resolves.toMatchObject({
        execution_mode: 'smoke_recovery',
        external_call_count: 0,
      })
      expect(vlmBlindCapability.smokeRecoveryPreflight).toHaveBeenCalledWith('run-1')
      await expect(controller.getVlmBlindLabeling('dataset-1')).resolves.toMatchObject({
        candidate_status: 'frozen',
      })
    } finally {
      await moduleRef.close()
    }
  })
})
