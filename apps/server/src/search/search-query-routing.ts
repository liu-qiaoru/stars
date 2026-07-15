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
 * 根据目标向量模型调整查询版本权重。
 *
 * SigLIP 视觉集合使用英文为主的图文模型。`translate` 已经过独立语义等价校验，
 * 因此英文译文可以与中文原文同权竞争；否则 0.9 的基础权重会抵消译文较小但真实的
 * 原始余弦优势。`expand` 中的版本可能包含视觉改写或推断，仍保留 Provider 给出的降权，
 * Caption 等文本集合也保持原权重，避免这条视觉规则改变其他召回通道。
 */
export function routeQueryVariantsForCollection(
  variants: QueryVariant[],
  collection: VectorCollectionName,
  mode: QueryExpansionMode,
): QueryVariant[] {
  const config = VECTOR_COLLECTIONS[collection]
  const isSiglipVisualCollection =
    config.modelName === SIGLIP_MODEL_NAME &&
    (config.modality === 'image' || config.modality === 'video')
  if (mode !== 'translate' || !isSiglipVisualCollection) {
    return variants
  }

  return variants.map((variant) =>
    variant.source === 'deepseek' ? { ...variant, weight: 1 } : variant,
  )
}
