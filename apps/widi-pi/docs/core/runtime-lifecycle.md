# Runtime Lifecycle

本文描述 `widi-pi` 预期的 runtime 模块、生命周期顺序和事件传递边界。它不是最终 API 规格，而是用来让 code、docs 和后续审核对齐：哪些模块先执行，哪些事件由谁发出，哪些状态可以持久化，哪些只能作为 runtime facts 观察。

## Runtime Modules

WIDI core runtime 由几类模块组合：

- Runtime composition：创建 `ExecutionEnv`、settings、auth、model registry、profile registry、resource loader、session manager、tool registry、extension loader 和 orchestrator。
- Dependency layer：解析 profile、resources、model/auth、extensions、tools 和 sessions。它们提供 facts、diagnostics 和 runtime dependencies，但不拥有 agent lifecycle。
- Orchestration layer：`AgentOrchestrator` 拥有 agent record、harness lifecycle、command input 执行、human request、client fanout、extension binding 和 diagnostics publish。
- Harness layer：Pi `AgentHarness` 负责单 agent turn、queue、session tree、model/tool execution 和 raw harness events。
- Extension layer：`ExtensionLoader` 激活 declaration，`ExtensionRunner` 保存当前 agent/profile 的 loaded scope，并通过 observers、interceptors、tool contributions、command contributions 和 session custom entry facade 插入 runtime。
- Adapter layer：TUI、RPC、stdout、CLI 或 product preset 注册 client、提交 input（`inputAgent`）或调用原子方法、处理 human request，并消费 orchestrator events。

## Runtime Composition Order

应用启动或测试创建 runtime 时，顺序应保持可解释：

1. 创建 execution/runtime boundary：cwd、agent dir、project config dir、session root、`ExecutionEnv`。
2. 加载 global/project settings，并应用 project trust gate 与 runtime overrides。
3. 创建 config/auth/model/profile/resource/session/tool/extension 相关 registry 或 loader。
4. 解析 default profile、default model 和 default thinking level，收集 diagnostics。
5. discovery/load extension catalog。当前实现已支持 file/module discovery、trust gate、activation diagnostics 和 reload 所需 facts，但稳定第三方 extension API 仍未完成。
6. 创建 `AgentOrchestrator`，注入 dependency layer 和 defaults。command 解析是 orchestrator 创建选项（可关闭），不是独立 runtime。
7. 返回 runtime services、orchestrator 和 startup diagnostics。

Runtime composition 不创建产品 UI，也不决定 `/team`、`/flow`、`/goal` 等交互模式。这些属于 adapter、preset 或 extension。

## Agent Create And Resume

创建或恢复 agent 时，orchestrator 是唯一 lifecycle owner：

1. 解析目标 profile，生成或恢复 `AgentId`、session metadata、model 和 thinking level。
2. 创建 agent record，初始状态为 `creating`，并挂载 profile/source/session/model facts。
3. 解析 resources，记录 resource diagnostics。
4. 为当前 agent/profile 创建 extension runner：`ExtensionLoader.loadForAgent()` 激活 profile 声明的 extensions，并收集 missing/activation diagnostics。
5. 基于 global `ToolRegistry` clone scoped registry，并 replay 当前 extension runner 的 tool definitions/patches。
6. `ToolRegistry.resolve()` 输出 visible tools、active tools 和 diagnostics。
7. 将 resolved `ToolDefinition` wrap 成 Pi `AgentTool[]`，注入 human request host 和 extension tool context。
8. 创建或恢复 Pi `AgentHarness`。
9. 绑定 extension core context、command context 和 session custom entry facade。
10. 注册 extension interceptors 到 harness hooks：`before_agent_start`、`context`、`tool_call`、`tool_result`。
11. 订阅 harness events，由 orchestrator 统一 fan out。
12. agent record 进入可运行状态；创建失败但可恢复的 subagent 可保留为 `unavailable` 并携带 diagnostics。

任何 adapter、extension 或 tool 都不应直接创建 sibling/child harness。跨 agent lifecycle 必须回到 orchestrator。

## Command Input Lifecycle

