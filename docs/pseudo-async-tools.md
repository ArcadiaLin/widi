# 伪异步 tool 结果返回（个人笔记）

这份是给自己看的设计备忘，记录一下 widi agent-core 里"伪异步 tool 结果"的想法和大致落地顺序。不是给别人看的规范，写得随意点。

## 要解决的问题

现在 tool 是纯同步的：`execute` 返回 `Promise<AgentToolResult>`，agent loop 会 await 完整一批工具跑完、写进 tool_result 之后才发下一次模型请求（契约在 `pi/packages/agent/src/types.ts:382`）。

后果：

- 一个注定长阻塞的 bash 命令（且没传 timeout）会把整个 agent 挂死，只能人工中断。widi 和 pi coding-agent 的 bash 工具都**没有** `run_in_background`，默认也没超时。
- 将来做 multi-agent，main agent spawn 一个 subagent 后如果同步等，就一直卡着，没法一边等一边干别的。

想要的效果：tool 启动后先返回个"已启动 + handle"，模型继续往下走；真正结果出来之后，再单独送回来。

## 为什么不能做"真正的延迟 tool_result"

关键约束：LLM 消息协议（Anthropic / OpenAI 都一样）要求一条 assistant 消息里的每个 `tool_use`，必须在**紧接着的下一条 user 消息**里就有配对的 `tool_result`，而且同一批 tool_use 要一次性全部结算。

所以：

- tool_call 和它的 tool_result 之间**不能**插别的消息 —— 那是"未结算的 tool_use"，API 直接拒绝。
- 不能"tool_result 隔一段时间才来"。一旦写入就是终值，没有"以后补全"这回事。
- pi 的 loop 结构上也堵死了这条路：它 await 整批、按 source order 立即发 tool-result。正常 execute() 路径根本造不出"结果隔很远"的 transcript。

结论：**别去设计"异步 / 延迟 tool result"这个抽象**。它和协议冲突，pi 也没有，改 pi 还违反 vendor 规则。

## 成立的做法：t0 立即结算 + t1 新消息

把它拆成两个语义不同的事件：

- **t0（立即，终态）**：tool_result 内容是"已启动，handle = `job://X`，结果稍后以新消息送达"。这条**就是** tool_use X 的最终结果，不可修改，不是占位符。
- **t1（之后）**：一条**全新的消息**，"job X 完成，结果如下……"。它不是第二个 tool_result，不引用 tool_use id，所以不违反配对约束。

这就是 Claude Code 后台任务的模型。pi 也已经备好落点：

- 排水点：`getSteeringMessages`（每个 turn 工具跑完后）、`getFollowUpMessages`（agent 要停下时），harness 侧是 `steer()` / `followUp()`；idle 时用 `nextTurn()` 排队（`steer`/`followUp` 在 idle 会抛 `invalid_state`，见 `agent-harness.ts:658,664`）。
- `CustomAgentMessages` 声明合并 + `convertToLlm`（`types.ts:169,305`）：可以定义一等的 `background_job_result` 消息类型，持久化和 UI 都有明确身份，不用伪装成用户文本。

## 不要做成"所有工具、固定 20s、无差别"

自己提过统一给每个 tool 套 20s 自动返回。想清楚后：这个默认会在最不该触发的地方触发。

- **副作用工具会被重复执行**：`bash`/`edit`/`write` 到点返回"还在跑"，模型看到未完成会重试或做补偿，于是同一个有副作用的操作并发跑两份。
- **只在原地才有意义的结果会被打断**：`read` 一个文件是为了紧接着 `edit`，推迟成几轮后的消息就断了。
- **对长任务纯噪音**：明知要跑 90s 的 build，每次先收"还在跑"、被迫决策、再收完成，多花一整轮往返，上下文全是垃圾。
- **20s 阈值本身任意**：真正该触发的信号不是墙钟，而是"这工具本就是长跑的"或"模型显式要 background"。墙钟超时应该是**兜底安全网**，不是主触发器。

所以改成 **opt-in**：默认全部纯同步不变，只有明确标记的工具才走伪异步。

## 目标形状：opt-in 能力 + 共享 job 机制

三层，契约层只加一个声明：

1. **tool definition 层**（`apps/widi-pi/src/core/tools/types.ts` 的 `ToolDefinition`）
   加 `backgroundable?: boolean` + 可选 `backgroundTimeoutMs`。默认 `false`。read/edit/write/grep 全不动，只有 `bash`、`spawn_agent` 这类标记。

