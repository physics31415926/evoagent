# 架构与继续开发交接

## 当前状态（2026-11-17）

已继续完成原生 JavaScript Host 插件 **dsh-evoagent 0.1.0**，位于 `plugins/evoagent/`，通过 plugin_manager 安装到 desktop profile 并启用。当前会话实际调用 `evoagent_plan` 和 `evoagent_records` 成功，未执行真实模型探索、未产生付费模型调用。Python 核心仍独立保留；本轮没有提交 Git，也没有改变原有暂存内容。

## 核心流程

```text
任务 + Policy预算
  → 检索带状态和来源的经验
  → 多策略并行候选
  → 独立验证器
  → 相同产物去重；成功选优 / 失败修正 / 未验证保留
  → 保存完整运行与经验

策略候选 + 基线
  → 相同调用与输出token上限 + 每任务隔离记忆
  → 开发题比较与回归检查
  → 存档、建议人工复核（不自动激活）
```

## 测试状态

- Python 全部 **34 项 unittest 通过**（当前完全权限环境）。此前 workspace-write 下的临时目录 ACL 失败是历史结果；没有执行 ACL 修复或删除历史临时目录。
- 完全权限重跑揭示独立的 SQLite 连接未关闭问题：`with sqlite3.Connection` 只管理事务，导致 ResourceWarning 和 Windows WinError 32。已将 `Store._connect` 改为 contextmanager，在 finally 显式 close，保留提交/回滚语义；完整测试复验通过。
- JS 插件 **14 项 Node 测试通过**，覆盖安全算术解析、样本隔离、预算、去重、失败不选、文本未验证、Host 流协议、一次性计划及取消等待全部调用退出。语法检查通过。普通 Node test 隔离遇到 sandbox spawn EPERM，使用官方 `--test-isolation=none`。
- 首次安装发现参数 DSL 不支持 `min/max`；已去除并在执行体中验证 64–2048 token 范围，重新启用返回 `application: applied`。当前工具 plan/records 真实调用成功。
- 独立 UX 静态审查已完成，修复标准清单文件名、metadata 流程/费用说明、固定错误码和取消后的记录边界。无浏览器控制，未验证图标/详情页渲染。
- 没有调用付费模型 API；模型流接口仅做 mocked 检查。真实 provider 的 explore 全链路仍待验收。

## Host 插件实现与后续

首版实际流程：`evoagent_plan` 返回确切模型消息并留在正常工具日志 → 人工/智能体审阅 → `evoagent_explore(plan_id, provider, model)` 通过 `ctx.llm.stream` 复用配置执行 → `evoagent_records` 读取同 agent 的派生缓存。模型输入不通过未知 session event 注入。计划一次性、30 分钟过期、最多 3 并行调用、默认每次 512 输出 token、120 秒协作取消，等待所有调用停止后才返回。文本一直 unverified；表达式只做有限语法解析与样本验证。

范围：未迁移 Python 的 SQLite 持久记忆、失败修正及 EvolutionLab；不训练、不自动激活策略、不执行任意代码。缓存随重载丢失，日志是审计源。使用方法与恢复限制见 `plugins/evoagent/README.md`。

安装注意：plugin_manager 本轮安装时同时将原有 billion-context 从 lockfile 中 0.1.213 对齐为 profile 声明的 0.1.215（工具输出报告），非手动修改；工具还报告本地 link peerDependencies 解析提示。实际插件已成功加载，重启后仍需关注 link 包依赖解析。后续只用插件管理器管理，不直接改 profile。真实 explore 验收需选定已配置的 provider/model，并明确模型费用授权。

下列为开发时核对到的安装版事实：

- `DSH_PROFILE=desktop`。
- 当前 CLI 包版本 `@deepseek-ai/dsh` **0.2.2-rc.3**。
- `DSH_INSTALL_DIR=D:\deepseek\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh`。
- `DSH_NODE_EXECUTABLE=D:\deepseek\DeepSeek Harness.exe`。
- 尚无可用的 Cordis live inspect 工具；接口依据安装包 README 与源码，不得声称实时注册验证完成。

建议先做 **Host 工具插件**，而不是独立网页或 iframe。将现有核心作为算法原型，选择：原生 JS 实现核心（减少 Python 部署与子进程边界）或明确配置的 Python 桥接。模型调用应优先核对 DSH 本身 LLM/subagent 服务，避免要求重复填写密钥；尚未核对这些服务的实际签名，不能凭记忆接入。

必需文件：独立插件目录内 package.json、cordis.patch.yml、Host index.js、英文/中文 locale、原创 icon.svg 和运行文档。注册 tools 使用安装版 `@deepseek-ai/dsh-tools` 的 `defineTool` 与 `ctx.tools.register`。资源必须归所属 ctx effect 管理，取消执行要响应 exec.signal。

安装规则：用 `plugin_manager install_bundle` 安装工作目录中的包，先通过 list 获取确切现有标识。不要直接改 profile 的 package.json/cordis.patch.yml，不要在 profile 中执行 pnpm。该操作影响同一 profile 的所有会话，需工具授权；没有授权就交付可安装包。现有会话的 preset 不保证随新安装变更，行为验证建议新会话。

插件配置、工具权限、模型上下文与会话日志必须遵循 dsh-doc：额外记忆是缓存，模型可见的数据需通过正常工具结果或已记录注入进入 session log；不要发明未知 session event。插件不得自动更改裁判、权限或发布自己。

## 0.2.0 更新与发布（本轮）

参考 FL updater，新增固定 GitHub 源 `physics31415926/evoagent`，用户选择定期检查、确认安装：加载后 60 秒首次检查，每 6 小时查询；不自动安装、不调用模型。`evoagent_update` 提供 status/check/prepare；prepare 仅校验下载返回 installTarget，真正变更 profile 必须走官方 plugin_manager 权限流程，不能直接内部服务绕过。开发 link 拒绝覆盖。

严格 stable tag `dsh-plugin-vX.Y.Z`、唯一精确 tarball 名、GitHub HTTPS 每跳限制、8 MiB 流式上限、必须 SHA-256 digest、大小匹配；错误独立状态不是无更新。缓存/合并有界，成功准备包每激活最多 3 份留 OS temp，避免卸载删安装源；后台结果不静默注入模型上下文。

发布脚本 `scripts/release-plugin.mjs` 支持 --check 与本地 pack/checksum，校验 npm pack 实际资源白名单、拒绝 symlink/覆盖资产。`.github/workflows/release-plugin.yml` 在版本 tag 推送后测试→draft→上传 tgz/checksum→发布；只对固定仓库生效。尚未创建远程仓库、配置 remote、推送 tag 或发布 GitHub Release。本地可安装包不等于远程发布。JS 与发布脚本共 28 项离线测试通过，Python 34 项通过；真实 GitHub 下载/新版本替换尚未端到端验收。

## 研究路线

1. 先在 Harness 内提供探索工具、经验查询和只读实验记录，跑通一个真实模型任务。
2. 接入可隔离、可限时的代码验证，测试只能由外部受信验证器管理。
3. 对比单模型、best-of-N、固定多分支和动态修正，并记录真实 tokens、金额、耗时。
4. 引入记忆质量/迁移对照、候选组合重测、任务相关策略变异。
5. 有未见任务增益和旧能力回归检查后，再考虑训练或更自主的进化。
