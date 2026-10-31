# 让后端 Agent 真正「会干活」

> 面向对象：手里有一份**不能外迁的 Python 后端**，想让它的写代码能力从「一次性生成」升级到
> 「像 DeepSeek Harness / Cursor 那样主动读代码、动手改、跑验证、自我纠错」的团队。
> 本文给出**诊断 → 架构 → 可直接照抄的实现要点 → 移植清单 → 常见坑**。
> 仓库内的 `server/tsd/agent_loop.py`、`toolbox.py`、`repo_map.py` 就是这套设计的完整参考实现。

---

## 1. 为什么「后端 Agent」会显得笨

把同一个模型（哪怕就是最强的模型）放进两种壳里，表现能差出量级。所谓「笨」几乎不是模型问题，
而是**外壳剥夺了模型动手的能力**。下面 8 条是我们在真实项目里逐条验证过的病因，逐条对应一个修法。

| # | 症状 | 真实病因 | 修法（本文第几节） |
| --- | --- | --- | --- |
| 1 | 改出来的代码编译不过、函数名瞎编 | 一次性生成：模型只能凭记忆写，看不到真实文件 | §2.2 工具化读取（`read_file`/`grep`/`list_files`） |
| 2 | 「我已完成」但文件没变 / 改错位置 | 输出靠自然语言描述，没有落盘通道，也没有回读确认 | §2.3 结构化编辑 + 改后回读 |
| 3 | 一次改 10 个文件，全崩 | 单轮大改，错误叠加，没有小步验证 | §2.4 一步一改 + 验证循环 |
| 4 | 报错了不会自己修 | 工具输出没有回灌到上下文；或回灌了但没让它继续 | §2.4 「观察 → 决策」闭环 |
| 5 | 长任务跑到一半 context 爆掉 | 没有上下文预算与压缩策略，历史无限增长 | §2.6 上下文预算 + 压缩 |
| 6 | 同样的错误重复 5 次 | 没有失败计数与「换个方法」的提示 | §2.6 失败上限 + 纠偏提示 |
| 7 | 不知道项目的测试怎么跑 | 没有仓库感知：语言、包管理器、测试命令全靠猜 | §2.5 仓库地图 + 约定文件 + 命令探测 |
| 8 | 用户等 10 分钟什么都没看到，最后还不知道改了啥 | 没有过程事件流，只有首尾 | §3 事件流与可观测性 |

**一句话结论**：智能体能力 = 模型能力 × 外壳能力。外壳做对了，同一个模型的表现能上一个台阶；
外壳做错了，再强的模型也只能一次性猜。下面的设计就是把这个「外壳」补上。

---

## 2. 六层架构（照这六层补齐，agent 立刻变聪明）

```
            ┌───────────────────────────────────────────────┐
  用户输入 → │ 1. 任务简报（任务 + 方案 + 项目约定 + 仓库地图） │
            └───────────────────┬───────────────────────────┘
                                ▼
            ┌───────────────────────────────────────────────┐
            │ 2. 决策循环（while 未完成 & 未超预算）           │
            │    LLM → thought + tool_call → 执行 → 观察结果  │
            │         ↑                                  │    │
            │         └──────── 观察回灌 messages ────────┘    │
            └───────────────────┬───────────────────────────┘
                                ▼
            ┌───────────────────────────────────────────────┐
            │ 3. 工具层（受沙箱约束的文件 / 命令能力）        │
            └───────────────────┬───────────────────────────┘
                                ▼
            ┌───────────────────────────────────────────────┐
            │ 4. 验证层（跑测试 / 类型检查，失败回灌继续修）    │
            └───────────────────┬───────────────────────────┘
                                ▼
            ┌───────────────────────────────────────────────┐
            │ 5. 预算与安全（步数 / 时长 / 输出截断 / 取消）   │
            └───────────────────┬───────────────────────────┘
                                ▼
            ┌───────────────────────────────────────────────┐
            │ 6. 事件流（thought / tool / verify，UI 实时可见）│
            └───────────────────────────────────────────────┘
```

### 2.1 决策循环的形状

不管语言是什么，核心就是一个 `while`：

