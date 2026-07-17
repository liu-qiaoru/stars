// 公共排序纯函数模块：RRF（Reciprocal Rank Fusion，倒数排名融合）。
//
// 为什么独立成模块：生产搜索（阶段 5）和评测运行层（阶段 6 重建）都必须用同一份 RRF
// 公式，不能各自复制第二份实现。本文件不导入 NestJS、数据库、Qdrant 或任何业务模块，
// 因此任何层都可以安全复用。这里只做"根据各通道名次融合候选"的纯计算。
//
// RRF 直觉：不同召回通道（例如 SigLIP 视觉、Caption 文本、全文检索）各自给出一个候选
// 排名。RRF 不直接比较不同模型的原始分数（余弦分数、ts_rank 等量纲不同，不能当概率），
// 而是只用每个通道内部的"名次"。某个候选在某通道排第 r 名，就给一个贡献分
// 1 / (k + r)；k 越大，名次差异的影响越平缓。本项目固定 k=60、各通道单位权重。
// 最终 RRF 分数只用于决定先后顺序，不是相关概率，也不能跨通道比较绝对大小。

// 参与融合的召回通道标识。保留 visual / caption / lexical 三类，对应视觉向量、Caption
// 文本向量、全文检索。后续阶段若新增通道，需要在这里登记，并保证生产与评测同步。
export type RankingSignal = 'visual' | 'caption' | 'lexical'

// 单个待排序候选。candidateKey 是稳定的语义唯一键（图片用 asset id，视频用场景 UUID），
// 用来在并列时做确定性 tie-break，避免依赖数据库返回的偶然顺序。sourceRanks 给出该候选
// 在每个出现过的通道内的名次（从 1 开始，未出现的通道不参与贡献）。
export interface RankingCandidate {
  candidateKey: string
  sourceRanks: Partial<Record<RankingSignal, number>>
}

// rankByRrf 的输出：在输入基础上补上最终名次、RRF 分数、各通道贡献和主导通道。
export interface RrfRankingResult extends RankingCandidate {
  rank: number
  score: number
  contributions: Partial<Record<RankingSignal, number>>
  primarySignal: RankingSignal
}

// k 越大名次差异越平缓。k=60 是 RRF 论文与工程实践的常用值，本项目固定不可调，
// 避免不同阶段/不同人用不同 k 导致结果不可比。
const RRF_K = 60

// 通道处理顺序。这里的顺序只影响"主导通道选择"的并列裁决，不影响最终分数；显式列出
// 是为了让行为确定、可测试。
const SIGNAL_ORDER: RankingSignal[] = ['visual', 'caption', 'lexical']

/**
 * 用 RRF 把多通道候选融合成单一排序。
 *
 * 输入：每个候选带各自在各通道的名次（sourceRanks，名次从 1 开始）。
 * 输出：按 RRF 分数降序排列的结果，附带连续名次 rank=1..N。
 *
 * 规则：
 * - 每个出现的通道贡献 1 / (60 + 名次)。
 * - 候选总得分 = 各通道贡献之和（单位权重，不偏向任何通道）。
 * - 至少要有一个通道名次，否则抛错（防止静默产生无依据的候选）。
 * - 名次必须是 >= 1 的整数，否则抛错（fail fast，避免 0 或负名次扭曲贡献）。
 * - 并列（同分）按 candidateKey 字典序，保证排序稳定可复现。
 */
export function rankByRrf(candidates: RankingCandidate[]): RrfRankingResult[] {
  return candidates
    .map((candidate) => {
      const contributions: Partial<Record<RankingSignal, number>> = {}
      for (const signal of SIGNAL_ORDER) {
        const rank = candidate.sourceRanks[signal]
        if (rank !== undefined) {
          if (!Number.isInteger(rank) || rank < 1) {
            throw new Error(`invalid source rank signal=${signal} rank=${rank}`)
          }
          contributions[signal] = 1 / (RRF_K + rank)
        }
      }
      const entries = Object.entries(contributions) as [RankingSignal, number][]
      if (!entries.length) {
        // 没有任何通道名次的候选无法产生 RRF 分数，必须显式失败，不能默认 0 分混入排序。
        throw new Error(`candidate has no source ranks candidate_key=${candidate.candidateKey}`)
      }
      // 主导通道仅用于诊断展示（"这条结果主要靠哪个通道"），不参与分数计算。
      const primarySignal = entries.reduce((selected, current) =>
        current[1] > selected[1] ? current : selected,
      )[0]
      return {
        ...candidate,
        rank: 0,
        score: entries.reduce((sum, [, contribution]) => sum + contribution, 0),
        contributions,
        primarySignal,
      }
    })
    .sort(
      (left, right) =>
        // 先按 RRF 分数降序；同分按 candidateKey 字典序，保证多次运行结果一致。
        right.score - left.score || left.candidateKey.localeCompare(right.candidateKey),
    )
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }))
}
