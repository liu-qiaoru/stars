# qwen3-vl-rerank 真实 Smoke 前置核对

> 核对日期：2026-08-13（Asia/Shanghai）
>
> 资料范围：只使用阿里云官方帮助中心公开页面
>
> 执行边界：本次没有调用任何模型或 Provider API，没有显示或使用 API Key 值，也没有发送本地图片、查询或媒体内容

## 结论

截至核对日期，阿里云百炼官方公开资料确认 `qwen3-vl-rerank` 可在**华北 2（北京）**通过 DashScope 专用 Rerank API 调用。它不能使用 OpenAI 兼容 Rerank 端点。Phase E 的 Top-20 图片 document 数量低于公开的单请求 40 张图片上限，`top_n=10` 也是官方支持的参数形态。

但是，现在仍然**不能直接开始真实 smoke，也还不到请求外发授权的时候**：

1. 用户尚未授权发送本地图片和产生费用；本次没有改变该边界。
2. Server 已有经过本地 fake 验证的 DashScope 适配器，但独立配置仍为 `disabled`；只配置凭证不会启用外发。
3. 审计契约已调整为忠实保存官方 `usage.total_tokens` 与 `request_id`；缺失的输入/输出 token 拆分、响应模型和账单费用保存 null，本地保守费用另列，不能伪造供应商事实。
4. 本机只确认配置了 API Key 的环境变量，尚未配置北京地域业务空间 ID；调用前两者必须属于同一地域，且不得在报告或日志中输出值。
5. 首次核对时 PostgreSQL 中的视觉查询/成功 Evaluation 证据为 0/0；用户随后完成 27/27 人工判断，正确的 reported run 已具备 20 份成功证据，只读 preflight 计算得到完整请求正文 18,530,463 bytes。
6. 官方公开页没有给出图片单文件字节数、分辨率、HTTP 请求体大小、Base64 后大小、并发连接数等硬限制；这些只能在获得授权后用受控 smoke 验证。

## 1. 模型与地域

| 核对项 | 官方可确认事实 | Phase E 结论 |
| --- | --- | --- |
| 模型 ID | 模型详情页列出 `qwen3-vl-rerank`，推理服务供应商是阿里云百炼，支持 Text、Image、Video 输入。 | 模型存在，名称必须保持 `qwen3-vl-rerank`，不能换成 `qwen3.7-plus`。 |
| 可用地域 | 模型详情、价格表和限流表都只列出华北 2（北京）；新加坡排序模型表没有 `qwen3-vl-rerank`。 | 当前公开证据只足以批准北京地域预检。不能推断新加坡、美国、德国或日本可用。 |
| 服务部署范围 | 北京地域对应中国内地服务部署范围。 | 图片会发送到北京接入地域，并在中国内地范围推理；授权文案应明确这一点。 |
| 模型能力边界 | 官方标明不支持模型体验、Function Calling、结构化输出、批量推理和模型调优。 | Smoke 必须调用专用实时 Rerank API，不能通过控制台模型体验、Batch 或 Tool Calling 替代。 |

来源（访问日期均为 2026-08-13）：