```python
while steps < max_steps and not stopped():
    decision = llm(messages, tools=tool_specs)      # 模型决定下一步
    if decision.final:                               # 自己判断完成
        summary = decision.final
        break
    for call in decision.tool_calls:                 # 执行工具
        result = await toolbox.call(call.name, call.args)
        messages.append(observation(call, result))   # 把结果喂回去
    messages = compact(messages)                     # 控制上下文
```

三个必要条件，缺一不可：

1. **模型必须能选工具**（function calling，或降级为 JSON 协议，见 §4.2）；
2. **工具结果必须回灌**，且要**结构化 + 截断**（不要塞整个文件）；
3. **模型必须能自己宣布结束**（`finish` 工具或 `final` 字段），否则会无限打转。

### 2.2 工具集：少而准

参考实现只给 9 个工具，全部围绕「读 → 改 → 验」：

| 工具 | 作用 | 关键参数 | 为什么必须有 |
| --- | --- | --- | --- |
| `list_files` | 列目录（可限定深度 / 忽略规则） | `path`, `depth` | 让模型先看清结构，避免瞎猜路径 |
| `read_file` | 读文件（带行号、分页） | `path`, `offset`, `limit` | 一切修改的前提 |
| `grep` | 正则搜索（返回文件 + 行 + 行号） | `pattern`, `include` | 找符号在哪、谁在用，比全量读便宜 100 倍 |
| `edit_file` | **精确串替换** | `path`, `old_string`, `new_string` | 比整文件重写安全得多，冲突立刻暴露 |
| `write_file` | 新建 / 整体覆盖 | `path`, `content` | 新建文件、小文件整体重写 |
| `delete_file` | 删除 | `path` | 重构时清理死文件 |
| `run_command` | 跑命令（白名单） | `command`, `timeout` | 装依赖、跑构建、跑脚本 |
| `run_tests` | 跑自动探测到的测试命令 | — | 让「验证」变成一次调用，模型不用猜命令 |
| `finish` | 宣布完成 | `summary`, `changed_files` | 明确的终止信号，顺带产出交付说明 |

设计要点：

- **`edit_file` 用 old_string 精确匹配**，而不是行号。行号在多次编辑后会漂移，字符串不会；
  匹配失败时**必须返回「未找到完全一致的 old_string，请先 read_file 核对原文」**——
  这句话本身就是纠偏提示，实测能把「瞎改」的失败率压低一个量级。
- **每个工具的返回值都要带「下一步建议」**。例如 `read_file` 超长时返回
  「已截断，用 offset=200 继续读」；`run_command` 失败时返回退出码 + stderr 尾部 + 「可以先用 `npm run build` 复现」。
- **不要给 `git push` / 安装全局依赖 / 网络请求类工具**。这类动作让 Agent 突破了「本地可回滚」的边界。

### 2.3 结构化编辑：为什么不是「让模型输出整个文件」

让模型输出整个文件重写，有三个致命问题：

1. 大文件会撑爆输出上限（模型直接截断，写出半截文件）；
2. 模型会**顺手重排格式 / 删掉它认为没用的代码**，diff 变成噪音；
3. 出错后你无法判断「它到底改了哪些地方」，也没法做局部回滚。

`old_string → new_string` 的替换模型天然带来四件事：最小改动、可校验、可回滚、diff 干净。
参考实现里每次成功编辑都会记录 `changed_files`，用于最后的交付清单和差异面板。

### 2.4 验证循环：让 Agent 自己发现错了

```python
verified = None
if config.verify and toolbox.changed_files:
    for round in range(MAX_VERIFY_ROUNDS):        # 参考实现：最多 2 轮
        result = await toolbox.run_tests()
        if result.ok:
            verified = True
            break
        messages.append({"role": "user",
                         "content": "验证失败，请读错误并修复：\n" + result.tail})
        # 继续进主循环
```

三条经验：

- **验证必须真的跑命令**，不要让模型「自查」。模型自查的通过率高得离谱，且毫无意义。
- **失败输出只回灌尾部**（参考实现截到 `maxObservationChars`，默认 6000 字符）。
  编译错误的真正原因通常在最后 30 行。
- **轮数要有上限**（2 轮足够）。超限就诚实报告「验证未通过」，把错误留给用户看，
  比让它死循环刷 context 强。

### 2.5 仓库感知：让它知道项目长什么样

