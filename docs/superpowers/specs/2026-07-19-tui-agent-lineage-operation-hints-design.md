# TUI Agent Lineage 与操作提示栏设计

日期：2026-07-19
状态：已确认并实现

## 背景与目标

同一 profile 创建的多个 runtime agent 当前都使用 profile label 展示。例如源
agent 与它的 fork 都显示为 `WIDI Dev`，用户看不到两者的唯一身份或 fork 关系。
Agent selector 虽然可以切换，但目标不可辨识，表现得像“无法切换”。

TUI 现有 Footer 只展示 cwd、thinking level 与少量固定按键。Completion menu
又维护自己的操作说明，其他状态则没有统一的下一步提示。目标是：

- 在 agent strip 与 selector 中展示可辨识的 agent identity 和 fork lineage。
- 在 Editor 下方、AgentStrip 上方增加一行按上下文触发的操作提示。
- Autocomplete 或 completion menu 展开时继续参与正常布局，把提示栏和 agent
  strip 向下推，不覆盖它们。
- 每个命令复用自己的说明与参数信息生成针对性的提示。
- 增加 `/dispose`，关闭当前 runtime agent 但不删除持久 session，并自动选择合理
  的后续目标。
- 不修改 `pi/*`，不改变 session JSONL 格式或 fork 持久化语义。

## 布局

底部组件顺序固定为：

```text
CompletionMenu（需要时，位于 Editor 上方）
Editor
Footer
OperationHint
AgentStrip
```

Pi Editor 自带的 autocomplete 是 Editor 自身高度的一部分；`CompletionMenu` 是
正常组件流的一部分。因此二者展开时都只会增加上方内容高度，下面的 Footer、
OperationHint 与 AgentStrip 被自然下推，不使用 overlay。

`OperationHint` 最多渲染一行。没有有价值且可执行的提示时返回空数组，避免常驻
噪声。

## Agent identity 与 lineage

### TUI 状态

`AgentDisplayFacts` 增加可选的 `forkedFromAgentId`。收到
`agent_session_forked` 时，event 中：

- `agentId` 是源 agent。
- `forkedSessionId` 是即将 resume 的 fork session id，也是 fork runtime agent id。

Event projector 在目标 projection 上记录 `forkedFromAgentId = event.agentId`。
随后 `agent_resumed`、snapshot sync 和 hydration 只补充目标的 model、status 与
历史，不覆盖 lineage。

对于重新打开 TUI 后单独 resume 的 fork，若没有本次 runtime 的 fork event，则用
`snapshot.sessionMetadata.parentSessionPath` 与其他 runtime agent 的
`sessionMetadata.path` 做回退匹配。若父 session 未在当前 runtime 中，仍显示目标
短 ID，但 lineage 降级为 `fork`，不解析或猜测文件名。

### 展示规则

只有一个 visible agent 时继续使用简洁 label。存在多个 visible agent 时：

- 普通 agent：`WIDI Dev [widi-dev]`
- fork：`WIDI Dev [fork from widi-dev · 547da47e]`
- 嵌套 fork：`WIDI Dev [fork from 547da47e · a1b2c3d4]`
- 父 agent 不在 runtime：`WIDI Dev [fork · 547da47e]`

Identity token 对短、可读的 agent id 使用完整值；对 UUID 等长 id 使用末尾 8 位，
因为 UUIDv7 前缀主要来自时间，同一批 agent 的尾部更适合消歧。

Fork source 优先显示其 session name；没有 session name 时显示 source identity
token。目标自身的短 ID 始终保留，以区分同一 source 产生的多个 fork。

AgentStrip 与 AgentSelector 使用同一个 formatter，避免两处规则漂移。
AgentSelector description 额外显示完整 agent id，便于诊断。Header 保持简洁，不把
lineage 长文本放入主标题。

## OperationHint

### 输入与边界

提示内容由一个纯 `resolveOperationHint()` 根据只读 UI snapshot 计算：

- `TuiApplicationState`
- 当前 editor 文本
- Editor autocomplete 是否可见
- CompletionMenu 当前 request 的 title、description 与 usage
- CommandEngine 中匹配到的 command definition
- 已配置的 keybindings

`OperationHintView` 只负责格式化和宽度裁剪，不自行改变状态。Editor 与
CompletionMenu 通过小型只读 getter 暴露所需事实，不让 view 读取它们的内部列表。

### 优先级

同一时刻只显示最高优先级的一类提示：

1. **Completion menu / agent selector**
   - 命令候选：`/model · Set the current agent model · ↑/↓ choose · Enter apply · Esc cancel`
   - Agent selector：`Select agent · ↑/↓ choose · Enter switch · Esc cancel`
2. **Editor autocomplete**
   - 精确命令：使用该 command 的 `description`、`argumentHint` 与 completion 动作。
   - 仅有命令前缀：`Commands · ↑/↓ navigate · Tab complete · Enter submit · Esc close`
   - 若 selection confirm 与 input submit 配置为不同按键，分别显示 `complete`
     与 `submit`，不把仅补全的按键误写为提交。
