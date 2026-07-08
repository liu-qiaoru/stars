# Video Keyframe Density Unknowns

任务：判断低召回分数是否应通过增加关键帧密度、强化 scene detection 和 extra keyframes 来改善。
日期：2026-07-08
当前阶段：Unknowns brief
下一步建议：先做索引覆盖审计，再实现可配置的 dense keyframe profile，而不是直接把默认密度永久调高。

## 地图和领土

用户观察到：中英文 query expansion 后，视觉召回仍很弱，最好的 `top_weighted_score` 只有 `0.0424616381`。用户判断可能需要增加关键帧密度，或开启/强化 scene detection + extra keyframes。

真实代码路径在 Python worker 的 `IndexMediaHandler`：`probe_media` 为视频创建 `index_media` job，默认 `segment_strategy='scene_detection'`；`index_media` 内部调用 PySceneDetect，生成 `video_segment` 代表帧和少量 `video_frame` 额外关键帧。搜索路径在 NestJS `SearchService`，视频搜索同时查 `video_segment_vectors` 和 `video_frame_vectors`。

## 已知事实

- 代码已经实现 scene detection，不是完全没接入。
- `probe_media` 对视频默认创建 `index_media`，输入里是 `segment_strategy='scene_detection'`。
- scene detection 失败、返回 0 个可用 scene、或 scene 数超过上限时，会 fallback 到固定 30 秒切片。
- 当前额外关键帧规则很稀疏：
  - scene `<= 15s`：不创建额外 `video_frame`。
  - scene `15-45s`：额外 1 帧。
  - scene `> 45s`：额外 2 帧。
- 每个 scene 一定有一个 `video_segment` 代表帧，但代表帧是中点。局部物体如果只出现在开头/结尾，可能完全没被向量化。
- `index_profile` 已经存在于 job input，但当前 Phase 11 文档和实现里没有用它区分关键帧密度。
- 用户之前观察到 `index_media` job 只有 15 个，这可能说明只有 15 个媒体文件被视觉索引过；它不是关键帧数量，而是文件级索引 job 数量。

## 盲点

1. **低分不一定只因为关键帧少。**
   `0.04` 对 cosine similarity 来说非常低，可能还有模型对中文/短词视觉语义弱、查询 embedding 服务模型不匹配、Qdrant collection 数据量太少、媒体未重索引、或搜索请求没有命中正确 media type 的问题。

2. **现有媒体可能没有按新策略重建索引。**
   如果很多视频是在 scene detection / video_frame_vectors 接入前索引的，它们可能只有旧的 `video_segment_vectors`，或者只有固定 30 秒切片。加代码不会自动修复旧数据，必须重跑 `index_media` 和 pending embedding jobs。

3. **scene detection 可能在安静 fallback。**
   PySceneDetect 未安装、异常、检测为空、过多 scene 都会 fallback 到 `fixed_30s`，job 仍然成功。用户只看搜索结果时很难发现 fallback。

4. **关键帧加密会放大下游成本。**
   每多一个 `video_frame`，至少增加一个 `vector_ref`、一个 `embed_video_frame` job、一个 Qdrant point，并可能增加 OCR job 的处理量。对 1 TB 视频库，这个倍率很敏感。

5. **短 scene 反而最容易漏细节。**
   当前 `<=15s` scene 没有额外关键帧，只有中点代表帧。很多家庭/旅行视频镜头移动快，关键物体可能只出现 1-3 秒，中点策略会漏。

6. **extra keyframes 当前按时间均匀取，不看画面变化。**
   增密能提高覆盖，但不是最聪明的选帧。更好的后续方案可能是按视觉变化、OCR 文本、人物/物体变化或 CLIP 分数挑帧。

## 建议方向

第一步不要直接硬改默认值。先补一个索引诊断视图或 SQL 查询，确认每个视频实际用了什么 `segment_strategy`、是否 fallback、`scenes_detected`、`keyframes_selected`、`video_frame` 数量、pending/indexed vector refs 数量。

第二步实现可配置的关键帧密度 profile：

- `balanced` 保守增强：短 scene 也至少取 1 个非中点 extra keyframe；中长 scene 增加到 2-4 个。
- `dense` 用于用户主动重建：按 scene 时长每 8-12 秒一帧，上限例如每 scene 6-8 个 extra keyframes。
- 保留 `light` 或当前规则，给低资源机器和大库兜底。

第三步提供重建入口或操作说明：对已索引视频重新创建 `index_media` job，并重新 queue pending embeddings/OCR。否则新策略只影响新入库视频。

## 需要用户决定的问题

你更能接受哪种默认取舍？

- 默认全库变密：更可能改善召回，但会显著增加 embedding/OCR/Qdrant 数量。
- 默认保持 balanced，给指定 library/file 开 dense 重建：更可控，但需要多一步重建操作。

