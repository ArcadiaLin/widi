# Command

Command 是 runtime-service 的命令式组合能力。它描述请求来源、目标 agent、要调用的 runtime capability，以及结果如何作为 runtime event 分发给 TUI、stdout、RPC、extension 或其他 client。

Command 不是独立通信层。

`core/command` 保存 command 类型、built-in input command、input parser 和 command execution。`AgentOrchestrator` 仍是当前 multi-agent runtime object，负责 agent lifecycle、pending human request、client fanout 和 harness events。Command 不是 `AgentOrchestrator` 的子模块；它由 runtime-service 创建，并直接操作 orchestrator runtime。

## Commands

TUI、stdout、RPC、tool 和 extension 不应直接操作 `AgentHarness`。它们向 Command 提交命令式请求，例如 `agent.prompt`、`agent.steer`、`agent.nextTurn`、`agent.getModel`、`agent.setActiveTools` 或 `human.request`。Command 再直接通过 orchestrator runtime 操作 agent、human request、session、extension 和 diagnostics。

Tool commands 只使用 tool names，不暴露 Pi `AgentTool` closure。

- `agent.getTools` 返回 `{ toolNames, activeToolNames }` snapshot。
- `agent.setTools` 接收 `{ toolNames, activeToolNames? }`，由 orchestrator 通过 `ToolRegistry.resolve()` 重新解析并 wrap 成 Pi tools。
- `agent.setActiveTools` 也通过 registry 校验 active names；缺失、重复或不可见工具通过 tool diagnostics 报告。

这保证 create、resume 和 runtime tool mutation 走同一条 registry/wrap/diagnostics 路径。

## Command Runtime Module

当前 `CommandRequest` 承担 runtime operation bus；`agent.input`、built-in `inputInvoke` 和 extension `registerCommand()` MVP 已经收敛到 `Command` runtime module。

Command definition 是 human/client-facing executable capability，不是 UI widget，也不是 raw runtime service。Command 可以内部维护索引，但不把 registry 作为独立概念暴露；它的核心职责是执行命令式组合行为。

最小模型：

- `CommandDefinition`：稳定 id、label/description、可选 `inputInvoke`、以及执行方式。
- `CommandSource`：`core`、`extension`、`adapter` 等 provenance。
- `Command.define(definition, source)`：接收 core、extension 或 adapter command contribution。
- `Command.execute(command)`：执行 typed command，并通过 orchestrator runtime 产生 runtime effect。
- `Command.executeInput(agentId, text, options)`：在 client 开启 `inputInvoke` 时解析 raw text，resolve 到 built-in 或 extension command 后执行。
- `Command.listInputCommands(agentId)`：输出 client/debug 可消费的 visible command snapshot。

`inputInvoke` 只描述 UI-neutral 输入协议，例如 slash name、description 和 argument hint。它不描述 keybinding、selector、modal、toast、autocomplete UI 组件或 terminal 行为。Client 可以选择禁用 input invocation；禁用时 raw text 不经 Command 解析，按普通 prompt 或 client 私有逻辑处理。

内置 command 应通过 executable definition 映射到 typed command behavior。例如 `/compact foo` 可解析为 `agent.compact` command，再由 Command 通过 orchestrator runtime 执行。Extension command 没有固定 built-in kind 时，可以保留 handler；当前 MVP 仍使用 extension context，后续再决定是否需要更窄的 command context。

这会把 command 体系变成：

1. contribution：core、extension、adapter 提供 command definitions。
2. resolve：Command 处理 input name 冲突、built-in/reserved names、suffix、visibility、diagnostics，并产出 inspect facts。
3. execute：Command 调用 orchestrator runtime 执行 resolved command，发布 command lifecycle events 和 diagnostics。

### Difference From ToolRegistry

Command 与 ToolRegistry 不对称：

