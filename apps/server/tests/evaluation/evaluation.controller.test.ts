import { Test } from '@nestjs/testing'
import { describe, expect, test, vi } from 'vitest'
import { EvaluationController } from '../../src/evaluation/evaluation.controller.js'
import { EvaluationService } from '../../src/evaluation/evaluation.service.js'

describe('evaluation controller', () => {
  test('将评测集列表请求交给注入的 EvaluationService', async () => {
    const listSets = vi.fn().mockResolvedValue({ items: [] })
    const module = await Test.createTestingModule({
      controllers: [EvaluationController],
      providers: [{ provide: EvaluationService, useValue: { listSets } }],
    }).compile()
    const controller = module.get(EvaluationController)

    await expect(controller.listSets()).resolves.toEqual({ items: [] })
    expect(listSets).toHaveBeenCalledOnce()
  })
})
