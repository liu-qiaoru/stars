# Scene MaxSim 与多关键帧 Caption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用真实的关键帧证据替代“中点单帧代表整个场景”的在线检索语义，并让 Qwen2.5-VL 基于同一 scene 的多张关键帧生成场景级 caption。

**Architecture:** 保留 `video_segment` 作为场景边界和 caption 容器，但停止把其中点帧向量作为 segment 级在线召回信号。所有视频场景必须至少产生一个 `video_frame` 视觉向量；搜索先查询 `video_frame_vectors`，再按 `(file_id, scene_id)` 做 MaxSim 聚合并从 PostgreSQL 补齐场景边界。Caption 继续以 `video_segment` 为任务入口，但 worker 会查找同 scene 的关键帧、临时抽取多张图片并一次性发送给 Qwen2.5-VL。

**Tech Stack:** NestJS/TypeScript、Drizzle/PostgreSQL、Qdrant、Vitest/PGlite、Python 3.12 worker、FFmpeg、Qwen2.5-VL（Ollama 默认，Transformers 备用）、unittest。

## Global Constraints

- PostgreSQL 继续作为事实来源；Qdrant 只保存向量和轻量 payload。
- `video_segment` 资产保留；只移除不可靠的 `video_segment_vectors` 新建与在线召回。
- 不删除已有 Qdrant points；旧 `vector_refs` 标记 stale，保留审计性。
- 每个有效视频 scene 或固定 30 秒 fallback segment 必须至少有一个 `video_frame`，否则不得关闭 segment 向量召回。
- Scene MaxSim 必须按 `(file_id, scene_id)` 聚合；不能用“相邻 5 秒”代替 scene 身份。
- MaxSim 分数取同 scene 已召回 `video_frame_vectors` 的最大 cosine；最佳帧是结果代表 asset。
- 原始 `groups` 保留逐帧 Qdrant 结果用于调试；只有 top-level `results` 使用 scene 聚合候选。
- Scene detection 只负责发现镜头切换；检测后必须将超过 `SCENE_MAX_SECONDS=30` 的长 scene 再切成连续时间窗，不能让任意长度视频成为一个检索/caption 单元。
- 多关键帧 caption 使用该 30 秒时间窗内全部已选关键帧，按时间升序；`SCENE_CAPTION_MAX_FRAMES=6` 只作为防御性资源上限，不承担长视频覆盖职责。
- 图片文件只做临时抽取；成功与失败路径都必须清理，不新增持久帧缓存。
- `caption-v1` 保持可读取和执行，保证旧队列兼容；视频新任务使用 `scene-caption-v2`。
- `scene-caption-v2` 只描述采样帧可证明的主体、环境、动作变化和可见文字，不推断帧间未展示事件。
- 模型名、模型版本、prompt 版本、source asset IDs、frame times、scene ID、错误原因必须可追踪。
- 任何向量维度、场景边界、scene ID 或 VLM 响应不一致都直接失败，不做静默兜底。

---

## 实施前核对结论

这份计划有意把原先讨论的“先直接移除 `video_segment_vectors`”调整为更安全的顺序：

1. 先把超长 scene 切成最长 30 秒的连续时间窗，并建立每个时间窗都有 `video_frame` 的索引不变量。
2. 再实现 scene-level MaxSim。
3. 验证旧数据完成重索引后，才关闭 `video_segment_vectors` 在线召回。
4. 最后把单代表帧 caption 升级为多关键帧 caption。

原因有两个：当前 `fixed_30s` fallback 只创建 `video_segment`，且 `KEYFRAME_DENSITY=light` 的短 scene 可能没有额外 `video_frame`；另一方面，PySceneDetect 检测的是镜头切换，不是语义事件，固定镜头的长视频可能成为一个超长 scene。如果立即关闭 segment 召回或只限制 caption 图片数，会分别造成视觉召回缺失或长时间内容覆盖不足。

## 文件结构

- `apps/worker-py/media_agent_worker/indexing.py`：保证每个 segment 至少创建中点 `video_frame`，停止为 `video_segment` 创建新视觉 vector ref。
- `apps/worker-py/media_agent_worker/repository.py`：查询同 scene 的 caption 帧；失效旧 segment vector refs。
- `apps/server/src/database/repositories.ts`：批量查询命中 frame 对应的 scene 边界。
- `apps/server/src/search/search-scene-maxsim.ts`：纯函数实现 scene MaxSim；不访问数据库或 Qdrant。
- `apps/server/src/search/search.service.ts`：编排逐帧召回、scene 边界补齐和 top-level 聚合；停止查询 `video_segment_vectors`。
- `apps/worker-py/media_agent_worker/captioning.py`：多帧选择、临时抽帧、VLM 请求、清理和 caption metadata。
- `apps/worker-py/media_agent_worker/vlm_service.py`：`/caption` 同时支持单图 v1 和多图 v2，Ollama/Transformers 后端保持一致语义。
- `packages/shared/schemas/index.ts`：声明 `scene-caption-v2`，继续兼容 `caption-v1`。
- `apps/server/src/jobs/jobs.controller.ts`、`apps/server/src/jobs/jobs.service.ts`：提供可审计、可 dry-run 的现有视频批量重索引入口。
- `apps/web/components/search-workspace.tsx`：展示覆盖结果区域的明确搜索 loading 与可见错误。
- `apps/web/components/jobs-workspace.tsx`、`apps/web/app/jobs/page.tsx`：25 条分页、当前页自动刷新和独立任务卡片间距。
- `docs/api-contract.md`、`docs/job-protocol.md`、`docs/vector-index-design.md`、`docs/architecture.md`、`AGENTS.md`：更新单一事实来源。