Command input 是 orchestrator 自身的 human input 能力，唯一入口是 `inputAgent(agentId, text)`（迁移中，目标语义与裁决全文见 [Command Experiment](./command-experiment.md)）：

1. 两阶段解析：整行 line command 按已注册 `trigger` + 固定 `<trigger><name>:<argument>` 模板匹配；未命中则做 inline command 扫描；均未命中按普通 prompt 走，不发 command 事件。
2. 命中 registry → emit `command_detected`（附 commandId、trigger、name、source、placement）。
3. `_commandGateway` 检查 profile `commands` policy、`scope`、agent status；失败 → emit `command_rejected` + diagnostic，保证无副作用。
4. 必填参数缺失 → `argumentsCompletion` human request；无 client/超时/拒绝 → `command_rejected`，不降级为普通 prompt。
5. emit `command_accepted`，执行 built-in binding、extension handler 或 inline expand。
6. 成功 → emit `command_completed`（只带摘要，完整 result 由 `InputResult` 返回值承载）；执行中抛错 → 转 diagnostic，emit `command_failed`。

`command_rejected`（执行前拦下，无副作用）与 `command_failed`（执行中失败，可能有部分副作用）语义分离。extension command 与 built-in 走同一条事件轨道。

Command input 不拥有 client fanout，不定义 UI，不持久化 command log，也不重新定义 Pi harness queue。`steer`、`followUp`、`nextTurn` 的真实排队和消费继续由 Pi harness `queue_update`、`settled` 等 events 表达。programmatic consumer 不使用 command input——直接调用 orchestrator 原子方法。

## Event Layers

WIDI 不重新定义 Pi harness event。它把 Pi event 分成几层消费：

```text
AgentHarness Scope
  own events + agent loop events
    -> AgentOrchestrator._handleAgentHarnessEvent
      -> status update
      -> orchestrator `agent_harness_event`
      -> extension observer: agent_harness_event
      -> optional WIDI tool_lifecycle_event
      -> extension observer: tool_lifecycle_event
```

`agent_harness_event` 保留 Pi 原始事件，用于日志、inspect、RPC passthrough 和兼容尚未归一化的事件。`tool_lifecycle_event` 是 WIDI 归一化 facts，只表达 tool call/run 事实，不创建 preview/state，不参与 session persistence。

## AgentHarness Scope

AgentHarness 自己拥有 run phase、queue、session write flush 和 harness hook。当前可观察事件可以分为：

```text
Queue
  steer()/followUp()/nextTurn()
    -> queue_update

Abort
  abort()
    -> abort
    -> queue_update?       // 当队列被清理时

Run settlement
  agent_end
    -> flushPendingSessionWrites()
    -> phase = idle
    -> settled

Session save point
  turn_end
    -> emit turn_end
    -> flushPendingSessionWrites()
    -> save_point

Runtime mutation
  setModel()/restore
    -> model_update
  setThinkingLevel()
    -> thinking_level_update
  setTools()/restore
    -> tools_update
  setResources()
    -> resources_update
```

这些事件表达 harness 层事实。WIDI 可以观察、记录和转发它们，但不应把它们改写成第二套 queue 或第二套 session state。

当前 WIDI 已桥接为 extension interceptor 的 harness hooks：

```text
before_agent_start
  input: prompt, images, systemPrompt, resources
  result: optional extra messages, optional systemPrompt override
  meaning: run 前最后一次注入/改写入口

context
  input: messages
  result: replacement messages
  meaning: provider 请求前的上下文改写入口

tool_call
  input: toolCallId, toolName, input
  result: optional block + reason
  meaning: tool 执行前的拦截入口

tool_result
  input: toolCallId, toolName, input, content, details, isError
  result: optional content/details/isError/terminate patch
  meaning: tool result 进入 session 前的改写入口
```

Pi 还暴露 provider/session/model/resources/tools 等更多 own events。WIDI 不急于全部稳定成 extension API；未来只在需要时逐步接入。

## Agent Loop Scope

Pi `runAgentLoop` 的核心周期是：