3. **Pending human request**
   - 后台 request 尚未打开时提示 `app.request.open`。
   - Human request menu 已取得焦点时不再渲染独立 OperationHint，由 menu 自己按
     request 类型显示 submit/select/dismiss 与多 request 导航。
4. **Running agent**
   - `Esc abort · Ctrl+S steer · Enter queue follow-up`
5. **Multiple visible agents**
   - `← switch agent · /dispose close current`
   - `app.agents.open` 只在 editor 为空时可执行；存在 draft 时不显示该按键动作。
6. **Pending agent intent**
   - `Enter starts session · /model or /thinking configures before first prompt`

提示只引用当前确实可执行的 action。例如没有 active agent 时不显示 `/dispose`；
只有一个 visible agent 时不主动鼓励关闭或切换；completion menu 打开时不同时显示
运行态或多 agent 提示。

### 命令专属提示

`LineCommand.description` 和 `argumentHint` 是命令提示的默认事实，不再为每个命令
复制一份 help 字符串。`CompletionMenuRequest` 增加可选的 command context，
`openCommandCompletionMenu()` 将匹配到的 command definition 传入。若某个命令未来
需要不同于 description 的交互文案，可以增加可选 override，但本次不提前扩展。

CompletionMenu 当前自己渲染的底部操作 hint 移交给 OperationHint，避免同一组
按键重复出现两次。

## `/dispose`

`/dispose` 是 application-owned、`active` policy 的 line command。它调用现有
`AgentOrchestrator.disposeAgent()`，只释放 harness、extension 与 runtime 状态：

- 不删除 JSONL session。
- session 仍可通过 `/resume` 恢复。
- 若 core dispose 失败，保留当前 active agent，并按现有 command failure 路径显示
  错误。

Dispose 成功后的目标选择顺序：

1. 若当前 agent 是 fork，且 source 仍是具有 harness 的 idle/running runtime
   agent，切回 source。
2. 否则切换到第一个同样可用的现有 runtime agent；不选择刚 disposed、
   unavailable、creating 或已失去 harness 的 projection。
3. 若没有 agent，建立 default pending intent；不调用 `spawnAgent()`，保持 TUI
   lazy session 创建语义。

Disposed projection 保留在 application state 中供 lineage 和诊断引用，但
AgentStrip 与 AgentSelector 继续过滤 `disposed` 状态。

## 数据流

### Fork

```text
/fork
  → AgentOrchestrator.forkAgentSessionFromAgent(source)
  → agent_session_forked(source, forkedSessionId)
  → EventProjector records target.forkedFromAgentId
  → agent_resumed(target)
  → snapshot sync + history hydration
  → activate target
  → strip/selector render lineage label
```

### Contextual hint

```text
TUI render
  → OperationHint snapshots menu/editor/application state
  → resolveOperationHint applies fixed priority rules
  → one hint line or no line
```

### Dispose

```text
/dispose
  → application host calls orchestrator.disposeAgent(active)
  → disposed status projected
  → choose source / remaining agent / default pending
  → focus editor and render
```

## 错误与边界情况

- 多个 fork 来自同一 source 时，用目标短 ID 消歧。
- Source 已 disposed 时仍可从保留 projection 得到 source identity；不可切回它。
- Source unavailable 或已失去 harness 时保留 lineage 展示，但导航跳过它。
- Source 不在当前 runtime 时显示降级 lineage，不从路径字符串猜 id。
- 窄终端对整行提示做宽度裁剪，不拆成多行挤压 transcript。
- Completion candidates 为空时仍显示命令 usage 与取消操作，不显示不可执行的
  “apply”。
- `/dispose` 关闭 running agent 时沿用 core 的 dispose/abort 清理语义。
- 最后一个 agent 被关闭后只回到 pending view，不产生空 session file。

## 测试策略

1. Event projector：
   - fork event 把 source id 写入目标 projection。
   - 后续 resumed/snapshot 事件不丢失 lineage。
2. Identity formatter 与 views：
   - 单 agent 保持简洁 label。
   - 重复 profile label 的 source/fork 显示不同 identity。
   - 同源多个 fork 通过目标短 ID 区分。
   - AgentStrip 与 AgentSelector 使用相同 label。
3. OperationHint resolver：
   - completion、editor autocomplete、human request、running、多 agent、pending 按
     固定优先级选择。
   - 精确命令包含自己的 description/usage。
   - Human request 已聚焦时不重复 menu 自己的操作说明。
   - 自定义 confirm/submit 键位与 editor draft 条件下只显示真实可执行的动作。
   - 无可执行提示时不渲染。
4. `/dispose` application integration：
   - fork dispose 后切回 source。
   - 普通 agent dispose 后切到剩余 agent。
   - 最后一个 agent dispose 后进入 pending，且不调用 `spawnAgent()`。
   - dispose 失败不切换。
5. 回归验证：
   - `npm --workspace apps/widi-pi run test`
   - `npm run check`
   - `git diff --check`

## 范围外

- 删除 session 文件或实现永久删除命令。
- 修改 Pi fork 的 `before` / `at` 语义。
- 在 JSONL metadata 中新增 lineage 字段。
- 实现任意规则或模型驱动的提示推荐；提示选择保持确定、可测试。
- 为 agent selector 增加鼠标交互或独立详情页。
