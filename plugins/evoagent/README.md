# EvoAgent Exploration Lab / 探索实验室

DSH **0.2.2-rc.3** Host 工具插件首版。复用 Harness 配置的 provider/model，不接收密钥，不启动 Python、Shell 或独立网页。

## 使用流程

1. 在插件管理器安装此本地目录（包名 `dsh-evoagent`），检查并批准 profile 级变更；新开会话确认工具可见。安装前先列出现有插件，避免重复。不要手改 profile 文件。
2. 请智能体调用 `evoagent_plan`：`task={"id":"linear-1","prompt":"Return the expression 2*x+1","kind":"expression","inputs":[0,1,2],"expected":[1,3,5]}`，`strategies=["direct","alternative","counterexample"]`，`max_tokens=512`。也可用 `kind:"text"` 不传样本。
3. 检查返回的 requests（确切模型输入）、预算和验证样本。样本不会进入插件生成的模型消息；这不代表它们对父智能体保密。任务 prompt 若主动含答案/样本也不会被自动脱敏。
4. 确认允许模型调用后，以返回的 `plan_id` 和已有 provider/model **配置标识符（不是显示名）**调用 `evoagent_explore`，例如 `{"plan_id":"<上步返回的ID>","provider":"<已配置provider-ID>","model":"<已配置model-ID>"}`。应从当前配置查明 ID，不凭空填写。这可能产生费用；插件不自动选择模型、不重试、不提供零费用保证。
5. 阅读 `status`、每个候选 `evidence` 和 `duplicate_of`。`evoagent_records` 只读返回本 agent 最近 30 次运行。

英文概述：Plan first, inspect exact requests, then explicitly execute on a configured DSH provider/model. Results distinguish sample-passed, failed, and unverified proposals. This is a bounded exploration prototype, not autonomous self-improvement.

## 限制与反馈

- 每计划默认 1 策略，最多 3 策略并行；每次 64–2048 输出 token；一次性计划，30 分钟过期。最多缓存 20 计划、30 运行。缓存随插件重载/重启清空，正常工具日志是审计来源。
- 模型调用有 120 秒协作取消，响应父工具的 `exec.signal`。服务必须配合 AbortSignal；插件等待所有调用结束再返回，不以后台遗留调用伪装取消。失败或取消后先查询记录/日志；取消或超时可能不产生 records，必须以工具日志为准，记录为空不代表没有调用或费用。重新计划不会自动恢复消耗的预算。
- 模型应返回 JSON `{ "artifact": "...", "rationale": "..." }`。格式错误记录为候选失败；敏感 provider 错误不回显。`invalid_json` 建议调整提示/输出预算，`response_limit` 建议缩短回答，`invalid_proposal` 建议检查字段，`provider_error`/`proposal_error` 建议检查配置或日志后重新计划。`calls` 是尝试的调用数，不是成功数。
- 取消/超时可能不产生新的 records，计划已消费；必须以工具日志为准，不能因 records 无新增就认定零消耗。
- 开放式任务永远 `unverified`。算术解析器仅允许数字、x、+、-、*、/、**、括号；样本误差不超过 1e-8 才 `passed`。**样本通过不是通用正确性证明**。失败候选永不被选作答案，不执行任意代码。
- 用量来自 provider；缺失为 null，不伪造 token 或金额。失败流中的部分用量可能不可用。未报告 reasoning/cache 字段时不要据此估算账单。
- 此版不提供持久经验检索、跨任务自动注入、修正回合、策略比较/进化实验、训练、自动发布或权限更改。Python 核心仍是独立原型，不代表两者功能完全等价。
- 0.1.0 已通过 plugin_manager 安装并启用到 desktop profile，实际调用 `evoagent_plan` 和 `evoagent_records` 成功；当时 14 项离线 JS 测试通过。0.2.0 增加更新工具与发布流程，另有 mock 更新测试与发布脚本测试。真实 provider 的 `explore` 尚未调用，图标/详情页缺少浏览器视觉验证。

## 更新与 Release（0.2.0）

固定发布源为 `https://github.com/physics31415926/evoagent`，稳定版 tag 为 `dsh-plugin-vX.Y.Z`，资产必须为 `dsh-evoagent-X.Y.Z.tgz`。不接受工具参数改写更新源。仓库不存在或尚无发布时，检查会报告失败/无版本，不假装已经最新。

- **定期检查、确认安装**：加载约 60 秒后首次查询，此后每 6 小时查询公开 GitHub 元数据；不调用模型、不上传任务、不后台下载/执行包。插件卸载时终止检查并清理定时器。配置 `autoCheck:false` 可关闭自动查询。
- 调用 `evoagent_update` 的 `action:"status"` 离线读取上次结果；`action:"check"` 主动查询。成功缓存 15 分钟、失败 60 秒，强制检查仍有 30 秒最小间隔。错误不是“没有更新”。后台结果只存在缓存中，不静默注入模型上下文，也没有新 UI 通知面板。
- 查看版本与说明后，请用户明确同意该具体版本，才调用 `action:"prepare",version:"X.Y.Z",confirmed:true`。这一步**仅校验和下载、不安装**；返回 `installTarget` 后，必须通过官方 `plugin_manager` 的 `install_bundle` 走 profile 权限审核，禁止直接调用内部安装服务。安装影响整个 profile，不能因仅要求检查更新就安装。仅管理器 `applied:true` 表示已应用；其余按 `nextStep` 操作，升级通常还需重启 Harness。每次激活最多准备 3 份包（每份不超过 8 MiB）。成功包保留在 OS 临时目录，不在插件卸载时删除，避免安装器读取期间删源；失败/取消立即清理。系统可能清理临时包，路径失效需重新准备；跨重启的历史包由系统临时目录维护。
- 与 FL 一样，**本地链接安装只检查、不覆盖**；开发者继续更新源码，或经插件管理器改装 release 包。没有插件管理器时不能安装。
- 下载限制为 8 MiB，逐跳限制 GitHub/CDN HTTPS，要求 GitHub 发布的 SHA-256 digest，校验实际大小与摘要；草稿和预发布不参与自动更新，不降级。摘要验证提供完整性而非独立发布者签名。网络受 GitHub 可用性和限流影响。

### 维护者发布

在仓库根目录执行 `node scripts/release-plugin.mjs --check` 检查资源；执行 `node scripts/release-plugin.mjs` 生成 `dist/dsh-evoagent-X.Y.Z.tgz` 与 checksum，不上传。版本在插件 package manifest 中维护，tag 必须一致。

将源码推至上述 GitHub 仓库后，维护者显式推送 tag（例如 `dsh-plugin-v0.2.0`），GitHub Actions 会执行离线 JS/Python 测试、打包，再创建 draft release、上传资产与 checksum，最后发布。发布依赖仓库 Actions/GITHUB_TOKEN 的 release 写权限。失败的 draft 应人工检查，不自动覆盖旧 release。本地提供流程不代表远程仓库、tag 或 release 已创建。

## 开发与验收

在本目录执行 `node --test --test-isolation=none tests/*.test.js`；使用支持该选项的 Node 运行时。在受限 Windows 环境中，此模式避免 test runner 子进程的管道边界，不绕过文件权限。使用 `node --check index.js` / `host.js` / `core.js` 检查语法。工具测试使用真实 ESM Host 工厂与 mock llm，不调用网络。

安装后新会话先确认四个工具可见（含 `evoagent_update`），再运行 plan → 用户检查 → explore → records。验证取消时无遗留调用、表达式错误不被选中、文本不被标为通过；最后才考虑真实模型费用验收。无浏览器控制时不以 mock 页面替代运行 UI 验证。
