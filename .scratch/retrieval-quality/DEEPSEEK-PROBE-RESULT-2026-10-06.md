# DeepSeek替换可行性实验结果

> 本文为首次403的历史结果。用户随后开通模型权限并明确要求新批重试，r2看图与合成决策格式均成功，最新状态见 [恢复后验证](DEEPSEEK-RECOVERY-RESULT-2026-10-06.md)。原失败及费用预留保留，不覆盖历史记录。

## 结论

DeepSeek官方当前Flash支持图片及工具调用；官方deepseek-v4-flash旧名称映射到V4.1-Flash。RightAPI公开列表也在现有/flash渠道列出deepseek-v4-flash可用，渠道备注声明支持多模态。上述为官方/Provider声明，不能替代本账号的实际调用验证，也无法确认RightAPI底层权重版本。

当前Key的/flash/v1/models目录只列glm-5.3，未列任何DeepSeek名称。使用同一地址和Key的最小自建PNG+工具调用请求已收到HTTP403，响应没有模型名、请求编号或用量。说明本次请求被拒绝，不能据此断言模型不支持图片。公开目录与认证目录不一致，推断可能为Key模型白名单或账号权限；具体拒绝原因未确认。已请求用户检查对应Key模型权限及请求记录，不要求发送密钥。

本次没有正式替换模型，也没有给检索Agent新增看图工具。不能把换model字符串等同于视频帧已接入、检索质量通过或Goal完成。

## 实际执行

- 新模型请求1次：deepseek-v4-flash，自建512×320 PNG（左蓝色正方形、右橙色圆、随机六位字符），无私人素材；请求12296 UTF-8字节、输出上限256 token。状态received、HTTP403、耗时771毫秒；用量和实际收费null。
- 第2次共享检索动作约束兼容测试未执行。失败或缺用量停止批次，没有重试、自动切换别名、切换渠道或重放请求。
- 认证模型目录只读2次，两次HTTP200，均无模型推理。公开模型/渠道页各只读1次，不带Key、无素材。
- 工程检查：脚本类型检查成功，准备阶段0外发，两请求编码大小12296/7128字节；自建图本地检查无隐私内容。工作区差异检查通过。未改产品代码、正式.env或数据库，无需迁移/回填/重新索引。

## 预算

新DeepSeek请求估算与账单未知，保留0.410472元正预留，不按0处理。累计58 GLM、17产品图片重排、1 DeepSeek探测，共76个已派发模型请求；本次HTTP403为明确响应，当前没有新增结果未知请求。包括历史预留，预算占用8.4188848元，累计20元预算门未变。当前缺用量的DeepSeek请求阻止后续收费试验，待平台记录澄清或直接用户明确恢复；不得在保留GLM旧许可的情况下绕过这项停止条件。

## 证据与后续边界

- deepseek-probe-result.json：本次派发摘要、HTTP状态和费用预留。
- deepseek-model-directory.json：认证目录核对。
- rightapi-models-public.html、rightapi-upstreams-public.html：Provider公开JSON原始快照，抓取日期2026-10-06；不含Key。
- 官方来源：https://api-docs.deepseek.com/quick_start/pricing/ 、 https://api-docs.deepseek.com/guides/vision/ 、 https://api-docs.deepseek.com/guides/tool_calls/
- Provider来源：https://www.rightapi.ai/models/public 、 https://www.rightapi.ai/upstreams/public

权限恢复后应先完成最小看图与共享严格动作协议兼容测试，再决定是否实现可配置的实验决策模型和按需场景画面工具。保持原文基线、单独图片授权、费用门、派发落盘、未知不重放和人工质量门；此前GLM质量记录不能自动授予DeepSeek资格。图片协议可用也不证明自然视频或连续动作理解正确。
