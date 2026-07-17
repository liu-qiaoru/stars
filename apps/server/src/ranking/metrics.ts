// 公共检索指标纯函数：Precision@K、nDCG@K、Hit@K、MRR。
//
// 为什么独立成模块：和 RRF 一样，这些指标公式只应存在一份，供评测运行层（阶段 6 重建）
// 使用；本文件不导入 NestJS、数据库、Qdrant 或任何业务模块，是纯计算。
//
// 两类查询使用不同指标，不能混用：
// - 自然发现查询（没有唯一正确目标，结果有分级相关）：用 Precision@K / nDCG@K。
// - 指定目标查询（只有一个预定正确目标）：用 Hit@K / MRR。
// calculateRankingMetrics 根据 knownTargetKey 是否为空自动切换这两套，避免调用方误用。

// 检索指标汇总。两类查询各用各的字段：发现查询填 precision*/ndcg*，目标查询填
// hit*/reciprocalRank；不适用字段为 null（而非 0），区分"不计算"和"算出来是 0"。
// unjudgeableCount 是被判为 null（无法判定相关等级）的候选数，用于报告标注覆盖度。
export interface RankingMetrics {
  precisionAt5: number | null
  precisionAt10: number | null
  ndcgAt10: number | null
  ndcgAt20: number | null
  hitAt5: number | null
  hitAt10: number | null
  hitAt20: number | null
  reciprocalRank: number | null
  unjudgeableCount: number
}

/**
 * 根据最终排序计算检索指标。
 *
 * @param rankedCandidateKeys 最终排序后的候选 key 列表（第一名在前）。
 * @param judgments 每个 key 的相关等级：2=高度相关，1=部分相关，0=不相关，null=无法判定。
 * @param options.knownTargetKey 若为指定目标查询，传唯一正确目标的 key；否则传 null 走发现查询指标。
 *
 * 指标方向（越大越好）：
 * - Precision@K：前 K 条中相关（>0）的比例。
 * - nDCG@K：前 K 条相关等级的折损累计增益，归一化到 [0,1]；高度相关越靠前分越高。
 * - Hit@K：指定目标是否出现在前 K 条（1/0）。
 * - reciprocalRank：指定目标第一次出现排名的倒数（排第 1 得 1，第 2 得 0.5）；未召回为 0。
 */
export function calculateRankingMetrics(
  rankedCandidateKeys: string[],
  judgments: Map<string, 0 | 1 | 2 | null>,
  options: { knownTargetKey: string | null },
): RankingMetrics {
  const unjudgeableCount = [...judgments.values()].filter((value) => value === null).length
  if (options.knownTargetKey !== null) {
    // 指定目标查询：只关心预定目标排到第几，不需要逐条相关等级。
    const targetIndex = rankedCandidateKeys.indexOf(options.knownTargetKey)
    const targetRank = targetIndex < 0 ? null : targetIndex + 1
    return {
      precisionAt5: null,
      precisionAt10: null,
      ndcgAt10: null,
      ndcgAt20: null,
      hitAt5: targetRank !== null && targetRank <= 5 ? 1 : 0,
      hitAt10: targetRank !== null && targetRank <= 10 ? 1 : 0,
      hitAt20: targetRank !== null && targetRank <= 20 ? 1 : 0,
      reciprocalRank: targetRank === null ? 0 : 1 / targetRank,
      unjudgeableCount,
    }
  }

  // 自然发现查询：把无法判定（null）的候选剔除后再算分级指标。
  const judged = rankedCandidateKeys.flatMap((key) => {
    const value = judgments.get(key)
    return value === undefined || value === null ? [] : [value]
  })
  return {
    precisionAt5: precisionAt(judged, 5),
    precisionAt10: precisionAt(judged, 10),
    ndcgAt10: ndcgAt(judged, 10),
    ndcgAt20: ndcgAt(judged, 20),
    hitAt5: null,
    hitAt10: null,
    hitAt20: null,
    reciprocalRank: null,
    unjudgeableCount,
  }
}

// Precision@K：前 K 条里相关（等级 > 0）的比例；候选不足 K 条时按实际条数算。
// 没有任何可判定候选时返回 null，表示"无法计算"而非"得分为 0"。
function precisionAt(relevance: number[], k: number) {
  const visible = relevance.slice(0, k)
  if (!visible.length) {
    return null
  }
  return visible.filter((value) => value > 0).length / visible.length
}

// nDCG@K：归一化折损累计增益，结果在 [0,1]。
// DCG = Σ (2^rel - 1) / log2(rank+1)：相关等级越高、排得越靠前，收益越大；用 2^rel-1
// 放大高相关结果的权重。IDC G 是同一组等级按理想（降序）排列的 DCG，作为归一化分母。
function ndcgAt(relevance: number[], k: number) {
  const visible = relevance.slice(0, k)
  if (!visible.length) {
    return null
  }
  const dcg = discountedGain(visible)
  const ideal = discountedGain([...visible].sort((left, right) => right - left))
  return ideal === 0 ? 0 : dcg / ideal
}

function discountedGain(relevance: number[]) {
  return relevance.reduce((sum, value, index) => sum + (2 ** value - 1) / Math.log2(index + 2), 0)
}
