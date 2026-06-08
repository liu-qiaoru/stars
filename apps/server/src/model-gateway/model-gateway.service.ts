import { BadGatewayException, Inject, Injectable } from '@nestjs/common'
import { z } from 'zod'
import { SETTINGS, type Settings } from '../config/settings.js'

const embeddingResponseSchema = z.object({
  model_name: z.string().min(1),
  model_version: z.string().min(1),
  vector: z.array(z.number()),
  vector_dim: z.number().int().positive(),
})

@Injectable()
export class ModelGatewayService {
  constructor(@Inject(SETTINGS) private readonly settings: Settings) {}

  async embedText(text: string, expectedVectorDim: number) {
    const response = await fetch(`${this.settings.modelServiceUrl}/embed/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(this.settings.modelServiceTimeoutMs),
    })
    if (!response.ok) {
      throw new BadGatewayException(`Model service /embed/text failed with ${response.status}`)
    }

    const parsed = embeddingResponseSchema.safeParse(await response.json())
    if (!parsed.success) {
      throw new BadGatewayException(`Model service returned invalid embedding: ${parsed.error.message}`)
    }
    if (parsed.data.vector_dim !== expectedVectorDim || parsed.data.vector.length !== expectedVectorDim) {
      throw new BadGatewayException(
        `Model service returned vector_dim=${parsed.data.vector_dim}, expected ${expectedVectorDim}`,
      )
    }
    return parsed.data.vector
  }
}