- `ToolDefinition` 是 LLM-facing capability definition，真正执行逻辑放在 `AgentTool`/tool runtime 对象中。
- `CommandDefinition` 是 human/client-facing executable capability，直接表达要运行的命令式组合行为。
- ToolRegistry 输出 final `AgentTool[]` 给每个 `AgentHarness`；不同 agent 可以有不同 tool set。
- Command 直接操作 orchestrator runtime；它不只是输出 runtime object，也不把执行逻辑转交给 harness。

两者都应支持 core / extension / adapter contribution、source provenance、conflict diagnostics 和 inspect facts。不同点是：tool 的最终调用者是模型，且 tool execution 属于 agent harness 的 tool runtime；command 的最终调用者是 human、client、extension 或 external transport，且 command execution 属于 runtime-service 的命令式组合层。

Command lifecycle 只有三种核心事件：

- `command_accepted`：orchestrator 已接收 command，并分配 `commandId`。
- `command_completed`：orchestrator 已成功执行，或已把 `steer`、`followUp`、`nextTurn` 交给 harness。
- `command_rejected`：command 未成功执行，并携带 diagnostic。

Command 不重新定义 `AgentHarness` queue 语义。`steer`、`followUp`、`nextTurn` 的真实排队、合并和消费继续由 harness 的 `queue_update`、`settled` 等 events 表达。UI 的“准备 steer / 队列中”应从 `agent_harness_event.queue_update` 渲染，而不是从 command layer 推断。

## Clients

Orchestrator client 是 TUI、stdout、RPC 或其他 adapter 的 runtime 注册对象。Client 可以接收 `OrchestratorEvent`，也可以实现 `requestHuman` 来处理 human-facing request。

`AgentOrchestrator` 创建或恢复 harness 后统一订阅 `AgentHarness.subscribe()`，并把 harness output 作为 `agent_harness_event` fan out 给 clients。UI/RPC adapter 不应直接订阅 harness。

对于 tool call，client 应优先消费 orchestrator 归一化的 `tool_lifecycle_event`。`agent_harness_event` 仍保留完整 Pi 原始事件，用于调试、日志和兼容尚未归一化的事件。

## Human Request

`human-request` 是 orchestrator 的结构化人机请求能力，可能由 tool、permission/hook、extension 或 system policy 发起。

v1 支持 `confirm`、`select`、`input` 和 `custom` request。默认交给第一个声明 `requestHuman` 的 client 处理，不做 broadcast 或 priority。

Human request 可以被取消。UI 中的 Esc、dismiss 或用户选择跳过，应调用 `cancelHumanRequest(requestId, reason?)`，产生 `human_request_cancelled` event，并让等待中的 `requestHuman()` 以 `human_request_cancelled` diagnostic 失败。取消不同于 timeout，也不同于 caller abort。

Tool execution context 只暴露窄能力 `context.human.request(...)`。Tool 等待响应后，自行决定是否把响应编码进 tool result；orchestrator 不写 session。

## Runtime Access

Tool、extension command、extension hook 和未来 agent collaboration tools 都需要调用 orchestrator runtime 能力，例如 spawn agent、prompt/wait/status、dispatch command、request human 或写 session-local extension state。

当前阶段不引入额外 facade。`AgentOrchestrator` 就是 multi-agent runtime object，Command 和未来 product tools 可以直接依赖它，就像 Pi coding-agent 的 interactive layer 直接组合 `AgentSession` 能力一样。

如果后续出现真实的稳定性压力，再从实际调用点抽取小 facade；不要预先为了隔离而复制 runtime service surface。

## Non-Responsibilities

- 不提供独立 message bus。
- 不提供第二套 agent queue。
- 不提供通用 command log persistence。
- 不决定 dynamic workflow；workflow 由 extension 通过 orchestrator command/helper 编排。

## TODO

Command 后续任务集中维护在 [WIDI 下一阶段 TODO](../TODO.md)。本文件只保留 command/client/human-request 的语义边界。