---

### Task 1: 限制场景时间窗并建立 video_frame 覆盖不变量

**Files:**
- Modify: `apps/worker-py/media_agent_worker/indexing.py`
- Modify: `apps/worker-py/media_agent_worker/repository.py`
- Test: `apps/worker-py/tests/test_index_worker.py`

**Interfaces:**
- Produces: 每个 `video_segment` 对应至少一个带相同 `scene_id` 的 `video_frame`；中点帧使用 `keyframe_index=0` 和 `metadata_json.is_scene_representative=true`。
- Produces: scene detection 使用 `scene-0001` 形式的稳定 ID；fixed/fallback segment 使用 `segment-0001` 形式的稳定 ID，不再写入 `scene_id=null`。
- Produces: `split_long_scenes(scenes, max_seconds=30.0)`；任何最终 segment 的 duration 都不超过 30 秒。
- Produces: `ContentDetector.min_scene_len` 使用 `"3.0s"` 或 float 秒值，不能把整数 `3` 误传成 3 frames。
- Produces: 新索引不再为 `video_segment` 创建 `video_segment_vectors` ref，但仍创建 segment asset。
- Produces: `MediaRepository.mark_video_segment_vector_refs_stale(file_id) -> int`。

- [ ] **Step 1: 写失败测试，覆盖三分钟固定镜头的时间窗切分**

输入 detector 返回的单一 `(0.0, 180.0)` scene，期望得到 6 个连续 segment：`0～30`、`30～60`、`60～90`、`90～120`、`120～150`、`150～180`。断言无重叠、无空隙，最后一段允许短于 30 秒。

同时使用 fake detector 验证 `SCENE_MIN_SECONDS=3` 以秒值传递；当前 `max(1, int(min_scene_seconds))` 会把 3 作为 frame count，测试必须先失败。

- [ ] **Step 2: 写失败测试，覆盖 scene detection 的中点 frame**

在 `test_index_worker.py` 增加断言：一个 scene 必须同时产生一个 `video_segment` 和一个中点 `video_frame`；二者共享 `scene_id`，只有 frame 创建 `video_frame_vectors` ref，segment 不创建 `video_segment_vectors` ref。

```python
self.assertEqual(segment["metadata_json"]["scene_id"], midpoint_frame["metadata_json"]["scene_id"])
self.assertTrue(midpoint_frame["metadata_json"]["is_scene_representative"])
self.assertEqual(midpoint_frame["frame_time_seconds"], 5.0)
self.assertNotIn("video_segment_vectors", collections)
self.assertIn("video_frame_vectors", collections)
```

- [ ] **Step 3: 写失败测试，覆盖 fixed_30s fallback 与 light 短场景**

验证 detector 失败后的每个 30 秒 segment，以及 `KEYFRAME_DENSITY=light` 的短 scene，都至少产生中点 `video_frame`。预期当前测试失败，因为 `_fixed_30s_asset_inputs()` 只创建 segment，light 短 scene 不创建额外 frame。

- [ ] **Step 4: 运行索引测试确认失败**

Run:

```bash
PYTHONPATH=apps/worker-py python3.12 -m unittest discover -s apps/worker-py/tests -p test_index_worker.py
```

Expected: FAIL，缺少中点 `video_frame` 或仍存在 `video_segment_vectors` ref。

- [ ] **Step 5: 实现长 scene 二次时间窗切分**

`merge_short_scenes()` 之后调用 `split_long_scenes()`。每个原始 scene 按 30 秒连续切分，稳定 ID 使用 `scene-0001-part-001`；未超过上限的 scene 保持 `scene-0001`。metadata 同时记录原始检测 scene ID、part index 和 `scene_max_seconds=30`，便于追踪为什么产生边界。

将 `ContentDetector` 的 `min_scene_len` 改为秒语义，例如 `min_scene_len=f"{min_scene_seconds}s"`，并保留后置 `merge_short_scenes()` 作为数据不变量校验。

- [ ] **Step 6: 将 segment asset 与 vector ref 创建解耦**

让 asset input 的 `collection_name` 可选。`video_segment` 只 upsert PostgreSQL asset；`video_frame` 才生成确定性 point ID 和 pending vector ref。中点 frame 的 content hash 必须包含 file ID、scene ID、frame time 和 `representative` 标识，避免与旧 segment point 混用。

核心形状：

```python
{
    "asset_type": "video_frame",
    "frame_time_seconds": midpoint,
    "content_hash": f"{file['id']}:scene:{scene_id}:representative:{midpoint:g}",
    "metadata_json": {
        "scene_id": scene_id,
        "keyframe_index": 0,
        "is_scene_representative": True,
        "segment_strategy": strategy,
        "keyframe_density": self.keyframe_density,
    },
    "collection_name": "video_frame_vectors",
}
```

- [ ] **Step 7: 失效同文件旧 segment vector refs**

在重索引事务中将该 file 的 active `video_segment_vectors` refs 标为 `stale`。不能删除 Qdrant point 或数据库行；返回失效数量并写入 index job 输出日志，便于核对迁移范围。

同时为 fixed/fallback segment 分配稳定 `segment-0001` ID，并写入 segment 与其中点 frame 的 metadata，确保后续 MaxSim 和多帧 caption 可以使用同一身份键。

