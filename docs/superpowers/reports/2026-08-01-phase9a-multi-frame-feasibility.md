# Phase 9A：真实 Top-K 多帧 VLM 可行性报告

## 结论

Phase 9A 已完成，但**未通过可行性闸门**。多帧工具本身能够稳定抽帧并调用本机
Ollama `qwen2.5vl:7b`，36/36 次调用成功，固定输入的 3 次相关等级也全部一致；速度、
帧边界和 swap 资源门槛均通过。失败原因是质量：12 个冻结场景中只有 7 个场景的等级
与 Phase 8 人工标签一致，而且人工查看全部抽帧后，至少 9 条自由文本理由包含画面无法
支持的断言或对象、动作、人物关系、环境约束混淆。

因此必须按既定计划保持“多帧高精度复核”不可用，并跳过 Phase 9B～9D。当前生产检索
仍使用 Phase 8 已验收的 SigLIP2、Caption、语音全文和 RRF，不受本次失败影响。

冻结输入见
[`2026-08-01-phase9a-multi-frame-manifest.json`](./2026-08-01-phase9a-multi-frame-manifest.json)，
逐次原始输出见
[`2026-08-01-phase9a-multi-frame-report.json`](./2026-08-01-phase9a-multi-frame-report.json)，
与该报告指纹绑定的人工复核输入见
[`2026-08-01-phase9a-human-review.json`](./2026-08-01-phase9a-human-review.json)。

## 实验边界与数据流

本阶段是隔离试验，不是生产功能：

1. 命令读取冻结 manifest，并从 PostgreSQL 只读解析 Phase 8 正式 run
   `6298b745-d9d3-44bf-86a0-2d0a0b46360c` 的查询、Top-3 视频候选、人工等级、场景边界
   和当前源文件路径。
2. FFmpeg 只读原视频，为每个场景抽取最多 12 张临时 JPEG。抽帧包含最多 5 张全局覆盖
   帧、最多 5 张 SigLIP2 最佳命中附近帧和最多 2 张画面变化峰值帧；Caption-only 候选
   没有视觉命中时间，因此不会虚构命中点。
3. Python 进程同步调用本机 Ollama；“同步”表示必须等待本次 Qwen2.5-VL 判断返回后才
   处理下一次。请求固定温度为 0、随机种子为 0，并要求严格 JSON。
4. 每个冻结输入调用 3 次。报告保存帧时间、选择原因、SHA-256 内容哈希、尺寸、耗时和
   模型输出，但不保存图片本身或源文件绝对路径。
5. 无论成功或失败，临时目录都会退出并删除；结束资源测量前还会通过 `keep_alive: 0`
   要求 Ollama 卸载模型，再等待固定 10 秒冷却。

本实验没有创建异步 Job，没有写 PostgreSQL 或 Qdrant，没有改变 RRF 排序，也没有删除
Transformers Qwen 权重。失败以命令退出码 `2` 和报告中的 `final_gate_passed: false`
明确暴露，不会静默启用部分结果。

## 冻结样本

样本在查看任何模型输出前冻结，共 12 个 Phase 8 真实 Top-3 视频候选：

- 3 个 Caption-only 候选，即只由 Caption 文本向量召回、没有 SigLIP2 最佳帧时间；
- 9 个含 SigLIP2 视觉命中的候选；
- 3 个约 30 秒场景和 9 个不超过 3 秒的短场景；
- 人工期望等级覆盖 `0`（不相关）、`1`（部分相关）和 `2`（高度相关）。

实验后人工复核发现 `visual-computer-desk-high` 和 `visual-drum-playing-30s-zero` 的冻结
等级存在歧义。为了避免看到模型答案后修改标准，这两个等级没有被改写；即使暂时排除
最直接影响不一致数量的架子鼓样本，仍有 4 个清楚的等级误判，因此不会改变失败结论。

## 自动门槛结果

