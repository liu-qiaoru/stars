import { BadGatewayException, Inject, Injectable } from '@nestjs/common'
import { z } from 'zod'
import { SETTINGS, type Settings } from '../config/settings.js'

const embeddingResponseSchema = z.object({
  model_name: z.string().min(1),
  model_version: z.string().min(1),
  vector: z.array(z.number()),
  vector_dim: z.number().int().positive(),
})

export interface TextEmbeddingExpectation {
  modelName: string
  modelVersion: string
  vectorDim: number
}

@Injectable()
export class ModelGatewayService {
  constructor(@Inject(SETTINGS) private readonly settings: Settings) {}

  async embedText(text: string, expected: TextEmbeddingExpectation | number) {
    const expectation =
      typeof expected === 'number'
        ? { vectorDim: expected, modelName: undefined, modelVersion: undefined }
        : expected
    const response = await fetch(`${this.settings.modelServiceUrl}/embed/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        ...(expectation.modelName ? { model_name: expectation.modelName } : {}),
        ...(expectation.modelVersion ? { model_version: expectation.modelVersion } : {}),
      }),
      signal: AbortSignal.timeout(this.settings.modelServiceTimeoutMs),
    })
    if (!response.ok) {
      throw new BadGatewayException(`Model service /embed/text failed with ${response.status}`)
    }

    const parsed = embeddingResponseSchema.safeParse(await response.json())
    if (!parsed.success) {
      throw new BadGatewayException(
        `Model service returned invalid embedding: ${parsed.error.message}`,
      )
    }
    if (
      parsed.data.vector_dim !== expectation.vectorDim ||
      parsed.data.vector.length !== expectation.vectorDim
    ) {
      throw new BadGatewayException(
        `Model service returned vector_dim=${parsed.data.vector_dim}, expected ${expectation.vectorDim}`,
      )
    }
    if (expectation.modelName && parsed.data.model_name !== expectation.modelName) {
      throw new BadGatewayException(
        `Model service returned model_name=${parsed.data.model_name}, expected ${expectation.modelName}`,
      )
    }
    if (expectation.modelVersion && parsed.data.model_version !== expectation.modelVersion) {
      throw new BadGatewayException(
        `Model service returned model_version=${parsed.data.model_version}, expected ${expectation.modelVersion}`,
      )
    }
    return parsed.data.vector
  }
}