- [ ] **Step 8: 运行测试确认通过**

Run:

```bash
PYTHONPATH=apps/worker-py python3.12 -m unittest discover -s apps/worker-py/tests -p test_index_worker.py
```

Expected: PASS。

- [ ] **Step 9: Commit**

```bash
git add apps/worker-py/media_agent_worker/indexing.py apps/worker-py/media_agent_worker/repository.py apps/worker-py/tests/test_index_worker.py
git commit -m "feat: guarantee frame vectors for every video scene"
```

---

### Task 2: 实现 scene-level MaxSim 聚合

**Files:**
- Create: `apps/server/src/search/search-scene-maxsim.ts`
- Modify: `apps/server/src/database/repositories.ts`
- Modify: `apps/server/src/search/search-hybrid.ts`
- Modify: `apps/server/src/search/search.service.ts`
- Test: `apps/server/tests/search/search-scene-maxsim.test.ts`
- Test: `apps/server/tests/search/search.service.test.ts`

**Interfaces:**
- Produces: `listVideoSceneBounds(db, keys)`，按 `(fileId, sceneId)` 返回 active `video_segment` 的边界。
- Produces: `collapseVideoFramesByScene(candidates, sceneBounds)`，每个 scene 返回一个以最佳帧为代表的候选。
- Consumes: hydrated `video_frame_vectors` candidates，包含 `asset_id`、`file_id`、`scene_id`、frame time 和 cosine score。

- [ ] **Step 1: 写纯函数失败测试**

覆盖以下行为：

```ts
expect(collapseVideoFramesByScene([
  frame('frame-5', 'scene-1', 5, 0.82),
  frame('frame-15', 'scene-1', 15, 0.91),
  frame('frame-25', 'scene-1', 25, 0.76),
], bounds('scene-1', 0, 30))).toEqual([
  expect.objectContaining({
    asset_id: 'frame-15',
    start_time_seconds: 0,
    end_time_seconds: 30,
    score: 0.91,
    scene_id: 'scene-1',
    merged_asset_ids: ['frame-5', 'frame-15', 'frame-25'],
  }),
])
```

另行覆盖：不同 file 的相同 scene ID 不合并、`scene_id=null` 不跨 asset 合并、缺失 scene boundary 时抛出包含 file ID/scene ID 的错误。

- [ ] **Step 2: 运行纯函数测试确认失败**

Run:

```bash
corepack pnpm --filter @local-media-agent/server exec vitest run tests/search/search-scene-maxsim.test.ts
```

Expected: FAIL，模块或导出不存在。

- [ ] **Step 3: 实现 scene MaxSim 纯函数**

按 `${file_id}|${scene_id}` 分组；`score` 最大的 frame 决定代表 `asset_id` 和证据时间；scene 的 `start_time_seconds/end_time_seconds` 必须来自 PostgreSQL segment asset。相同分数时按原始召回顺序稳定选择，不按 asset ID 随机漂移。

- [ ] **Step 4: 扩展 HybridCandidateInput 以保留 scene 证据帧**

将 `merged_asset_ids` 改为可选输入，并在 `toMergeCandidate()` 中使用：

```ts
merged_asset_ids: candidate.merged_asset_ids?.length
  ? [...candidate.merged_asset_ids]
  : [candidate.asset_id]
```

这样 MaxSim 不会在后续 hybrid merge 中丢掉其他命中帧。

- [ ] **Step 5: 增加 PostgreSQL scene boundary 批量查询**

查询 active `media_assets.asset_type='video_segment'`，读取 `metadata_json.scene_id`、开始和结束时间。输入为空直接返回空数组；同一 `(file_id, scene_id)` 出现多个 active segment 时抛错，禁止静默选择。

- [ ] **Step 6: 在 SearchService 中只对 top-level candidates 做 scene 聚合**

`groups` 保持逐帧结果，方便观察 Qdrant 原始召回。构造 top-level hybrid candidates 前：

1. 收集 `video_frame_vectors` 命中的 `(file_id, scene_id)`。
2. 一次查询 scene bounds。
3. 调用 `collapseVideoFramesByScene()`。
4. 将其他 image、caption、FTS candidates 原样加入 hybrid reranker。

- [ ] **Step 7: 运行 server 搜索测试**

Run:

```bash
corepack pnpm --filter @local-media-agent/server exec vitest run tests/search/search-scene-maxsim.test.ts tests/search/search.service.test.ts tests/search/search-hybrid.test.ts
```

Expected: PASS；同 scene 相隔超过 5 秒的 frame 仍合并，分数为最大 frame cosine。

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/search/search-scene-maxsim.ts apps/server/src/database/repositories.ts apps/server/src/search/search-hybrid.ts apps/server/src/search/search.service.ts apps/server/tests/search
git commit -m "feat: aggregate video frame hits with scene maxsim"
```

---

### Task 3: 关闭 video_segment_vectors 在线召回

**Files:**
- Modify: `apps/server/src/search/search.service.ts`
- Modify: `apps/server/src/config/settings.ts`
- Modify: `.env.example`
- Modify: `apps/server/tests/search/search.service.test.ts`
- Modify: `docs/api-contract.md`
- Modify: `docs/vector-index-design.md`

**Interfaces:**
- Consumes: Task 1 的 scene frame 覆盖不变量与 Task 2 的 MaxSim。
- Produces: 迁移开关 `VIDEO_SEGMENT_SEARCH_ENABLED`；部署迁移期间默认 `true`，readiness 通过后显式设为 `false`。
- Produces: 开关为 `false` 时视频视觉搜索只查询 `video_frame_vectors`；`video_segment_vectors` 不出现在新响应的 `groups` 或 `source_scores`。

- [ ] **Step 1: 写失败测试固定 collection 选择**

断言开关为 `false` 时视频搜索调用 `video_frame_vectors`，不调用 `video_segment_vectors`；开关为 `true` 时保持迁移兼容。image、caption 与 FTS 行为保持不变。

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
corepack pnpm --filter @local-media-agent/server exec vitest run tests/search/search.service.test.ts
```

