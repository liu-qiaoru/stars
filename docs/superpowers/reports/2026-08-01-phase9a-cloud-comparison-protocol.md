# Phase 9A-C：国产云端多帧模型回归对照协议

## 结论与当前状态

本补充实验已于 2026-08-01 执行。Qwen3-VL-Plus 与 Qwen3-VL-Flash 完成 72/72 次调用；
GLM-4.6V-Flash 因连续正式请求返回 HTTP 429，未形成完整质量指标。最终结果与人工复核见
[`2026-08-01-phase9a-cloud-comparison.md`](./2026-08-01-phase9a-cloud-comparison.md)。

这不是 Phase 9B 的生产实现。即使三个模型中有模型在 12 条旧样本上全部答对，生产搜索仍
保持 Phase 8 的 SigLIP2 + Caption + 语音全文 + RRF，不创建异步复核任务。

正式命令还会核对原 Phase 9A manifest 文件的 SHA-256 指纹
`a074c5329c005c4efc478cbd189fcc15c8be0e100d535fff87ab224f0992c108`。指纹不一致或没有
同时选择下表三个模型时，会在读取视频和外发之前失败，避免用变化后的样本或不完整模型组
生成貌似可比较的报告。

## 比较对象

| 评测 ID | 云端模型 | 本实验角色 | 已冻结价格档位 |
| --- | --- | --- | --- |
| `glm-4.6v-flash` | 智谱 GLM-4.6V-Flash | 免费对照 | 输入、输出均按 0 元记录 |
| `qwen3-vl-plus` | `qwen3-vl-plus-2025-12-19` | 主要质量候选 | 输入 1 元/百万 token；输出 10 元/百万 token |
| `qwen3-vl-flash` | `qwen3-vl-flash-2026-01-22` | 降本候选 | 输入 0.15 元/百万 token；输出 1.5 元/百万 token |