```text
agent_start
  -> turn_start
    -> user message_start
    -> user message_end
    -> assistant message_start
    -> assistant message_update*
    -> assistant message_end
    -> tool execution batch?
    -> turn_end
    -> next turn?
  -> agent_end
```

更细的循环：

```text
Initial prompt
  agent_start
    -> turn_start
      -> message_start(user)
      -> message_end(user)

Assistant streaming
  message_start(assistant partial)
    -> message_update(text_start/text_delta/text_end)
    -> message_update(thinking_start/thinking_delta/thinking_end)
    -> message_update(toolcall_start/toolcall_delta/toolcall_end)
    -> message_end(assistant final)

Tool calls
  tool_execution_start*
    -> tool_execution_update*
    -> tool_execution_end*
    -> message_start(toolResult)
    -> message_end(toolResult)

Turn boundary
  turn_end(assistant message, toolResults)
    -> prepareNextTurn?
    -> follow-up/steer messages?
    -> next turn_start?

Run boundary
  agent_end(messages)
```

Meaning:

- `agent_start` / `agent_end`: one full harness run, possibly including multiple turns caused by tool results or follow-up messages.
- `turn_start` / `turn_end`: one assistant response plus its tool calls/results.
- `message_start` / `message_end`: persisted message boundary. `message_end` is where harness appends message to session.
- `message_update`: streaming assistant deltas. Only assistant messages emit updates.
- `tool_execution_*`: actual tool runtime execution, independent from assistant streaming deltas.

## Tool Lifecycle Facts

WIDI derives stable tool facts from two Pi event families:

```text
Assistant message stream
  message_update(toolcall_start)
    -> tool_lifecycle_event(tool_call_created)

  message_update(toolcall_delta)
    -> tool_lifecycle_event(arguments_delta)

  message_update(toolcall_end)
    -> tool_lifecycle_event(arguments_ready)

Tool execution
  tool_execution_start
    -> tool_lifecycle_event(execution_started)

  tool_execution_update
    -> tool_lifecycle_event(execution_update)

  tool_execution_end
    -> tool_lifecycle_event(execution_result)
```

Current WIDI facts:

- `tool_call_created`
- `arguments_delta`
- `arguments_ready`
- `execution_started`
- `execution_update`
- `execution_result`

`tool_call_created`、`arguments_delta`、`arguments_ready` 来自 Pi assistant message streaming events。Orchestrator 只维护短生命周期的 `contentIndex -> toolCall` 映射来补全 streaming facts；该映射不是 tool state，会在 `toolcall_end`、`message_end`、`turn_end` 或 `agent_end` 后清理。

`execution_started`、`execution_update`、`execution_result` 来自 Pi tool execution events。UI、RPC 和 extension 可以基于这些 facts、tool arguments、result content/details 派生展示状态。

## Orchestrator Fanout Scope

每个 raw harness event 进入 orchestrator 后，当前顺序是：

```text
AgentHarnessEvent
  -> update agent record status
  -> emit OrchestratorEvent.agent_harness_event
       -> subscribers
       -> clients
  -> ExtensionRunner.emitObserved(agent_harness_event)
       -> extension diagnostics?
  -> derive ToolLifecycleEvent?
       -> emit OrchestratorEvent.tool_lifecycle_event
            -> subscribers
            -> clients
       -> ExtensionRunner.emitObserved(tool_lifecycle_event)
            -> extension diagnostics?
```

Status update rule:

```text
agent_start | turn_start
  -> record.status = running

agent_end | turn_end | settled
  -> record.status = ready/idle according to harness/record state
     // `ready` 只在创建瞬间出现且无消费者；
     // M2 收敛为 creating/running/idle/unavailable/disposed

dispose
  -> unsubscribe harness events/interceptors
  -> invalidate extension runner
  -> cancel pending human requests
  -> record.status = disposed
```

Observer failures do not stop the raw harness event from existing. They become extension diagnostics and return to the orchestrator diagnostic path.

## Extension Execution Points

当前实现已经落地的 extension 插入点：

