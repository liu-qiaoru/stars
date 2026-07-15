import {
  SIGLIP_MODEL_NAME,
  VECTOR_COLLECTIONS,
  type VectorCollectionName,
} from '../qdrant/vector-collections.js'
import type {
  QueryExpansionMode,
  QueryVariant,
} from './query-expansion.service.js'

/**
 * 按目标向量模型选择真正参与检索的查询版本。
 *
 * `translate` 模式已经验证中英文语义等价，因此可以把语言适配交给各通道：
 * SigLIP 是英文图文模型，只接收英文译文；Caption 由 VLM（视觉语言模型）按中文 Prompt
 * 生成，只接收中文原文。这样错误候选不会再因为“不适合该模型的语言版本”获得高分。
 * `original` 和 `expand` 是独立的消融/实验模式，必须保持原行为，便于继续做可比评测。
 */
export function routeQueryVariantsForCollection(
  variants: QueryVariant[],
  collection: VectorCollectionName,
  mode: QueryExpansionMode,
): QueryVariant[] {
  if (mode !== 'translate') {
    return variants
  }

  if (collection === 'caption_text_vectors') {
    return variants.filter((variant) => variant.source === 'original')
  }

  const config = VECTOR_COLLECTIONS[collection]
  const isSiglipVisualCollection =
    config.modelName === SIGLIP_MODEL_NAME &&
    (config.modality === 'image' || config.modality === 'video')
  if (!isSiglipVisualCollection) {
    return variants
  }

  // translate 模式最多只有一个经过忠实性校验的 Provider 版本；恢复为 1.0 后，
  // 视觉分数只反映 SigLIP 的原始余弦相似度，不再被基础扩展权重二次压低。
  return variants
    .filter((variant) => variant.source === 'deepseek')
    .map((variant) => ({ ...variant, weight: 1 }))
}