Expected: FAIL，当前 `baseSearchCollections` 仍包含 `video_segment_vectors`。

- [ ] **Step 3: 用显式迁移开关控制 segment collection**

基础 collection 固定为 image/frame；仅在迁移开关为 true 时追加 segment：

```ts
const baseSearchCollections = [
  { collection: 'image_vectors', mediaTypes: ['image'] },
  { collection: 'video_frame_vectors', mediaTypes: ['video'] },
] as const
```

不要删除 collection registry；保留旧 point 的读取/诊断能力和协议兼容性。开关只服务一次性数据迁移，readiness 通过后 `.env` 必须设为 `false`；后续单独清理迁移开关，不在本计划内。

- [ ] **Step 4: 更新 API 与向量设计文档**

明确 `video_segment_vectors` 已停止新建和在线召回；`video_segment` 仍承担边界、caption source 与剪辑定位。视频视觉结果来自 frame MaxSim，并公开最佳 frame asset 与所有 `merged_asset_ids`。

- [ ] **Step 5: 运行 server check**

Run:

```bash
corepack pnpm --filter @local-media-agent/server check
```

Expected: typecheck 和测试全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add .env.example apps/server/src/config/settings.ts apps/server/src/search/search.service.ts apps/server/tests/search/search.service.test.ts docs/api-contract.md docs/vector-index-design.md
git commit -m "fix: stop querying midpoint segment vectors"
```

---

### Task 4: 升级 Qwen2.5-VL 多关键帧 scene caption

**Files:**
- Modify: `packages/shared/schemas/index.ts`
- Regenerate: `packages/shared/generated/job-schemas.json`
- Modify: `apps/worker-py/media_agent_worker/repository.py`
- Modify: `apps/worker-py/media_agent_worker/captioning.py`
- Modify: `apps/worker-py/media_agent_worker/vlm_service.py`
- Modify: `apps/worker-py/tests/test_captioning_worker.py`
- Modify: `apps/worker-py/tests/test_vlm_service.py`
- Modify: `apps/worker-py/tests/test_index_worker.py`

**Interfaces:**
- Produces: `prompt_version` 支持 `'caption-v1' | 'scene-caption-v2'`。
- Produces: `MediaRepository.list_scene_caption_frames(file_id, scene_id)`，按时间升序返回同 scene active frames。
- Produces: `VlmCaptionClient.caption(image_paths, frame_times_seconds, prompt_version, model_name, model_version)`。
- Produces: `/caption` v2 request 接受 `image_paths: string[]` 和 `frame_times_seconds: number[]`。

- [ ] **Step 1: 扩展 shared schema 并写 schema 测试**

视频新 job 使用 `scene-caption-v2`，旧 `caption-v1` 继续通过；其他字符串必须失败。运行 shared check 重新生成 JSON Schema。

Run:

```bash
corepack pnpm --filter @local-media-agent/shared check
```

Expected: PASS，生成 schema 同时包含两个 literal。

- [ ] **Step 2: 写多帧选择失败测试**

覆盖：

- 同 scene frames 按时间升序；
- 对不超过 30 秒的 scene 使用全部已索引 frames；
- 中点代表帧必须包含；
- 如果数据异常导致 frames 超过 `SCENE_CAPTION_MAX_FRAMES=6`，任务直接失败并输出 file/scene/frame count，不静默丢帧；
- 不混入其他 scene 或 file 的 frame；
- scene 没有 frame 时直接失败。

- [ ] **Step 3: 写临时文件清理失败测试**

分别模拟第二张抽帧失败、VLM HTTP 失败、VLM 空 caption、model metadata 不一致；每种情况下已经创建的临时图片都必须被删除，且不得创建 caption asset/vector ref。

- [ ] **Step 4: 实现 scene frame 查询与确定性采样**

caption job 仍以 `video_segment` source asset ID 启动。handler 从 segment metadata 读取 `scene_id`，查询同 scene 全部 frames 并按时间排序。正常 30 秒窗在 dense 策略下是中点代表帧加最多 2 个额外关键帧；`SCENE_CAPTION_MAX_FRAMES=6` 仅用于发现索引配置漂移或异常数据。固定 30 秒 fallback 的 `scene_id` 必须在 Task 1 中改为稳定 ID，例如 `segment-0001`，不能继续为 null。

- [ ] **Step 5: 扩展 VLM service 的多图协议**

Ollama backend 将所有图片按顺序编码：

```python
payload = {
    "model": self.ollama_model,
    "prompt": prompt,
    "images": encoded_images,
    "stream": False,
}
```

Transformers backend 的 message content 为每张图片增加一个 `{"type": "image"}`，并将同序 PIL images 传给 processor。请求中的 paths 与 times 数量不一致、空列表或超过 `SCENE_CAPTION_MAX_FRAMES` 时返回 400；上限从 worker 与 VLM service 的同名环境变量读取并校验为 1～12。

- [ ] **Step 6: 增加 scene-caption-v2 prompt**

使用固定中文提示词：

```text
以下图片来自同一段视频，并已按时间从早到晚排列。请综合所有图片，用中文简洁描述主体、环境、可见文字，以及图片明确显示的动作或状态变化。不要把单张图片当成整个场景，不要推断采样帧之间未展示的事件。只输出一段描述，不要输出列表或解释。
```

- [ ] **Step 7: 写入完整 caption provenance**

caption metadata 至少包含：

```json
{
  "source": "vlm_scene_caption",
  "scene_id": "scene-0003",
  "prompt_version": "scene-caption-v2",
  "vlm_model_name": "Qwen/Qwen2.5-VL-7B-Instruct",
  "vlm_model_version": "qwen2.5-vl-7b-instruct",
  "source_asset_ids": ["frame-a", "frame-b", "frame-c"],
  "frame_times_seconds": [12.0, 20.0, 26.0]
}
```

content hash 必须包含有序 source IDs、各自 content hashes、frame times、prompt version、model version 和 caption 文本。

- [ ] **Step 8: 将视频新 caption job 切到 v2**

image asset 继续创建 `caption-v1` 单图任务；video segment 创建 `scene-caption-v2` 任务。旧 queued v1 job 仍能执行原单图路径。

- [ ] **Step 9: 运行 Python caption 与 VLM 测试**

Run:

```bash
PYTHONPATH=apps/worker-py python3.12 -m unittest discover -s apps/worker-py/tests -p test_captioning_worker.py
PYTHONPATH=apps/worker-py python3.12 -m unittest discover -s apps/worker-py/tests -p test_vlm_service.py
PYTHONPATH=apps/worker-py python3.12 -m unittest discover -s apps/worker-py/tests -p test_index_worker.py
```

Expected: PASS。

- [ ] **Step 10: Commit**

```bash
git add packages/shared/schemas/index.ts packages/shared/generated/job-schemas.json apps/worker-py/media_agent_worker apps/worker-py/tests
git commit -m "feat: generate scene captions from multiple keyframes"
```

---

### Task 5: 提供现有视频批量重索引与 readiness 检查

**Files:**
- Modify: `apps/server/src/database/repositories.ts`
- Modify: `apps/server/src/jobs/jobs.controller.ts`
- Modify: `apps/server/src/jobs/jobs.service.ts`
- Test: `apps/server/tests/jobs/jobs.controller.test.ts`
- Test: `apps/server/tests/jobs/jobs.service.test.ts`
- Modify: `docs/api-contract.md`

**Interfaces:**
- Produces: `POST /jobs/video/reindex`，body 为 `{ library_id?, file_id?, limit?, dry_run?, only_not_ready? }`；`only_not_ready` 默认 true。
- Produces: `GET /jobs/video/reindex-readiness`，返回 active video/segment/frame/segment-vector-ref/caption-v2 统计及缺失 file IDs。
- Produces: 重索引响应 `{ scanned, queueable, created, skipped_active, dry_run, file_ids }`。

- [ ] **Step 1: 写失败测试覆盖 dry-run 与过滤条件**

`dry_run=true` 必须返回将要创建的 file IDs，但 jobs 表数量不变。`library_id` 与 `file_id` 必须只选择对应 active video；图片、音频、软删除文件不能进入结果。

- [ ] **Step 2: 写失败测试覆盖 active job 去重**

同一个 file 已有 queued/running `index_media` 时返回 `skipped_active`，不能重复排队。默认只选择尚未满足 scene/frame readiness 的文件；已经完成新索引的文件不会在下一批重复出现。failed/succeeded 历史 job 不阻止仍未 ready 的文件重试。`limit` 默认 100、范围 1～1000，非法输入返回 400。

- [ ] **Step 3: 运行 jobs 测试确认失败**

Run:

```bash
corepack pnpm --filter @local-media-agent/server exec vitest run tests/jobs/jobs.controller.test.ts tests/jobs/jobs.service.test.ts
```

Expected: FAIL，路由和 service 方法不存在。

- [ ] **Step 4: 实现批量重索引入口**

数据库必须先排除 ready files 和 active jobs，再应用 `limit`，避免前 100 个 active jobs 阻塞后续批次。每个 queueable file 创建：

```json
{
  "job_type": "index_media",
  "input_json": {
    "file_id": "<video-file-id>",
    "index_profile": "balanced",
    "segment_strategy": "scene_detection"
  }
}
```

创建前记录请求过滤条件、scanned/queueable/skipped 数量；不要记录文件内容。数据库查询和 job 创建使用事务，单批失败整体回滚，不能产生部分批次。

- [ ] **Step 5: 实现 readiness 检查**

按 active video files 统计并返回：

```json
{
  "ready": false,
  "active_video_files": 120,
  "active_video_segments": 734,
  "segments_without_frames": 4,
  "segments_over_30_seconds": 2,
  "active_video_segment_vector_refs": 736,
  "segments_without_scene_caption_v2": 734,
  "missing_file_ids": ["..."]
}
```

`ready=true` 必须同时满足：无缺帧 segment、无超过 30 秒 segment、active segment vector refs 为 0。Caption-v2 覆盖率单独报告，不阻塞关闭旧视觉召回，但阻塞“多帧 caption 回填完成”的运营结论。

- [ ] **Step 6: 运行测试并更新 API 文档**

Run:

```bash
corepack pnpm --filter @local-media-agent/server exec vitest run tests/jobs/jobs.controller.test.ts tests/jobs/jobs.service.test.ts
```

Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/database/repositories.ts apps/server/src/jobs apps/server/tests/jobs docs/api-contract.md
git commit -m "feat: add auditable video reindex rollout endpoints"
```

