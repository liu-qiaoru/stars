# 索引、检索与面试理解专题研究计划

## 研究目标

本专题面向“项目已经实现，但尚不能从原理、源码和评测角度完整讲清楚”的作者，回答三个问题：

1. 原始图片、视频和音频如何逐步变成可检索的索引？
2. 一条自然语言查询如何经过不同检索通道得到最终结果？
3. 如何理解分数、建立最小评测体系，并在面试中用证据解释设计与优化？

本专题引用 `docs/code-research/` 的全局研究，只补充索引、检索、评测和面试表达所需的细节，不重复全局架构研究。

## 用户当前知识缺口

- 无法把 SigLIP、Transformer、Embedding、Qdrant 与索引、查询流程串起来。
- 不清楚视觉向量、OCR、语音转写、Caption 分别解决什么问题。
- 开发期间主要观察 Qdrant 返回的 score，不清楚 score 与检索质量的区别。
- 不理解 Top-K 命中率、Recall@K、MRR、NDCG，也没有建立人工标注评测集。
- 能描述技术栈，但尚不能从数据流、模块边界和设计取舍角度完成面试陈述。

## 研究主题与输出

| 输出文件 | 研究主题 | 核心问题 |
| --- | --- | --- |
| `01_retrieval_mechanism.md` | 索引与检索核心机制 | 每个工具是什么、为什么需要、如何协作，分数代表什么 |
| `02_retrieval_data_flow.md` | 端到端数据流与状态 | 文件、资产、向量引用、向量点、查询和结果如何流转 |
| `03_interview_learning_path.md` | 面试学习与评测路线 | 如何补基础、读源码、建立评测集、回答面试追问 |

## 证据范围

- 协议与数据模型：`packages/shared/`、`apps/server/src/database/schema.ts`
- 索引编排：`apps/server/src/jobs/`、`apps/worker-py/media_agent_worker/`
- 模型与向量库：model service、embedding worker、Qdrant 注册表与网关
- 搜索：`apps/server/src/search/`、相关仓库查询与 API 契约
- 设计依据：`docs/architecture.md`、`docs/vector-index-design.md`、`docs/job-protocol.md`
- 当前工作区包含未提交改动；专题以当前文件系统状态为准，并避免修改任何业务代码。

## 研究结论

### 一句话项目解释

系统在离线阶段把图片、视频帧和视觉描述转换成向量，把语音和画面文字转换成全文索引；在线阶段把查询转换到匹配的向量空间，从 Qdrant 与 PostgreSQL 多路召回候选，回 PostgreSQL 校验事实并补齐时间范围，最后进行场景折叠和混合排序。

### 阅读顺序

1. `01_retrieval_mechanism.md`：先理解 Transformer、SigLIP、Embedding、Qdrant、四条检索通道和三种分数。
2. `02_retrieval_data_flow.md`：再追踪文件、资产、向量引用、Qdrant point、查询候选和最终结果的完整生命周期。
3. `03_interview_learning_path.md`：最后学习指标、建立最小评测集，并用面试问题树训练表达和排障。

### 最重要的面试设计亮点

- 离线媒体 embedding 与在线查询 embedding 分离，分别满足可重试批处理和低延迟搜索。
- PostgreSQL 是事实源，Qdrant 是可重建召回索引；命中必须回表，避免把漂移 payload 当作业务事实。
- 视觉、OCR、转录和 Caption 覆盖互补意图，不把不同模型空间或不同尺度的原始分数直接混用。
- 视频使用多帧视觉证据，并按场景 MaxSim 折叠，兼顾召回覆盖与结果去重。
- asset 语义 upsert、确定性 UUIDv5 point id 和 Qdrant upsert 共同保证任务重试幂等。
- 搜索响应保留原始 `groups` 和最终 `results`，可区分索引、召回、回表和排序问题。

### 尚未被真实数据证明的结论

- 当前仓库没有固定人工标注集，不能从 score 或源码推出真实准确率、召回率或优化幅度。
- 混合排序的权重、阈值和多信号奖励是工程策略，尚不能声称为最优参数。
- 最终结果的 `confidence` 当前固定返回 `high`，不具备概率校准或质量评测意义。
- 下一步应固定真实查询集、媒体库快照、模型与配置，隐藏 score 做人工相关性标注，优先记录 Top-5 命中率、已标注集合上的 Recall@10、MRR、分类型错误和搜索延迟。

## 执行记录

- 研究日期：2026-07-11。
- 基于当前工作区源码研究；业务代码存在用户未提交改动，本专题未修改业务代码。
- 三个独立主题并行核对后，由主流程交叉检查并整合。