模型对「一个陌生仓库」的默认预期是训练数据里的 average web app。
真实项目各不相同，所以启动前必须喂三样东西：

1. **仓库地图**（`build_repo_map`）：按目录列出文件，提取函数 / 类 / 导出符号，
   连带行号。控制在一万字符内——够定位，不淹 context。
2. **项目约定**（`read_project_instructions`）：依次找 `AGENTS.md` / `CLAUDE.md` /
   `.cursorrules` / `CONTRIBUTING.md`，命中就整段塞进系统提示。**这一条性价比最高**：
   一次写好 `AGENTS.md`，后面所有 Agent 任务都受益（相当于给模型发了一份项目说明书）。
3. **命令探测**（`detect_commands`）：从 `package.json` 的 scripts、`pyproject.toml`、
   `go.mod`、`Cargo.toml`、`pom.xml` 里推出测试 / 类型检查 / lint 命令，
   存进 `run_tests` 的默认值。`python` 还是 `python3`、`npm test` 还是 `npm run test`，
   这些细节猜错的代价是一次无意义的失败轮。

### 2.6 预算、压缩与纠偏

- **步数预算**：`max_steps`（参考实现默认 24，可配到 80）。到顶就收尾并报告，绝不无限跑。
- **时长预算**：`deadline_seconds`（默认 900s）。到点触发取消，走同一套收尾逻辑。
- **输出截断**：单条工具结果超过 `maxObservationChars` 就截尾并加「已截断」标记。
- **上下文压缩**（`_compact`）：超过 `CONTEXT_CHAR_BUDGET`（参考实现 120k 字符）时，
  丢弃最早的 observation 内容，只留一行摘要（`[已省略 N 字符的历史工具输出]`），
  系统提示和任务简报永不压缩。
- **解析失败计数**：连续 3 次解析不出工具调用就结束（`MAX_PARSE_FAILURES`），
  并且每次都回一句「无法解析，请只输出一个 JSON 对象」——多数模型第二次就对了。
- **取消**：`is_cancelled()` 每步检查一次，配合 SSE 断流 → 后端 `/cancel` → 标记 `cancelRequested`。

---

## 3. 事件流：看不见的 Agent 等于不存在

Agent 每做一件事都要推一条事件，UI 直接渲染成时间线。参考实现的三种事件：

| 事件 | 载荷 | UI 呈现 |
| --- | --- | --- |
| `agent.thought` | `{text}` | 思考气泡（可折叠） |
| `agent.tool` | `{name, args, ok, ms, observation}` | 工具卡片：参数 + 耗时 + 成功/失败 + 输出 |
| `agent.verify` | `{ok, command, rounds, output}` | 验证结果徽章 |

三件必须做对的事：

1. **事件要在动作发生的那一刻发**，不要等结束再补（用户能用它判断要不要中断）。
2. **事件要能重放**：`GET /api/runs/{id}/events?since=N` 支持断线续传，前端刷新后按 run 维度重放
   （注意：`since` 必须按 runId 隔离——每个 run 的 seq 从 0 重新开始，混用会丢事件）。
3. **步骤状态要落盘**：把 `step_status` 同时写回 `run.json`，否则刷新后进度条显示 0/7。

---

## 4. 协议兼容：不是所有内网模型都支持 function calling

内网部署的模型五花八门（vLLM、Ollama、各家网关、甚至套壳代理），
function calling 的兼容性是最容易翻车的地方。

### 4.1 首选：OpenAI 兼容 tools

```python
body = {"model": model, "messages": messages, "tools": tool_specs(), "tool_choice": "auto"}
```

### 4.2 降级：JSON 协议

检测到服务端对 `tools` 报 400 / 不认 `tool_calls`，就切到「纯文本 + JSON 约定」：
系统提示里附上工具清单，要求模型**只输出一个 JSON 对象**：

```json
{"thought": "先看入口文件", "tool": "read_file", "args": {"path": "src/index.ts"}}
```

结束后用 `{"thought": "…", "final": "改动总结", "changed_files": ["…"]}` 收尾。
解析要宽容：允许被 ```json``` 包裹、允许前后有解释文字（用第一个 `{...}` 块）。
参考实现两种协议共用同一套工具与验证逻辑，切换只影响「怎么拿到决策」。