---

### Task 6: 搜索页提供明确 loading 与错误反馈

**Files:**
- Modify: `apps/web/components/search-workspace.tsx`
- Modify: `apps/web/app/globals.css`
- Test: `apps/web/tests/search-workspace.test.tsx`

**Interfaces:**
- Produces: 搜索请求期间可见的 `role="status"` 和 `aria-live="polite"` 状态；按钮、输入和筛选不可重复提交。
- Produces: 请求失败时保留上一次成功结果并显示真实错误，不再静默恢复 `initialResults`。

- [ ] **Step 1: 写失败测试覆盖 pending UI**

使用 deferred Promise 保持请求 pending，断言：按钮显示“搜索中…”，搜索输入与筛选按钮 disabled，结果区域出现“正在检索本地媒体…”状态和 loading skeleton；Promise resolve 后状态消失并展示新结果。

- [ ] **Step 2: 写失败测试覆盖错误 UI**

模拟 `searchMedia` reject，断言上一次成功结果仍存在，并出现 `role="alert"`：“搜索失败：<error message>”。不得重置为首次页面载入的旧结果，也不得吞掉错误文本。

- [ ] **Step 3: 运行测试确认失败**

Run:

```bash
corepack pnpm --filter @local-media-agent/web exec vitest run tests/search-workspace.test.tsx
```

