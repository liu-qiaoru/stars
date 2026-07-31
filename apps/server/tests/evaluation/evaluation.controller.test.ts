import { Test } from '@nestjs/testing'
import { describe, expect, test, vi } from 'vitest'
import { EvaluationController } from '../../src/evaluation/evaluation.controller.js'
import { EvaluationService } from '../../src/evaluation/evaluation.service.js'

describe('evaluation controller dependency injection', () => {
  test('NestJS 向 Controller 注入 EvaluationService，使真实 HTTP 路由可以调用评测能力', async () => {
    // 开发模式由 tsx 直接运行 TypeScript，不能依赖编译器隐式生成的构造器类型元数据。
    // 这个测试复现 /evaluation/* 路由曾因 service=undefined 返回 HTTP 500 的问题。
    const service = {
      randomTargets: vi.fn().mockResolvedValue({ items: [] }),
    }
    const moduleRef = await Test.createTestingModule({
      controllers: [EvaluationController],
      providers: [{ provide: EvaluationService, useValue: service }],
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
    } finally {
      await moduleRef.close()
    }
  })
})
