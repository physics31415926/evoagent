# EvoAgent：会探索、会验证、会积累的智能体

一个从现有大模型出发的研究型智能体 MVP。不是 AGI，也不声称实现了递归自我改进。重点是把此前报告中的想法变成**能运行、可检查、可扩展**的代码，而非多个模型互相称赞的聊天演示。

## 现在能做什么

- **并行探索**：按不同策略独立生成候选；限制调用数、并发数、轮数、单次输出 token 上限。
- **证据选优**：验证器而非模型给结论。算术任务由有限 AST 解释器实际检查；开放式问题保留 `unverified`。
- **失败分支**：未通过的独特候选可以带验证反馈继续修正，记录父子关系；重复结果合并记录，不继续重复扩展。
- **持久记忆**：SQLite 保存候选、成功与失败、验证器、原任务和运行来源；后续检索到的是有标签的经验，不是无条件正确的知识。
- **策略实验**：用同样的调用/token预算上限比较基线与候选，隔离记忆，列出回归，存档实验。不会自动激活候选。
- **两种模型接口**：无需联网的确定性 DemoProvider；OpenAI 兼容 Chat Completions API。

## 快速开始

需要 Python 3.11+，运行及测试均只用标准库；不需要先安装第三方依赖。在仓库根目录运行：

```powershell
python -m evoagent demo
python -m evoagent run --task examples/transfer.json --provider demo
python -m evoagent memory
python -m unittest discover -s tests -v
```

`demo` 会展示一个故意不完美的候选和正确候选，由独立算术测试选出结果。它是机制验收用的**预设演示器**，不是真实模型能力实验。模型输出不会通过 `eval`、`exec` 或 shell 执行。

## 接真实模型

```powershell
$env:EVO_API_KEY = '你的密钥'
$env:EVO_BASE_URL = 'https://api.openai.com/v1'
$env:EVO_MODEL = '你的模型名'
python -m evoagent run --task examples/linear.json --provider openai
```

也可设置你自己的 OpenAI 兼容服务。远程服务要求 HTTPS，本地服务可用 localhost HTTP；不支持自动跟随重定向。不要把密钥写进源码或提交到 Git。API 调用会产生费用；本项目不会自动读取 DSH 的凭据。调用上限不是精确金额上限，网络失败也计一次尝试。

普通研究问题可使用研究示例：

```powershell
python -m evoagent run --task examples/research.json --provider openai
```

这会生成候选文字，但**没有联网检索或事实核查能力**，结果保持未验证，不得视为事实证明。

## 数据与接口

任务格式示例（此处是验证器的数据，不会把输入/期望值发送给模型）：

```json
{"id":"linear-1","prompt":"Compute 2*x + 1","kind":"expression","inputs":[-2,0,3],"expected":[-3,1,7]}
```

模型只收到题目、策略、带状态的记忆和有限反馈。模型输出是 `{"artifact":"2*x+1","rationale":"..."}`。这里 `rationale` 是简短方法说明，不要求模型提供隐含思维链。

- 运行记录和记忆默认保存在 `.evoagent/state.sqlite3`；通过 `--state` 可切换独立实验存储。
- CLI 输出 JSON，包含分支、父分支、去重关系、验证证据和预算使用量。
- 记忆含原始任务和模型产物，可能包含敏感信息。不要把数据库提交到公开仓库。使用真实 API 时，检索的内容会发送给该服务。

## 策略进化实验

CLI 的 `evolve` 接收一个任务数组 JSON 文件，比较固定策略与一个不同分工的候选；具体命令见 `python -m evoagent evolve --help`。

代码也可以直接使用：

```python
import asyncio
from evoagent.models import Policy, Task
from evoagent.providers import DemoProvider
from evoagent.memory import Store
from evoagent.evolution import EvolutionLab

report = asyncio.run(EvolutionLab(DemoProvider(), Store('.evoagent/lab.sqlite3')).compare(
    [Task('dev-1', 'Compute 2*x + 1', inputs=(-2, 0, 3), expected=(-3, 1, 7))],
    Policy(strategies=('direct',), max_calls=3),
    Policy(strategies=('direct', 'alternative', 'counterexample'), max_calls=3),
))
print(report['recommendation'])
```

这里的“进化”仅指**受限策略搜索基础设施**：人工指定候选→公平上限比较→归档与建议。不包含自动改源码、模型权重训练或生产部署。比较的是相同预算上限，并不保证真实 token/金额相同；顺序调用也有随机性和时段偏差。开发集反复使用会过拟合，不能拿它当最终能力证明。

## 项目结构

- [数据接口](<evoagent/models.py>)：Task、Policy、Proposal、Evidence、Attempt、RunResult。
- [思考引擎](<evoagent/engine.py>)：并发探索、验证、去重、修正与选择。
- [独立验证器](<evoagent/verifiers.py>)：安全算术解释器和未验证占位器。
- [记忆仓库](<evoagent/memory.py>)：SQLite 经验、来源和策略实验存档。
- [策略实验室](<evoagent/evolution.py>)：隔离实验与回归检查。
- [模型接口](<evoagent/providers.py>)：离线演示和真实 API。
- [命令行](<evoagent/cli.py>)：运行、演示、经验查询与实验。
- [架构与下一步](<docs/architecture.md>)：能力边界、研究路线与验收标准。

## 明确还没实现

没有自动生成测试、任意代码执行沙箱、源码修复工具、浏览器工具、向量记忆、知识图谱、自动组合两个候选、动态发明新角色、自动训练/蒸馏、无人值守长期运行。当前分支扩展是反馈修正，合并是相同产物去重，不应称为完整的自主研究组织。

算术通过只表示给定样本测试通过，不是对任意输入的数学证明。安全解释器不是通用代码沙箱。若要接入代码修复，必须先建设仓库隔离、进程/资源限制、网络和文件权限、不可被候选改写的外部测试。