| 检查项 | 结果 | 含义 |
| --- | ---: | --- |
| 成功调用 | 36/36，通过 | 12 个场景各重复 3 次，没有超时、进程退出或无效 JSON |
| 场景等级一致 | 7/12，失败 | 每个场景取稳定的重复结果，只有 58.3% 与冻结人工等级相同；要求是 12/12 |
| 3 次重复稳定 | 12/12，通过 | 同一输入的 3 次 `relevance` 完全相同；稳定不等于判断正确 |
| 帧契约 | 36/36，通过 | 每次至少 1 帧、最多 12 帧，所有时间均在场景边界内 |
| 30 秒单次耗时 | 全部小于 60 秒，通过 | 单个长场景调用没有超过预先固定的 60 秒上限 |
| 最坏 3 个长场景合计 | 89.935 秒，通过 | 每个 30 秒场景取最慢一次再相加，低于 180 秒；越低越好 |
| 峰值 swap 增长 | 0 字节，通过 | 相对冷启动前起点没有新增交换内存，低于 4 GiB 上限 |
| 结束 swap 残留 | 0 字节，通过 | 卸载 Ollama 并等待 10 秒后没有正增长，低于 1 GiB 上限 |
| 自由文本理由 | 失败 | 人工查看 12 个场景，至少 9 条理由含不可见或错误证据 |

`7/12 = 58.3%` 是按场景统计的准确率：分子是模型等级与冻结等级相同的场景数，分母是
12 个场景，数值越高越好，本阶段要求 100%。原始 JSON 按 36 次重复调用统计为
`21/36 = 58.3%`；因为每个场景 3 次完全稳定，两种口径的比例相同。12 个样本只能用于
本机可行性闸门，不能推断大规模线上准确率。

swap（交换内存）是 macOS 把暂时不用的内存页写到磁盘的空间。GiB（二进制吉字节）等于
`1024³` 字节，增长越小越好。这里监控的是整台机器，因为 Ollama 是独立进程，所以数值
也可能包含同期系统活动。本次起点已经有约 10.52 GiB 的系统 swap；冻结规则只比较实验
期间相对起点的新增量，因此“增长为 0”不能解释成整台机器没有使用 swap。

## 耗时

- 冷启动：11.955 秒。实验先显式卸载模型并冷却 10 秒，因此第一次调用包含模型重新
  加载和本次推理时间。
- 热调用平均：8.063 秒。它对第一条之后的 35 次调用求算术平均，越低越好。
- 全部调用平均：8.172 秒，即 36 次耗时相加后除以 36。
- P95：31.977 秒。把 36 次成功耗时从小到大排列，取第 95 百分位；表示本小样本中约
  95% 的调用不超过该值，只用于发现慢调用，不代表线上长期分布。
- 最大值：32.009 秒，是 36 次调用中最慢的一次。

## Caption-only 分组

Caption-only 为 2/3 个场景一致，即 66.7%；含 SigLIP2 视觉命中的分组为 5/9，即
55.6%。两者相差 `55.6% - 66.7% = -11.1` 个百分点，负值表示本次 Caption-only 反而
更高，并没有达到“Caption-only 明显更差超过 20 个百分点”的预设条件。

该比较每组只有 3 和 9 个场景，样本很小，只能说明本次失败不能归因于 Caption-only
缺少场景内视觉定位；它不证明两个来源长期效果相同，也不支持现在增加第二次 SigLIP2
定位。

## 逐例等级结果