### 4.3 一定要测的兼容性矩阵

| 能力 | 检查方式 | 不满足时 |
| --- | --- | --- |
| `tools` 参数 | 发一个只有 1 个工具的最小请求 | 降级 JSON 协议 |
| 多工具并行 | 一次返回 2 个 `tool_calls` | 串行执行第一个即可 |
| 空 `content` + 有 `tool_calls` | 合法组合，别当错误 | 视为「只想调工具」 |
| `temperature` 为 0 | 部分网关拒绝 | 可配置 |
| 流式 + 工具调用 | 支持度最差 | Agent 模式走非流式 |

---

## 5. 移植到你的内网后端（照单打钩）

你的后端代码不用给外人看，只需要按下面的清单改。**每一行都能在参考实现里找到对应文件。**

### 5.1 文件级清单

| 步骤 | 参考文件 | 你要做的事 |
| --- | --- | --- |
| 1 | `server/tsd/repo_map.py` | 抄一份：仓库地图 + 约定文件读取 + 测试命令探测 |
| 2 | `server/tsd/toolbox.py` | 抄一份：9 个工具 + 路径沙箱 + 命令白名单 |
| 3 | `server/tsd/agent_loop.py` | 抄一份：决策循环 + 双协议 + 验证 + 压缩 |
| 4 | `server/tsd/llm.py` | 加一个 `chat_tools(messages, tools)`，返回 `{content, tool_calls}` |
| 5 | `server/tsd/events.py` | 加 `agent.thought` / `agent.tool` / `agent.verify` 三类事件 |
| 6 | `server/tsd/config.py` | 加 `agent` 配置块（mode / maxSteps / allowCommands / verify / deadlineSeconds） |
| 7 | 你的 pipeline | 把「一次性生成代码」那一步替换成 `await CodeAgent(...).run(task, dir, plan=...)` |
| 8 | 你的前端 | 消费三类事件，渲染时间线（参考 `src/components/project/AgentTab.tsx`） |

### 5.2 最小接入代码

```python
from tsd.agent_loop import AgentConfig, CodeAgent
from tsd.llm import LLMClient

agent = CodeAgent(
    LLMClient(settings.engine()),
    channel=channel,                              # 负责 emit / log / step_status
    config=AgentConfig.from_dict(settings.agent_dict()),
    is_cancelled=lambda: run.get("cancelRequested", False),
)
result = await agent.run(
    task="按升级方案改造这个项目，并保证测试通过",
    target_dir=target_version_dir,
    plan=update_md_content,
)
# result: {ok, summary, steps, toolCalls, failedCalls, changedFiles, verified, verifyRounds, protocol, usage}
```

如果 Agent 最终一个文件都没改（模型太弱 / 提示词没吃透），**必须降级**：
参考实现会退回一次性生成，再不济走离线启发式编辑，保证流水线不空转。

### 5.3 配置项（建议默认值）

```json
{
  "mode": "auto",              // auto | tools | json | single
  "maxSteps": 24,
  "allowCommands": true,
  "verify": true,
  "deadlineSeconds": 900,
  "maxObservationChars": 6000
}
```

`mode=single` 就是老的一次性生成，留作对照组和降级开关。

---

## 6. 安全边界（内网也不能裸奔）

Agent 会真的执行命令、真的改文件，边界必须写在代码里而不是提示词里：

- **路径沙箱**：所有路径 `resolve()` 后必须以项目根为前缀，`../` 一律拒绝。
- **命令白名单**：只允许 `npm / pnpm / yarn / node / npx / python / pytest / tsc / go / cargo / mvn / ruff / eslint` 等；
  其余直接拒绝并告知模型「不在白名单内」。
- **危险模式黑名单**：`sudo`、`rm -rf`、`git push`、`curl | sh`、`:(){ :|:& };:` 等一律拦截。
- **超时与输出截断**：单命令 600s 上限，输出只回尾部。
- **可一键关死**：`allowCommands=false` 时 `run_command` / `run_tests` 直接返回「当前配置禁止执行命令」。
- **不留后门**：不给 Agent 网络工具、不给装全局依赖的权限；它的一切改动都在一个可回滚的目录里。

---

## 7. 调优：让它「更聪明」的具体旋钮

按收益 / 成本排序，改一个测一个：