- [qwen3-vl-rerank 模型信息](https://help.aliyun.com/zh/model-studio/qwen3-vl-rerank)
- [阿里云百炼模型价格](https://help.aliyun.com/zh/model-studio/model-pricing)
- [限流](https://help.aliyun.com/zh/model-studio/rate-limit)
- [选择地域、服务部署范围和接入域名](https://help.aliyun.com/zh/model-studio/regions/)

## 2. HTTP 与 SDK 接口

### 2.1 HTTP

北京业务空间专属端点为：

```text
POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank
```

请求头：

```text
Authorization: Bearer <北京地域的百炼 API Key>
Content-Type: application/json
```

这里的 `WorkspaceId` 是业务空间 ID。地域、业务空间域名和 API Key 不能跨地域混用。官方推荐生产场景使用业务空间专属域名；北京地域通用 DashScope 旧域名为 `dashscope.aliyuncs.com`，但新接入应优先使用专属域名。

`qwen3-vl-rerank` 的官方 HTTP 结构是：

```json
{
  "model": "qwen3-vl-rerank",
  "input": {
    "query": { "text": "完整原始查询" },
    "documents": [
      { "image": "data:image/png;base64,<BASE64_DATA>" }
    ]
  },
  "parameters": {
    "return_documents": false,
    "top_n": 10
  }
}
```

Phase E 应一次在 `documents` 中放入完整 20 个图片 document。图片候选使用固定缩放图，视频场景使用 Phase D 指纹校验通过的 `contact_sheet_v1`；不能拆成多次请求再混合分数。

重要差异：项目内部 Schema 中的 `query`、`documents`、`top_n` 是 Provider 抽象，不是可以原样发送的供应商 wire JSON。真实适配器必须完成以下映射：

- `query` → `input.query.text`；
- 每个 `image_base64` → `input.documents[i].image`；
- 裸 Base64 → `data:image/png;base64,{data}`；
- `top_n` → `parameters.top_n`；
- `return_documents=false`，避免供应商把图片或文档内容回送并进入普通日志/响应。

官方英文 Rerank 总览还明确说明，多模态重排只支持 DashScope SDK/API，**不支持 OpenAI 兼容端点**。

### 2.2 Python SDK

官方 Python 示例使用 `dashscope.TextReRank.call`，并在北京地域设置：

```python
dashscope.base_http_api_url = "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1"

dashscope.TextReRank.call(
    model="qwen3-vl-rerank",
    query={"text": "完整原始查询"},
    documents=[{"image": "data:image/png;base64,<BASE64_DATA>"}],
    top_n=10,
    return_documents=False,
)
```

SDK 把 HTTP 中嵌套的 `input` 和 `parameters` 展平成函数参数。官方当前页面没有写最低 `dashscope` SDK 版本，因此不能在未验证版本兼容性的情况下把某个版本号写成官方要求。Phase E Server 是 TypeScript/NestJS，真实实现可直接使用 HTTP，不需要为了 SDK 示例新增 Python 调用链。

来源（访问日期均为 2026-08-13）：

- [通用文本排序模型 API 使用详情](https://help.aliyun.com/zh/model-studio/text-rerank-api)
- [Reranking API（阿里云官方英文页）](https://help.aliyun.com/en/model-studio/rerank)
- [华北 2（北京）接入信息](https://help.aliyun.com/zh/model-studio/beijing-access-information)

## 3. 图片、查询、Top-N 与输入限制

| 限制 | 官方公开值 | 对 Phase E Top-20 的含义 |
| --- | ---: | --- |
| 文本 query 最大长度 | 4,000 tokens | 完整原查询必须原样发送；超过时应在调用前失败，不能静默截断或改写。 |
| 图片 document 最大数量 | 40 张/请求 | 20 张低于数量上限。一个视频 contact sheet 作为一个图片 document。 |
| 文本 document 最大数量 | 100 条/请求 | Phase E 不发送 Caption 或转录文本 document。 |
| 视频 document 最大数量 | 4 个/请求 | Phase E 不发送源视频 URL，而发送本地生成的 contact sheet 图片。 |
| 单条 query/document 最大输入 | 8,000 tokens | 官方说明超长会被截断，可能影响准确性；图片如何折算为 token 未在该页给出。 |
| 单请求最大输入 | 120,000 tokens | 计算公式为 `Query Tokens × Document 数量 + Document Tokens 总和`。Top-20 是否落在上限内仍要由 smoke 返回的实际 token 验证。 |
| `top_n` | 整数，可选；默认全部 | 固定设为 10。若大于 document 数会返回全部；本项目仍必须严格要求实际结果恰好 10 条。 |
| 图片格式 | JPEG、PNG、WEBP、BMP、TIFF、ICO、DIB、ICNS、SGI | Phase E 固定 PNG 在支持列表内。 |
| 图片传输 | 公开 URL 或 Base64 Data URI | 本地证据不得变成公开 URL；应使用 `data:image/png;base64,{data}`。 |
| 视频格式 | MP4、AVI、MOV，仅公开 URL | Phase E 不外发源视频，因此不使用此路径。 |

公开文档没有说明混合模态时“40 张图片”与其他 document 类型如何共同计数。Phase E 本次请求只使用图片 document，所以不需要对混合计数作未经证实的假设。

来源（访问日期：2026-08-13）：

- [通用文本排序模型 API 使用详情](https://help.aliyun.com/zh/model-studio/text-rerank-api)
- [Reranking API（阿里云官方英文页）](https://help.aliyun.com/en/model-studio/rerank)

## 4. 价格、免费额度和限流

### 4.1 价格

北京地域公开原价：

| 计费项 | 单价 | 说明 |
| --- | ---: | --- |
| 文本输入 | ¥0.7 / 百万 tokens | 排序模型按输入 token 计费，输出不计费。 |
| 图片输入 | ¥1.8 / 百万 tokens | Phase E 的 20 个 document 主要落在此项。 |

模型详情页说明价格是原价，不含控制台中的限时活动。API 成功响应没有公开“本次费用”字段，所以真实费用不能只靠响应直接确认；需要保存 `usage.total_tokens`，并在调用后用账单/调用记录复核。

按公开的 120,000 token 请求硬上限做最保守的图片单价估算：

```text
单次理论上界 = 120,000 / 1,000,000 × ¥1.8 = ¥0.216
四次理论上界 = ¥0.864
```

这是“全部 token 都按图片输入单价”的保守预算推算，不是供应商报价，也不是实际账单。它说明：冻结计划的 4 次、总费用不超过 ¥0.5 不能仅靠“最多 4 次”保证。获得授权后应逐次串行调用，保存实际 `total_tokens`，按当时官方单价累计保守费用；预计下一次可能让累计值超过 ¥0.5 时必须停止。

### 4.2 免费额度

本次公开资料核对不能证明当前账号对 `qwen3-vl-rerank` 拥有可用免费额度，也不能证明具体余额。预算必须按**没有免费额度和活动折扣**计算；调用前可由用户在百炼控制台人工复核，但即使有免费额度，图片外发授权仍是独立前提，不能用“免费”替代隐私授权。

### 4.3 限流

北京地域公开限流：

- RPM（Requests Per Minute，每分钟请求数）：600；
- TPM（Tokens Per Minute，每分钟 token 数）：9,000,000。

官方说明服务还可能按 `RPS = RPM/60` 与 `TPS = TPM/60` 执行限制。公开页面没有给出独立“最大并发连接数”。Phase E smoke 最多 4 次并串行执行，远低于 RPM 数量，但仍可能因账户状态、共享额度、瞬时 TPS 或平台容量返回 429；遇到限流不得自动重放已 dispatched 的未知结果。

来源（访问日期均为 2026-08-13）：

- [qwen3-vl-rerank 模型信息](https://help.aliyun.com/zh/model-studio/qwen3-vl-rerank)
- [阿里云百炼模型价格](https://help.aliyun.com/zh/model-studio/model-pricing)
- [限流](https://help.aliyun.com/zh/model-studio/rate-limit)

## 5. 成功响应、用量与请求标识

`qwen3-vl-rerank` 的官方 HTTP 成功响应结构为：

```json
{
  "output": {
    "results": [
      {
        "index": 0,
        "relevance_score": 0.9334521178273196
      }
    ]
  },
  "usage": {
    "total_tokens": 79
  },
  "request_id": "provider-request-uuid"
}
```

已确认字段：

- `output.results[]` 按 `relevance_score` 从高到低排列；
- `index` 是输入 `documents` 数组中的原始位置；
- `relevance_score` 官方写明范围为 0 到 1，但只是当前请求内的相对分数，不能跨请求比较；
- `usage.total_tokens` 是本次请求总 token；
- `request_id` 是供应商请求唯一标识，成功和失败响应都可包含，用于追踪与排错；
- `document` 仅在 `return_documents=true` 时返回。

SDK 会额外封装 `status_code`、空字符串的 `code`/`message`、`request_id`、`output` 和 `usage`；这些是 SDK 包装，不应误认为原始 HTTP 顶层字段全部相同。

Phase E 真实适配器必须从原始 HTTP 映射：

- `output.results` → 内部严格 Top-10 响应；
- `request_id` → `provider_request_id`；
- `usage.total_tokens` → `total_tokens`。

官方公开响应**没有确认**以下字段：

- `usage.input_tokens`；
- `usage.output_tokens`；
- 本次请求实际人民币费用；
- `model` 或“响应模型”字段；
- 模型 snapshot/version 字段；
- region 字段。

因此适配器不能声称这些值来自 Provider。`requested_model=qwen3-vl-rerank` 和所选北京 region 可以保存为本地请求配置事实，但必须与供应商响应事实区分。当前 Phase E Provider 结果契约若强制要求 input/output token 拆分或 response model，需要在真实适配器前调整为“供应商未提供时为 null”，不能把 `total_tokens` 猜分或把请求模型复制成响应模型冒充回传值。

来源（访问日期：2026-08-13）：

- [通用文本排序模型 API 使用详情](https://help.aliyun.com/zh/model-studio/text-rerank-api)

## 6. 官方公开页无法确认的项目

以下项目在本次查阅的阿里云官方公开页中没有找到明确数值，应保持未知：

1. 单张图片最大文件字节数；
2. Base64/Data URI 最大字符数；
3. HTTP JSON 请求体最大字节数；
4. 图片最小/最大宽高、像素总数或长宽比；
5. PNG 压缩后大小与图片 token 的精确换算公式；
6. 20 张图片混合不同尺寸时的预估 token 方法；
7. 独立最大并发请求数；
8. `qwen3-vl-rerank` 在北京以外地域的可用性与专用端点；
9. Python `dashscope` SDK 的最低兼容版本；
10. API 是否返回响应模型、模型快照、输入/输出 token 拆分和本次实际费用；
11. 供应商是否提供请求级费用硬上限参数；
12. 账户当前免费额度余额、活动折扣和真实限流是否被单独调整。

这些未知项不能通过其他视觉模型文档类推。获得用户新授权后，smoke 的意义正是用最少真实请求确认其中会影响 Top-20 协议可行性的部分；账户余额和活动价格则应在调用前从控制台人工确认。

## 7. 本地实现与样本就绪度

### 7.1 Server/Provider 边界

`EvaluationModule` 现在通过独立工厂选择 Provider。默认 `SHADOW_RERANK_PROVIDER=disabled`；只有显式选择 `dashscope` 且北京业务空间 ID/API Key 配置完整，才装配真实适配器。适配器已用本地 fake HTTP 覆盖官方请求映射、20 张 Data URI、隐私字段排除、成功响应、明确 HTTP 拒绝和畸形响应；测试没有访问网络。

内部结果契约已通过增量迁移与运行时 Schema 调整为：

- `requested_model`、北京 region、请求端点保存为本地发出请求时已知的事实；
- `provider_request_id` 与 `total_tokens` 保存为供应商响应事实；
- 官方未返回的 response model/snapshot、输入/输出 token 拆分和实际费用保存为 `null`；
- `estimated_cost_cny` 按全部 token 使用图片最高单价计算，与供应商账单 `billed_cost_cny` 分开标识。

新增只读 `GET /evaluation/runs/{id}/shadow-rerank/preflight`：它在本地组装真实 DashScope wire JSON，只返回文档数、UTF-8 body 字节数和指纹，固定 `external_call_count=0`，不创建 shadow run、不返回查询/Base64，也不调用 Provider。

真实派发另有持久状态预算门：首次默认最多 1 次；以后即使另行授权将上限配置到 2～4 次，每次仍按下一请求理论最高 ¥0.216 预留累计 ¥0.5 预算。该门通过 PostgreSQL 表锁跨所有 Evaluation run 统计同一 Phase E 协议，另建 run 不能重置额度。只因次数或预算策略被拦截且从未外发的查询可在后续明确扩大授权后恢复；已外发、已完成或结果未知的请求绝不重放。任一已外发请求缺少用量时立即停止，运行汇总 token、耗时和费用估算保持 null，不用零或部分已知值低估成本。

### 7.2 PostgreSQL 只读核对

首次核对时对本地 PostgreSQL 做了只读统计，当时还没有视觉 Evaluation 样本：

| 就绪项 | 首次核对数量 | 含义 |
| --- | ---: | --- |
| 已生成报告的历史 Evaluation run | 3 | 历史报告仍可只读查看。 |
| `search_scope='visual'` 的查询 | 0 | 首次核对时没有查询满足 Phase E 的视觉评测入口条件。 |
| 可执行 Phase E 的查询 | 0 | 首次核对时没有可冻结并发送的 Top-20 样本。 |
| 成功的 `evaluation_candidate` 证据 | 0 | 首次核对时历史 Agent 证据不能冒充 Evaluation 冻结证据。 |

之后用户提供查询“有人在海边走路”。系统已通过正常 Evaluation 流程新建并冻结一个
`search_scope=visual` 的 discovery 查询，本地检索冻结 RRF Top-20，并为其中 20 个视频场景全部
生成成功且具有输入/产物双 SHA-256 指纹的 `contact_sheet_v1`。RRF Top-20 包含 12 个视频帧
代表候选和 8 个 Caption-only 视频候选；后者保留冻结 Caption Asset，证据只使用同 file/scene、
当前 generation 且已有 indexed `video_frame_vectors` 引用的确定性帧锚点。没有修改候选、重新
搜索、重新索引或写 Qdrant。

用户已完成 current/RRF 两个 Top-20 并集共 27 个候选的人工判断。实际 reported run 是
`bd5ebb5d-503b-4f1b-a6ce-88c5aae44994`；为其生成 20/20 成功双指纹证据后，只读 preflight 在
**本地、不外发**条件下组装完整请求，得到 20 个 document、18,530,463 bytes JSON 正文、查询
指纹 `86b0d621…0a0aa` 和证据指纹 `fdf07baa…882ad`。页面最初仍停在旧的未标注 run，不能把两个
run 的状态混写。

## 8. 外发数据清单

一次真实 smoke 会向阿里云百炼北京地域发送：

- 完整原始查询文本 1 条；
- 恰好 20 张派生 PNG：图片候选是固定缩放图，视频候选是包含 1–12 个已索引帧及时间戳标记的 contact sheet；
- `qwen3-vl-rerank`、`top_n=10` 等协议字段。

不会发送：源视频、绝对路径、文件名、候选 ID/Key、证据 SHA-256、Caption、转录、RRF 名次、人工标签或报告。内部候选 Key 和指纹只用于本地把返回的 `index` 安全映射回冻结候选，不应进入供应商 JSON。

## 9. 获得授权前后的执行门槛

### 获得授权前

- Provider/API 调用次数必须保持 0；
- 不显示或使用 API Key 值；
- 不发送查询、Base64、图片、文件名、路径、Caption 或转录；
- 不用 HEAD/OPTIONS/错误 Key 等“探测请求”试接口，因为它们仍是外部请求；
- 不把官方未公开字段填成看似真实的值。
- 真实适配器与可空审计契约已完成 fake 回归；用户已完成 27 个正式候选的人工判断，reported run、视觉 RRF Top-20、20 份证据和只读 preflight 请求事实均已冻结。不得修改冻结事实或由 preflight 偷偷重新搜索。

### 用户明确授权后，第一次调用前仍需确认

1. 控制台所选地域是华北 2（北京），业务空间和 API Key 属于同一地域；
2. 控制台中模型仍可用，价格、免费额度余额和限流没有变化；
3. 授权文案列明：发送完整原查询和 20 张派生 PNG，不发送源视频、绝对路径、文件名、Caption 或转录；
4. 第一轮只授权 **1 次**串行 Top-20→Top-10 请求；按 120,000 token 与全图片单价计算，其理论费用上界是 ¥0.216；
5. HTTP 硬超时与 `dispatched → outcome_unknown` 停止条件生效，未知结果不自动重试；
6. 每次保存 request bytes、`usage.total_tokens`、耗时、`request_id`、结果完整性和响应指纹；
7. 任一返回缺失/重复/非法 index、非有限分数、不是恰好 Top-10、HTTP 413/429、协议错误、模型不可用或结果未知时立即停止，不拆批、不补位。

第一轮成功后，再根据真实 `total_tokens`、请求字节数、控制台账单和结果完整性决定是否另行授权后续请求。即使后续继续，冻结边界仍是总计最多 4 次、累计费用不超过 ¥0.5；不能一次性把四个理论满额请求都放行，因为其保守上界是 ¥0.864。

## 10. 本次操作审计

前置核对阶段没有外发。用户随后于 2026-08-13 明确授权第一轮单次 smoke，Server 使用一次性
进程配置启用 Provider，完成 **1 次** Top-20 请求后即关闭，仓库 `.env` 仍保持默认 disabled。
本次请求获得 HTTP 200 和 Provider request ID，但供应商正文没有通过严格成功响应 Schema；安全
审计只能确认正文中有 10 个 `output.results`，不能在不保存原始正文的前提下断言究竟是额外字段
还是字段类型漂移。因此尝试按协议整体失败、`external_call_status=completed`，排名行保持 0，且绝不
自动重试。由于完整 Schema 未通过，`usage.total_tokens` 未被采信并保存为 null；实际账单只能到
阿里云控制台按 request ID 复核，不能声称费用为 0 或按部分事实估算。

- 模型/Provider 推理调用：**1 次**；
- 发送到阿里云的本地图片：**20 张派生 PNG**；
- 请求正文：**18,530,463 bytes**；
- HTTP/外部调用状态：**200 / completed**；
- 运行/尝试状态：**failed / failed**；
- Provider request ID：`c738eb52-2fde-9d96-95d0-27bf501a2b2e`；
- 返回结果实际数量/写入排名数量：**10 / 0**；
- Provider 延迟：**2,689 ms**；
- 响应指纹：`aee4b1d9…05bc8`；
- `total_tokens`、供应商账单费用、本地费用估算：**null / null / null**；
- 理论费用上界仍为 **¥0.216**，但这不是实际账单；用量未知门会阻止后续派发；
- 显示或记录的 API Key 值：**0 个**；
- PostgreSQL 迁移前备份：`/private/tmp/stars-phase-e-smoke-preflight-20260813.dump`；
- 迁移后媒体文件/Asset/场景/Vector Ref：**35 / 7,940 / 1,919 / 7,564**，与迁移前一致；
- 迁移后 Qdrant 三个 Collection Point：**8 / 5,629 / 1,927**，与迁移前一致；
- 当前视觉查询/正确 reported run 的成功 Evaluation 候选证据：**1 / 20**；只读 preflight 已生成 **20 documents / 18,530,463 bytes** 的真实样本请求预览。

### 10.1 首次调用后的协议修复与控制台用量核对

用户在阿里云模型监控确认首次调用共 **25,640 tokens**，其中：

- 文本输入：1,200 tokens，按 ¥0.7/百万 tokens 估算 ¥0.000840；
- 图片输入：24,440 tokens，按 ¥1.8/百万 tokens 估算 ¥0.043992；
- 标准原价合计：**¥0.044832**。这不是实际应付账单，免费额度或优惠可能使账单更低。

该数据来自控制台人工核对，不是已通过 Schema 的 Provider 响应。增量迁移
`0007_phase_e_shadow_usage_reconciliation.sql` 新增一对一核对事实，独立保存来源、Request ID、
三类 token、观察时间和标准原价估算；第一次 attempt 的 Provider `total_tokens` 继续为 null，
失败状态和 0 条排名不变。预算门可以读取这条核对事实，但不会把它冒充成响应字段。

针对首次 HTTP 200 却被旧版 `.strict()` 拒绝的问题，fake 回归先复现了顶层、`output`、`usage`
和 result 扩展字段导致整包失败，随后改为只提取项目依赖字段。`index`、`relevance_score`、
恰好 Top-10、唯一/范围/有限分数和顺序仍严格；核心畸形时只保存字段路径与错误类型，不保存
Provider 正文或具体值。用量缺失时合法 Top-10 可以保存，但 token 保持 null 且预算门继续停止。

迁移前备份为 `/private/tmp/stars-phase-e-rerank-fix-20260813.dump`。迁移前后 PostgreSQL
媒体/Asset/场景/Vector Ref 为 **35 / 7,940 / 1,919 / 7,564**，Qdrant 三个 Collection 为
**8 / 5,629 / 1,927**，均未变化。核对写入阶段 Provider 明确保持 disabled，没有新增模型调用。
首次调用的响应兼容修复后，第二次 smoke 不复用旧 attempt：`0008` 为同一冻结 Evaluation
增加递增 `execution_number`，显式 retry 创建新的 run/attempt，并在派发前比较上一执行的
query/evidence 指纹。第一次 request ID、错误、响应指纹和人工用量核对继续保持只读。

### 10.2 第二次真实 smoke 结果

用户再次明确授权后，临时 Server 只将全局调用上限扩大到 2，并对第一次调用所属的同一
reported Evaluation run 创建 `execution_number=2`。期间曾识别到浏览器中的旧 run ID，安全
检查在创建 attempt 和外发前拒绝了该错误目标；反查 PostgreSQL 确认正确 run 与查询后才派发。

- 调用次数：本轮 **1 次**，历史累计 **2 次**；临时 Server 随后关闭；
- 查询：`有人在海边走路`；冻结 query/evidence 指纹与第一次一致；
- 外发：完整 Top-20 的 20 张派生 PNG，一次请求，不拆批；
- 请求大小：**18,530,463 bytes**；区域：`cn-beijing`；
- Provider request ID：`2878ae48-26f3-993c-ad0e-f29b2747a44b`；
- 状态：`succeeded / completed`；候选/结果：**20 / 10**；PostgreSQL 排名行：**20**，其中
  **10** 条拥有 shadow rank/score；
- `total_tokens`：**25,640**；耗时：**3,138 ms**；Provider 未返回分项 token 或实际账单；
- 保守费用估算：**¥0.046152**（把未知分项全部按图片单价计算，不是实际账单）；加上第一次
  控制台分项估算 ¥0.044832，累计估算 **¥0.090984**；
- Precision@5：RRF **0.60** → shadow **0.80**，即前 5 条人工相关候选由 3 条增至 4 条；
- Precision@10：RRF **0.50** → shadow **0.70**，即前 10 条相关候选由 5 条增至 7 条；
- nDCG@10：RRF **0.579** → shadow **0.710**；nDCG 越接近 1，表示高相关候选越靠前；
- 本次只有 **1 条查询（n=1）**，只能说明该样本改善，不能据此推断整体产品效果；
- `relevance_score` 只用于本次请求内部排序，不是相关概率；
- 普通 Search/Agent 候选顺序、Qdrant 和 VLM Review 均未改变或执行。