| 场景 | 来源 | 期望 → 模型 | 复核摘要 |
| --- | --- | ---: | --- |
| `caption-birthday-en-short-high` | Caption-only | 2 → 2 | 等级一致，但理由把蛋糕错误描述成花盒 |
| `caption-gray-subtitle-short-zero` | Caption-only | 0 → 2 | 有字幕，但不是灰色背景；模型忽略环境约束 |
| `caption-indoor-speaking-short-high` | Caption-only | 2 → 2 | 画面支持室内访谈，理由仍越界推断“连续对话” |
| `visual-birthday-short-high` | SigLIP2 | 2 → 2 | 蛋糕和蜡烛支持生日氛围，部分帧描述不准确 |
| `visual-chopsticks-short-partial` | SigLIP2 | 1 → 2 | 只清楚看到拿筷子，不能确认正从餐盒夹起食物 |
| `visual-computer-desk-high` | SigLIP2 | 2 → 2 | 冻结标签有歧义；画面是打字机，理由却称完全匹配电脑 |
| `visual-door-pose-partial` | SigLIP2 | 1 → 2 | 人在门口整理衣服，未清楚靠门框摆姿势 |
| `visual-drum-playing-30s-zero` | SigLIP2 | 0 → 2 | 标签略有歧义；理由只证明人在鼓旁，未证明正在演奏 |
| `visual-hanging-clothes-high` | SigLIP2 | 2 → 2 | 人物旁边挂衣服，等级和理由均受画面支持 |
| `visual-indoor-speaking-30s-high` | SigLIP2 | 2 → 2 | 室内面对镜头讲话，等级和理由受画面支持 |
| `visual-outdoor-camera-30s-zero` | SigLIP2 | 0 → 2 | 场景在室内且设备由旁人持有，模型忽略环境和人物关系 |
| `visual-red-singer-short-zero` | SigLIP2 | 0 → 0 | 有红发歌手，但缺少蓝色眼镜和橙色麦克风，拒绝正确 |

## 根因判断与后续边界

事实：抽帧数量、时间边界、模型调用、JSON 解析、重复稳定性、耗时和资源门槛全部通过。
人工查看也确认误判场景确实抽到了对应时间的真实画面。

推断：当前 `qwen2.5vl:7b` 更容易识别宽泛主体，例如“人物、鼓、设备、筷子”，但会把
“物体出现”过度提升为“动作发生”，也会忽略背景、执行动作的人以及颜色等组合约束。
这使它不适合作为当前 Top-3 的高精度复核器；稳定地给出错误等级比偶发格式错误更难用
重试解决。

建议：先保持 Phase 9B～9D 未实施，不把本实验代码接入 Server、Worker 任务或 Web。
如果未来重新打开该方向，应先由用户复核歧义标签，再冻结新的独立样本，对更强模型、
更严格的逐约束 Prompt 或专门的动作证据方案重新执行一个新的 9A，而不是修改本报告或
放宽已有门槛。

## 复跑与数据影响

从仓库根目录执行：

```bash
PYTHONPATH=apps/worker-py .venv/bin/python \
  -m media_agent_worker.multi_frame_vlm_feasibility \
  --manifest docs/superpowers/reports/2026-08-01-phase9a-multi-frame-manifest.json \
  --output /tmp/phase9a-multi-frame-report.json \
  --ollama-timeout-seconds 60
```

首次运行会生成自动报告并返回 `2`，表示仍需人工复核或自动门槛已经失败。复跑需要本机
PostgreSQL 中仍保留该 Phase 8 快照、源视频路径可读、FFmpeg 可用，并安装 digest 为报告
所列值的 Ollama 模型。无需数据库迁移、数据回填、重新索引或重新执行 Phase 8。

自动运行完成后，人工复核文件必须引用该报告通过规范化 JSON 计算的 SHA-256 指纹，并
覆盖报告中的全部场景。以下命令只完成复核，不连接 PostgreSQL、不读视频，也不调用模型：

```bash
PYTHONPATH=apps/worker-py .venv/bin/python \
  -m media_agent_worker.multi_frame_vlm_feasibility \
  --manifest docs/superpowers/reports/2026-08-01-phase9a-multi-frame-manifest.json \
  --output docs/superpowers/reports/2026-08-01-phase9a-multi-frame-report.json \
  --finalize-human-review \
  docs/superpowers/reports/2026-08-01-phase9a-human-review.json
```

最终退出码只有在自动门槛和人工理由复核都通过时才为 `0`；本报告两者都未通过，因此
正确返回 `2`。