Expected: FAIL，当前只有按钮文字变化且 catch 静默重置结果。

- [ ] **Step 4: 实现 loading、错误与重复请求保护**

增加 `errorMessage` 状态；提交时清除旧错误，pending 期间在结果标题下渲染 status/skeleton。catch 使用 `error instanceof Error ? error.message : String(error)`。不要清空 `results`，避免内容跳动；使用半透明 loading layer 表明旧结果正在被替换。

- [ ] **Step 5: 增加 reduced-motion 样式并运行测试**

loading 动画在 `prefers-reduced-motion: reduce` 下禁用。Run:

```bash
corepack pnpm --filter @local-media-agent/web exec vitest run tests/search-workspace.test.tsx tests/jobs-styles.test.ts
```

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/search-workspace.tsx apps/web/app/globals.css apps/web/tests/search-workspace.test.tsx apps/web/tests/jobs-styles.test.ts
git commit -m "fix: show observable search request states"
```

---

### Task 7: 任务列表分页、自动刷新与卡片间距

**Files:**
- Modify: `apps/web/app/jobs/page.tsx`
- Modify: `apps/web/components/jobs-workspace.tsx`
- Modify: `apps/web/app/globals.css`
- Test: `apps/web/tests/jobs-workspace.test.tsx`
- Test: `apps/web/tests/real-data-pages.test.tsx`
- Test: `apps/web/tests/jobs-styles.test.ts`

**Interfaces:**
- Produces: 默认 `limit=25`、URL 持久化 `limit/offset`、上一页/下一页和“第 N / M 页”。
- Produces: 页面可见时每 5 秒 `router.refresh()` 当前页；页面隐藏时暂停，恢复可见时立即刷新一次。
- Produces: 手动和自动刷新共享 `useTransition` 状态，避免刷新按钮无反馈。

- [ ] **Step 1: 写失败测试覆盖 25 条分页**

断言 JobsPage 默认请求 `{ limit: 25, offset: 0 }`；总数 70 时显示“第 1 / 3 页”，下一页链接为 `/jobs?limit=25&offset=25`。非法或超过后端最大值的 limit 回到 25；offset 保持非负整数校验。

- [ ] **Step 2: 写 fake timer 失败测试覆盖自动刷新**

启用 fake timers，前进 5 秒后 `router.refresh()` 调用一次；`document.visibilityState='hidden'` 时不刷新；恢复 visible 时立即刷新；组件 unmount 后 interval 被清理。手动点击仍立即刷新。

- [ ] **Step 3: 写失败样式测试覆盖卡片间距**

Jobs 列表容器使用 `.job-list`，断言 CSS 包含 `display: grid`、`gap: 0.75rem`；每个 `.job-row` 有独立 border。移除当前将所有卡片包进 `overflow-hidden` 单一边框容器的结构。

- [ ] **Step 4: 运行测试确认失败**

Run:

```bash
corepack pnpm --filter @local-media-agent/web exec vitest run tests/jobs-workspace.test.tsx tests/real-data-pages.test.tsx tests/jobs-styles.test.ts
```

Expected: FAIL，当前默认 500、没有 interval，卡片容器没有 gap。

- [ ] **Step 5: 实现分页与自动刷新**

使用 `useEffect` 注册 5000ms interval 和 `visibilitychange`；使用 `useTransition` 包装 `router.refresh()`，前一次 refresh 仍 pending 时跳过下一次 interval，禁止并发刷新堆积。刷新时按钮图标增加 `aria-hidden` 旋转状态，文本显示“刷新中…”，并通过 `aria-live` 报告“任务列表已自动更新”。当前页在 total 缩小后越界时导航到最后有效页，不能展示永久空页。

- [ ] **Step 6: 修复卡片布局**

结构改为：

```tsx
<div className="job-list">
  {jobs.map((job) => <article className="job-row" ... />)}