Token 是供应商用于统计模型输入和输出容量的计费单位；图片也会被供应商换算成输入 token。
“百万 token 价格”表示每 1,000,000 个 token 的人民币费用，数值越低越便宜。代码只接受
单次不超过 32,000 个输入 token 的已核对价格档位；供应商未来可能调价，复跑前仍需对照
[阿里云 Qwen3-VL-Plus 文档](https://help.aliyun.com/zh/model-studio/qwen3-vl-plus)、
[阿里云 Qwen3-VL-Flash 文档](https://help.aliyun.com/zh/model-studio/qwen3-vl-flash)和
[智谱 GLM-4.6V-Flash 文档](https://docs.bigmodel.cn/cn/guide/models/free/glm-4.6v-flash)。

## 数据流与隐私边界

1. Python 命令只读 PostgreSQL 中 Phase 8 正式快照，确认查询、候选、人工等级、文件
   generation 和场景边界没有变化。PostgreSQL 是保存结构化业务事实的关系型数据库；
   本步骤不写入任何行。
2. FFmpeg 只读源视频，沿用原 9A 算法抽取最多 12 张、宽 640 像素的临时 JPEG。图片只
   存在于本次命令的私有临时目录。
3. Python 将同一批图片编码为 Base64 后同步调用所选云端 API。Base64 只是把二进制图片
   转成 JSON 可承载的文本，不是加密；同步调用表示收到本次模型答案前不会处理下一次。
4. 外发字段只有临时图片、中文查询、图片序号和时间戳。完整视频、源文件路径、Caption、
   语音转录、数据库行和 Qdrant 向量不会进入请求。
5. 每个场景对每个模型调用 3 次，温度固定为 0，并要求返回相关等级、匹配约束、缺失约束
   和理由的 JSON。报告保存输出、耗时、token 用量和估算费用，但不保存图片或密钥。
6. 临时目录退出时统一删除全部图片。成功、HTTP 失败、超时、预算停止和用户中断都经过
   同一个清理边界。

## 预算规则

默认整次实验预算是 2 元。发出每个请求前，程序先按当前模型的最大允许输入 32,000 token
和最大输出 500 token 预留费用。以 Qwen3-VL-Plus 为例，单次最多预留
`32,000 × 1 / 1,000,000 + 500 × 10 / 1,000,000 = 0.037 元`；余额不足 0.037 元时，
该请求根本不会发出。响应返回后再按供应商报告的真实输入/输出 token 替换预留值。

12 个场景 × 3 次重复 = 每个模型 36 次调用。按照上述最坏上限，Plus 最多约 1.332 元，
Flash 最多约 0.200 元，GLM 当前记录为免费，总计约 1.532 元，低于默认 2 元。这里的
“最多”是代码价格常量下的预算上界，不是供应商账单担保；真实报告会保存供应商返回的
用量，最终仍应在控制台核对账单。

## 如何配置并复跑

不要把密钥粘贴到聊天、代码或 Git。只在运行命令的终端中设置环境变量；终端关闭后该临时
变量即消失：

```bash
export DASHSCOPE_API_KEY='从阿里云控制台复制的密钥'
export ZHIPU_API_KEY='从智谱控制台复制的密钥'
```

然后从仓库根目录运行：

```bash
PYTHONPATH=apps/worker-py .venv/bin/python \
  -m media_agent_worker.cloud_multi_frame_comparison \
  --manifest docs/superpowers/reports/2026-08-01-phase9a-multi-frame-manifest.json \
  --output docs/superpowers/reports/2026-08-01-phase9a-cloud-comparison-report.json \
  --provider glm-4.6v-flash \
  --provider qwen3-vl-plus \
  --provider qwen3-vl-flash \
  --max-budget-cny 2 \
  --confirm-external-upload
```

阿里云工作空间 Key 需要使用控制台显示的专属 OpenAI 兼容地址。将地址通过环境变量传入，
不要硬编码到代码；程序只接受阿里 `https://*.maas.aliyuncs.com/compatible-mode/v1` 或公共
DashScope 域名，避免把 Key 发给错误主机：

```bash
export DASHSCOPE_BASE_URL='https://你的工作空间.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
```

当某个供应商暂时不可用时，可以保持三个 `--provider` 声明不变，再通过一个或多个
`--execution-provider` 生成供应商子集报告。子集报告固定标记为“不完整、待合并”，不能
用于开启 Phase 9B。

真实调用前建议先只选免费模型做 1 个独立 smoke test（冒烟测试，即用极少输入确认地址、
密钥和请求格式可用）。当前正式命令故意固定完整 12 × 3 口径，不提供任意缩小样本的参数，
避免看过部分答案后选择对模型有利的样本；冒烟测试应另用不属于冻结评测的公开图片。

## 结果如何判断

- `success_rate`：成功且能解析严格 JSON 的调用数除以应调用总数，范围 0～1，越大越好。
- `stability_rate`：同一场景 3 次都成功且等级完全一致的场景比例，范围 0～1，越大越好；
  稳定只说明答案重复，不说明答案正确。
- `exact_case_accuracy`：3 次等级稳定且等于冻结人工等级的场景数除以 12，范围 0～1，越大
  越好。两条已知歧义标签会单独说明，不能在看到输出后直接修改。
- `mean_inference_seconds`：所有成功调用耗时的算术平均值，单位秒，越低越快。
- `p95_inference_seconds`：成功耗时从小到大排序后的第 95 百分位，单位秒；12 条小样本只
  用于发现明显慢请求，不能代表长期线上速度。
- `estimated_cost_cny`：按供应商返回的输入/输出 token 与冻结单价计算的人民币估算费用，
  越低越便宜，但最终账单仍以供应商控制台为准。

自动报告始终标记 `pending_human_reason_review`。人工必须逐条查看抽帧，确认理由没有把“鼓
出现在画面”说成“正在打鼓”、没有忽略背景颜色、动作执行者或人物关系。之后还要纠正歧义
标签并新增约 20 条模型未见过的盲测候选，才能另行定义新的正式质量闸门。

## 数据与生产影响

本实现不修改数据库 Schema，不需要 Drizzle Migration，不回填已有数据，不重新索引，也
不写 Qdrant。它没有 Server API、Worker 异步任务或 Web 入口；失败只会终止实验并保留
明确错误，不会影响当前搜索。