1. **写 `AGENTS.md`**（收益最高、成本最低）。把项目结构、命名规范、测试命令、
   禁止事项写进去，Agent 每次任务都会读到。
2. **换更强的模型**。在 Agent 模式下，模型能力的敏感度**远高于**一次性生成模式——
   因为每一步的决策质量会被后续步骤放大。
3. **调 `max_steps`**。简单任务 12~16 够了；跨文件重构给到 40+。
   太小 → 半途而废；太大 → 烧钱打转。看事件流里「最后几步是否还在推进」来判断。
4. **收紧 `maxObservationChars`**。内网模型 context 小时调低（2000~4000），
   避免一次 `read_file` 就把预算吃光。
5. **用 `verify` 兜底**。哪怕模型一般，只要有测试兜底 + 两轮修复，
   最终交付质量通常仍然可用。
6. **别让它一次做太多**。任务描述越窄，成功率越高。
   「把 utils 里的日期函数换成 dayjs」远好于「重构整个项目」。

---

## 8. 常见坑（都踩过）

| 坑 | 现象 | 解法 |
| --- | --- | --- |
| 把整仓代码塞进 prompt | 前后都超限，且模型只盯着头几个文件 | 用仓库地图 + 工具按需取 |
| `edit_file` 用行号定位 | 第二次编辑全错位 | 用 `old_string` 精确匹配 |
| 工具输出不回灌 | 模型每步都重复同一个动作 | 观察结果必须 append 回 messages |
| 不回灌「失败」 | 模型不知道自己错了，一直宣布成功 | `ok=false` + 错误尾部一起回灌 |
| 没有终止条件 | 跑到步数上限才停，最后没总结 | `finish` 工具 + `final` 字段双保险 |
| 事件在结束后才发 | UI 长时间空白，用户以为卡死 | 动作发生即 emit |
| `since` 用全局 seq | 换 run 后聊天/日志丢事件 | `since` 按 runId 隔离 |
| 步骤状态只走事件不落盘 | 刷新页面进度回零 | `step_status` 同时写 `run.json` |
| 内网模型不支持 tools | 400 / 空回复 | JSON 协议降级 + 兼容性自检 |
| 代理环境变量导致回环请求失败 | 调本地 mock 报 SOCKS 错 | 回环地址强制 `trust_env=False` |

---

## 9. 怎么验证「真的变聪明了」

不要凭感觉。参考实现自带 23 项自动化断言（`python scripts/e2e/run_agent_e2e.py`），
跑的是一个**脚本化的假模型**（`scripts/e2e/mock_llm.py`），它严格按 `read_file → edit_file → run_tests → finish`
顺序行动。断言覆盖：

- 工具确实被调用（`read_file` / `edit_file` / `run_tests`）；
- 验证结果被记录且通过；
- JSON 协议降级后依然能改文件；
- `code` 步骤带上「工具调用 / 改动文件」指标；
- 步骤状态已持久化到 `run.json`；
- 沙箱能拦住 `../` 越界、`sudo rm -rf`、白名单外命令、以及「关闭命令执行」开关。

这套测试**不依赖真实模型**，所以在内网、离线、CI 里都能跑，是回归的安全网。

---

## 10. 一页速查

```
智能体 = 模型 × (工具 + 循环 + 验证 + 仓库感知 + 预算 + 事件流)
```

- 加**工具**，别加提示词说教；
- 让它**小步改**，每步**回读**；
- 每步**验证真的跑命令**；
- 喂**仓库地图**和 **AGENTS.md**；
- 给**步数 / 时长 / 上下文**三种预算；
- 把**每一步**推到事件流；
- 出不了决策就**降级**（JSON 协议 → 一次性 → 离线），永远别让流水线空转。

参考实现全在这几个文件里，直接读源码比读文档快：

- `server/tsd/repo_map.py` · 仓库地图 / 约定 / 命令探测
- `server/tsd/toolbox.py` · 9 个工具 + 沙箱
- `server/tsd/agent_loop.py` · 决策循环 + 双协议 + 验证 + 压缩
- `server/tsd/llm.py` · `chat()` / `chat_tools()`
- `src/components/project/AgentTab.tsx` · 轨迹时间线
- `scripts/e2e/run_agent_e2e.py` · 23 项回归断言