</div>
```

`.job-list` 使用 12px gap；`.job-row` 使用独立 1px hairline border、8px radius 和现有 shadow。移动端保持单列，桌面端保持信息/进度/状态三列。

- [ ] **Step 7: 运行 web check**

Run:

```bash
corepack pnpm --filter @local-media-agent/web check
```

Expected: typecheck、Vitest、Next build 全部 PASS。

- [ ] **Step 8: Commit**

```bash
git add apps/web/app/jobs/page.tsx apps/web/components/jobs-workspace.tsx apps/web/app/globals.css apps/web/tests
git commit -m "fix: paginate and auto-refresh job cards"
```

---

### Task 8: 可观测性、重索引门槛与质量验收

**Files:**
- Modify: `apps/worker-py/media_agent_worker/indexing.py`
- Modify: `apps/worker-py/media_agent_worker/captioning.py`
- Modify: `apps/server/src/search/search.service.ts`
- Modify: `docs/finding-unknowns/2026-07-08-caption-rerank-eval.md`
- Modify: `docs/job-protocol.md`
- Modify: `docs/architecture.md`
- Modify: `docs/tasks/todo.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Produces: 可搜索的结构化日志，能够回答每个 scene 选了哪些 frame、MaxSim 最佳帧是谁、是否仍有 active segment vectors。
- Produces: 明确的重索引完成判据与对比评估记录。

- [ ] **Step 1: 增加索引与 caption 日志**

每个视频 index job 汇总记录：scene 数、segment 数、frame 数、中点 frame 数、stale segment ref 数、fallback 原因。每个 scene caption 记录 file ID、scene ID、source IDs、frame times、prompt/model version、耗时和 error class；不得记录图片 Base64。

- [ ] **Step 2: 增加 MaxSim 搜索诊断日志**

每次视频搜索记录：raw frame hits、聚合后 scene 数、每个返回 scene 的 best frame time、max score、merged frame count。保持现有 query expansion 日志字段。

- [ ] **Step 3: 定义重索引完成门槛**

在文档中明确，关闭 segment 在线召回前必须满足：

```text
active video_segment_vectors refs = 0
每个 active video_segment 对应 active video_frame >= 1
每个 active video_segment duration <= 30 seconds
每个 active scene-caption-v2 caption 的 source_asset_ids >= 1
```

如果检查失败，停止切换并输出缺失 file/scene 数量，不自动回退到旧 segment 搜索。

对全部 active video files 重新创建 `index_media` job；等待 worker 完成后运行上述检查。重索引失败的 file 必须保留 file ID、job ID 和 error message，修复失败任务后重新检查，不能通过忽略缺失文件来满足门槛。

- [ ] **Step 4: 执行固定查询集对比**

至少覆盖：主体、场景、动作、画面文字、开头事件、结尾事件、短 scene、长 scene、scene detection fallback。记录四组结果：

```text
A: 旧 segment midpoint vector
B: video_frame 单帧结果
C: scene MaxSim
D: scene MaxSim + scene-caption-v2
```

每条 query 记录 Top-5 命中、最佳 frame、scene 区间、caption、误召回原因。只有 C 在视觉定位上不劣于 A，且 D 对动作/场景查询有可复现收益，才将方案标记完成。

- [ ] **Step 5: 更新 Living Documentation**

同步更新 `AGENTS.md`：视频视觉召回以 frame MaxSim 为准；`video_segment` 不再表示视觉向量；检测出的长 scene 会按 30 秒上限二次切窗；caption 使用窗内全部按时间排序的临时关键帧。同步更新架构、job protocol、任务追踪与评估文档。

- [ ] **Step 6: 运行全量验证**

Run:

```bash
corepack pnpm --filter @local-media-agent/shared check
corepack pnpm --filter @local-media-agent/server check
corepack pnpm --filter @local-media-agent/web check
PYTHONPATH=apps/worker-py python3.12 -m unittest discover apps/worker-py/tests
```

Expected: 全部 PASS；不存在生成 schema diff 未提交。

- [ ] **Step 7: Commit**

```bash
git add AGENTS.md docs apps/server/src/search apps/worker-py/media_agent_worker
git commit -m "docs: record scene maxsim and multiframe caption architecture"
```

---

## 代码实施完成后的现有数据执行步骤

以下步骤是发布和数据回填 runbook，不属于开发测试。每一步都要检查响应后再继续，不能在 readiness 未通过时关闭旧 segment 搜索。

### 1. 完成全量代码验证

```bash
corepack pnpm --filter @local-media-agent/shared check
corepack pnpm --filter @local-media-agent/server check
corepack pnpm --filter @local-media-agent/web check
PYTHONPATH=apps/worker-py python3.12 -m unittest discover apps/worker-py/tests
```

四条命令必须全部成功。shared check 生成的 JSON Schema diff 必须已经纳入发布版本。

### 2. 配置迁移阶段环境变量

```dotenv
VIDEO_SEGMENT_SEARCH_ENABLED=true
CAPTION_INDEXING_ENABLED=true
CAPTION_SEARCH_ENABLED=true
LOCAL_VLM_ENABLED=true
KEYFRAME_DENSITY=dense
SCENE_MIN_SECONDS=3
SCENE_MAX_SECONDS=30
SCENE_CAPTION_MAX_FRAMES=6
```