- Activation：`ExtensionLoader.loadForAgent()` 执行 extension factory，收集 tool/command/observer/interceptor contributions。
- Tool contribution：orchestrator resolve tools 时，将 extension contributions replay 到 scoped `ToolRegistry` overlay。
- Interceptor：orchestrator 将 harness `before_agent_start`、`context`、`tool_call`、`tool_result` 桥接给 runner interceptors。
- Observer：orchestrator 将 `agent_harness_event` 和 `tool_lifecycle_event` 送给 runner observers。
- Command contribution：extension `registerCommand()` 提供 name/trigger/description/argumentHint 与 line handler，由 orchestrator `inputAgent` 统一解析、门控并执行；inline `expand` 后续接入（契约见 [Command Experiment](./command-experiment.md)）。
- Session custom entry：extension context 暴露 namespaced `appendEntry()` / `findEntries()`，用于当前 session branch 上的小型 append-only state。
- Runtime actions：extension context 可通过受控 actions 调用 human request、get/set tools 等具名能力（全量 `dispatch` 将随 M1 移除，scope 收敛为 own-agent 属 M2）。

未来仍需定义的 execution points 包括 provider/resource contribution、更多 session/provider hooks、extension-owned storage、product presentation 和稳定第三方 extension API。

## Human Request Lifecycle

`human-request` 是 orchestrator runtime 能力，不属于 Pi session body。

1. caller 通过 orchestrator 或 extension/tool facade 发起 request，携带 source。command input 的 `argumentsCompletion` 补全是 core 内第一个消费场景。
2. orchestrator 创建 request envelope，emit `human_request_pending`。
3. 第一个支持 `requestHuman` 的 client 处理请求（first-client-wins 是现状而非设计承诺；多 client 路由语义在 M3 出现真实场景时定义）。
4. 成功时 emit `human_request_resolved` 并返回 response。
5. timeout 时 emit `human_request_timeout` 并让等待方失败。
6. cancellation 时 emit `human_request_cancelled` 并让等待方失败。

只有当 human request 作为 tool execution 的一部分被编码进 tool result 时，它才自然进入 Pi session tree。orchestrator 不额外写 session。

## Persistence Boundary

Pi session tree 保存单 agent harness 运行产物：messages、tool calls/results、model/thinking changes 和 branch。

以下内容不进入 session body：

- agent lifecycle/status。
- command/client event log。
- extension runner instance。
- extension-owned database。
- tool lifecycle preview/state。
- runtime objects、API keys、tool closures。

可恢复的小型 references 可以进入 session metadata，例如 profile reference。WIDI-owned tool 的可恢复上下文应优先进入 Pi tool call arguments、tool result `content` 和 typed `details`。Extension session custom entry 只用于与当前 session branch 强相关的小型 extension state。

## Diagnostics Flow

所有模块应将问题表达为 diagnostics，而不是只抛普通错误：

- dependency layer 产生 profile/resource/model/auth/extension/tool diagnostics。
- orchestrator 为 command failure、client failure、human request failure、extension action failure 补充 source、agentId、profileId、commandId 等上下文。
- diagnostics 通过 orchestrator publish/fanout 进入 client/debug surface。
- unavailable agent 应保留 diagnostics，便于上层 extension/preset 恢复其他 agent。

Diagnostics 是 runtime facts，不等同于 session history。是否在 UI/RPC 中持久展示由 adapter/preset 决定。

## Non-Goals

- 不定义最终 UI/RPC 呈现。
- 不把 extension runtime state 写入 core session。
- 不让 extension 绕过 orchestrator 持有 raw harness 或 agents map（当前 `agents`/`getAgentHarness` 仍公开，机制化收紧在 M2——在此之前这是纪律而非强制）。
- 不让 ToolRegistry 负责 extension activation。
- 不把 command input 当作 programmatic API——代码消费者使用 orchestrator 原子方法。
- 不维护第二套 agent queue 或 tool preview state。

## TODO

Runtime lifecycle 后续任务按 milestone 维护在 [Milestones](../TODO.md) 与 [Backlog](../BACKLOG.md)。本文只记录模块顺序、事件传递和持久化边界。