2. **adapter 层**（`tool-registry.ts` 的 `createAgentToolFromResolvedTool`，line 440 附近）
   这里本来就把 WIDI `ToolExecute` 包成 Pi `AgentTool.execute`，是插入 race 的唯一正确接缝。
   - `backgroundable` 的工具：execute 与 deadline 竞速；到点仍没 resolve → 登记进 **job 表**、t0 返回 handle；原 promise 继续后台 await。
   - 非 `backgroundable`：照旧直接 await（bash 仍可用自己的显式 `timeout` 参数）。

3. **orchestrator 层**
   结果路由器 + phase-aware 注入。监听 job resolve → 按父 agent 当前 phase 分发：运行中 → `steer`/`followUp`；已 idle → `nextTurn` 或起新 run。发一条带原 `toolCallId` 关联的 `background_job_result` custom message。

这套 job 抽象把三件事收敛成同一个机制，只写一次：
- bash 长任务（`run_in_background` 语义）
- subagent 后台执行（`spawn_agent(mode:background)`）
- 任何将来标了 `backgroundable` 的工具

## 必须钉死的细节

- **关联性**：t1 消息必须带原 `toolCallId` 和 handle，否则模型不知道这条完成对应哪次调用。t0 的 tool_result 文本要显式写 handle + "结果稍后以消息送达"。
- **job 生命周期 / abort**：t0 一返回，原 tool_use 就结算了，它的 signal 不再是这份后台工作的主人。后台工作的 abort / dispose 交给 job 表（父 agent dispose → 级联杀 job），别让 promise 悬空。
- **父 agent 已 dispose 的竞态**：t1 到达时父已不在 → 丢弃 + 记 diagnostic，结果落 session 存档备查。
- **完成顺序非确定**：多个 job 按完成先后注入，不保证跟启动顺序一致。prompt 要说明。
- **并行批次**：同一条 assistant 消息里，backgroundable 的到点各自 t0 结算，非 background 的正常 await，批次在最慢的那个结算时收口。不冲突。

## 落地顺序

分阶段，每步都能独立验证、且不碰 pi vendor 代码。

**阶段 0 — 止血（可选，先不动架构）**
给 widi 的 bash 工具加一个默认超时兜底，或在工具描述里强提示模型对可能长跑的命令传 timeout。立刻能缓解挂死，跟后面不冲突。

**阶段 1 — 契约与 custom message 类型**
- `ToolDefinition` 加 `backgroundable` / `backgroundTimeoutMs` 字段（先只加字段，不接线）。
- 定义 `background_job_result` 的 `CustomAgentMessages` 类型 + `convertToLlm` 处理 + 持久化 + 最简 UI 渲染。
- 单独验证这条 custom message 能进上下文、能 replay。

**阶段 2 — job 表 + adapter race**
- 在 agent-core 加最小 job 表（登记、查询、abort、resolve 回调）。
- `createAgentToolFromResolvedTool` 里对 backgroundable 工具接 race → 到点登记 job、t0 返回 handle。
- 先拿一个安全的假工具（sleep N 秒）验证 t0 立即返回、后台仍在跑。

**阶段 3 — 结果路由器（唯一有真复杂度的部分）**
- orchestrator 监听 job resolve，按父 phase 分发到 steer/followUp/nextTurn。
- 处理 dispose 竞态、乱序完成。
- 用假工具跑通 t0 → 一段时间 → t1 注入 → 模型接着推理。

**阶段 4 — 接真实来源**
- 先接 `bash(background:true)`：长命令的 `run_in_background`。
- 再接 `spawn_agent(mode:background)`：subagent 后台执行，复用同一 job 机制。
- 配一个 `wait_for_jobs(ids, timeout)` 工具做显式收敛点（带超时，超时返回"仍在运行 + 当前状态"，不永久挂起）。

**阶段 5 — 门控与观测**
- profile 能力门控：哪些 profile 能用 background / spawn，深度上限。
- diagnostics、TUI 里 job / subagent 的可见性（agent-strip 已经能显示多 agent，基本白拿）。

## 备注 / 待想清楚的坑

- 多个 agent 共享同一 cwd 的文件写冲突：`file-mutation-queue` 是 per-agent 的，跨 agent 没仲裁。第一阶段先用工具描述约束职责边界，worktree 隔离留后面。
- background job 的输出增量要不要中途回灌（不只终态）？倾向：进展走 `onUpdate` 更新 UI，模型上下文只在关键节点补 t1，别刷屏。
- `backgroundTimeoutMs` 的默认值再定，20s 只是随口说的，不当主触发器。