迁移期间暂时保留旧 segment 搜索，避免旧数据尚未生成 frame vectors 时出现召回空洞。确认 Ollama 已安装 `qwen2.5vl:7b`，并启动 PostgreSQL、Qdrant、server、worker、model service、VLM service 和 web。

### 3. 查看迁移前 readiness

```bash
curl -sS http://127.0.0.1:4000/jobs/video/reindex-readiness
```

保存响应作为迁移基线。预期旧数据可能出现 `segments_without_frames > 0`、`segments_over_30_seconds > 0` 或 `active_video_segment_vector_refs > 0`。

### 4. Dry-run 第一批现有视频

```bash
curl -sS -X POST http://127.0.0.1:4000/jobs/video/reindex \
  -H 'content-type: application/json' \
  -d '{"limit":100,"dry_run":true,"only_not_ready":true}'
```

检查 `scanned`、`queueable`、`skipped_active` 和 `file_ids`。dry-run 后 jobs 总数不得变化。

### 5. 提交第一批重索引任务

```bash
curl -sS -X POST http://127.0.0.1:4000/jobs/video/reindex \
  -H 'content-type: application/json' \
  -d '{"limit":100,"dry_run":false,"only_not_ready":true}'
```

`index_media` 会对每个长 scene 做 30 秒二次切窗，创建 segment 与中点/额外 `video_frame` assets，并创建 pending frame vector refs；JobsCoordinator 会自动创建 `embed_video_frame` jobs。启用 caption 开关后，每个新 segment 同时创建 `scene-caption-v2` job，Qwen2.5-VL 会按时间读取窗内全部关键帧并生成 caption，随后自动创建 `embed_text_asset` job。

### 6. 在前端任务页观察当前批次

打开 `/jobs?limit=25&offset=0`。页面每 5 秒自动刷新；确认 `index_media`、`embed_video_frame`、`generate_caption` 和 `embed_text_asset` 最终完成。任何 failed job 都必须先查看 error message、修复根因并重试，不能跳过该文件。

### 7. 重复批处理直到没有 queueable 文件

重复步骤 5。由于 `only_not_ready=true` 会排除已经完成新索引的文件，每次会推进到下一批。直到响应满足：

```json
{
  "queueable": 0,
  "created": 0
}
```

如果 `queueable=0` 但仍有 `skipped_active>0`，等待 active jobs 完成后再次执行，不能提前结束。

### 8. 执行迁移后 readiness 检查

```bash
curl -sS http://127.0.0.1:4000/jobs/video/reindex-readiness
```

关闭旧 segment 搜索前必须满足：

```text
ready = true
segments_without_frames = 0
segments_over_30_seconds = 0
active_video_segment_vector_refs = 0
```

同时检查 `segments_without_scene_caption_v2=0`，它表示多关键帧 caption 回填完成。若不为 0，保持 caption 迁移未完成状态并处理对应 `missing_file_ids`。

### 9. 关闭旧 segment 向量召回并重启 server

将环境变量改为：

```dotenv
VIDEO_SEGMENT_SEARCH_ENABLED=false
```

重启 server 后执行一条视频搜索，确认响应 `groups` 和 `source_scores` 不包含 `video_segment_vectors`，包含 `video_frame_vectors`，并且同一 scene 的多帧命中在 top-level `results` 中已按 MaxSim 聚合。

### 10. 完成人工质量对比

使用评估文档中的固定 query 集核对主体、动作、字幕、长固定镜头和 fallback 视频。重点确认：搜索时间范围不超过 30 秒、最佳证据帧正确、scene caption 覆盖窗口开始/中间/结尾。记录误召回，不能仅凭任务全部成功就认定检索质量验收通过。

---

## 明确不在本计划范围内

- 不引入视频时序 embedding 模型。
- 不做关键帧向量平均池化。
- 不新增持久化 frame cache。
- 不删除 Qdrant 中旧 `video_segment_vectors` points。
- 不实现 async VLM rerank 或更换全局 hybrid score 算法。
- 不给每个 dense frame 单独生成 caption。
- 不依赖 `video_segment_vectors` 作为相邻 frame 合并桥梁。

## 最终验收标准

- 新索引的每个 scene/fallback segment 至少有一个可检索 `video_frame`。
- 视频在线搜索不查询 `video_segment_vectors`。
- 同 scene 的多个 frame 命中只产生一个 top-level 结果，score 等于该 scene 的最大 frame cosine。
- 结果时间范围来自真实 `video_segment` 边界，代表 asset 是最佳 frame，`merged_asset_ids` 保留所有命中证据帧。
- 任意检测 scene 超过 30 秒时会被切成连续子时间窗；视频新 caption 使用窗内全部已索引关键帧，metadata 能完整追溯来源。
- 任意抽帧、VLM、模型版本或场景数据错误均可见并使任务失败；不产生空 caption 或部分 provenance。
- 旧 `caption-v1` job 仍可执行，旧 segment vectors 保留审计但不参与新搜索。
- 搜索请求期间结果区域有可访问的 loading 状态；失败时保留旧结果并展示真实错误。
- 任务页默认每页 25 条、每 5 秒刷新当前页、隐藏标签页暂停刷新，任务卡片之间有 12px 间距和独立边框。
- 共享、服务端与 Python 全量检查通过，架构文档和 `AGENTS.md` 与实现一致。
