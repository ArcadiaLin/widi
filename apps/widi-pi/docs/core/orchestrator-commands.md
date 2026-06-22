# Orchestrator Commands

Orchestrator command 是 `AgentOrchestrator` 的类型化操作入口。它描述请求来源、目标 agent、要调用的 harness/runtime capability，以及结果如何作为 orchestrator event 分发给 TUI、stdout、RPC、extension 或其他 client。

Command 不是独立通信层。

`core/orchestrator/*` 只保存 command、client、human-request 和 diagnostic 的类型定义。运行时调度、pending human request、client fanout 都由 `AgentOrchestrator` 直接拥有。

## Commands

TUI、stdout、RPC、tool 和 extension 不应直接操作 `AgentHarness`。它们向 orchestrator 提交 command，例如 `agent.prompt`、`agent.steer`、`agent.nextTurn`、`agent.getModel`、`agent.setActiveTools` 或 `human.request`。

Command lifecycle 只有三种核心事件：

- `command_accepted`：orchestrator 已接收 command，并分配 `commandId`。
- `command_completed`：orchestrator 已成功执行，或已把 `steer`、`followUp`、`nextTurn` 交给 harness。
- `command_rejected`：command 未成功执行，并携带 diagnostic。

Command 不重新定义 `AgentHarness` queue 语义。`steer`、`followUp`、`nextTurn` 的真实排队、合并和消费继续由 harness 的 `queue_update`、`settled` 等 events 表达。UI 的“准备 steer / 队列中”应从 `agent_harness_event.queue_update` 渲染，而不是从 command layer 推断。

## Clients

Orchestrator client 是 TUI、stdout、RPC 或其他 adapter 的 runtime 注册对象。Client 可以接收 `OrchestratorEvent`，也可以实现 `requestHuman` 来处理 human-facing request。

`AgentOrchestrator` 创建或恢复 harness 后统一订阅 `AgentHarness.subscribe()`，并把 harness output 作为 `agent_harness_event` fan out 给 clients。UI/RPC adapter 不应直接订阅 harness。

## Human Request

`human-request` 是 orchestrator 的结构化人机请求能力，可能由 tool、permission/hook、extension 或 system policy 发起。

v1 支持 `confirm`、`select`、`input` 和 `custom` request。默认交给第一个声明 `requestHuman` 的 client 处理，不做 broadcast 或 priority。

Human request 可以被取消。UI 中的 Esc、dismiss 或用户选择跳过，应调用 `cancelHumanRequest(requestId, reason?)`，产生 `human_request_cancelled` event，并让等待中的 `requestHuman()` 以 `human_request_cancelled` diagnostic 失败。取消不同于 timeout，也不同于 caller abort。

Tool execution context 只暴露窄能力 `context.human.request(...)`。Tool 等待响应后，自行决定是否把响应编码进 tool result；orchestrator 不写 session。

## Non-Responsibilities

- 不提供独立 message bus。
- 不提供第二套 agent queue。
- 不提供通用 command log persistence。
- 不决定 dynamic workflow；workflow 由 extension 通过 orchestrator command/helper 编排。

## TODO

- [x] 定义 `OperationSource`、`OrchestratorCommand`、`OrchestratorClient`、human-request 和 diagnostic 类型。
- [x] 在 `AgentOrchestrator` 内实现 command accepted/completed/rejected lifecycle。
- [x] 实现 client fanout、human request resolve/timeout/cancel 和 tool `context.human.request(...)`。
- [ ] 定义 extension hook 如何观察或拦截 command dispatch。
- [ ] 等待 Pi harness queue control 后，再暴露细粒度 queued input cancellation。
