# Runtime Modules

本文档记录 `apps/widi-pi/src/core/` 下直属 runtime modules 的组织规则。它不定义最终 API 字段；它约束代码该放在哪里，以及哪些类型可以成为共享协议。

## 核心裁决

Core 目录不是按“类型/实现”二分，而是按 runtime 责任归位。

- 能独立拥有一段运行时语义的模块，应把自己的类型、状态和 helper 放在同一个文件里。
- 多个 core 模块都要消费的协议事实，才进入 `core/types.ts`。
- 不为减小某个文件而创建 `*-types.ts` bucket。类型随所有者走；没有清晰所有者的共享事实才是 `core/types.ts` 的职责。
- `AgentOrchestrator` 可以持有 collaborator，但 collaborator 不应 import `AgentOrchestrator` 类，也不应触达 `agents` map、clients map 或 raw harness。

这条规则来自 2026-07-09 的 orchestrator 拆分复盘：把一批 orchestrator 类型暴力迁到 `orchestrator-types.ts` 只移动了行数，没有形成模块边界。当前已改为 `core/types.ts` + owner-local types。

## 共享协议层

`src/core/types.ts` 只放跨 core 模块共享、且没有更具体所有者的协议事实：

- `RuntimeModel`
- `AgentId`
- `AgentLifecycleStatus`
- `AgentToolsSnapshot`
- `OrchestratorEvent`
- `OrchestratorEventListener`

它不放：

- orchestrator constructor config。
- `AgentRecord` / `AgentRecordSnapshot` 这类 owner-local runtime shape；它们归 `agent-record.ts`。
- spawn/resume/reload result DTO。
- model/thinking 解析 helper。
- 某个 runtime collaborator 的私有状态。

消费者仍可从 `agent-orchestrator.ts` import 公开 orchestrator 类型；`core/types.ts` 的存在是为了让 `command.ts`、`session-manager.ts`、`extension/types.ts` 等 core peer 不必 import orchestrator implementation module。

## Runtime Collaborators

### `agent-record.ts`

`agent-record` 拥有 agent record 的 shape、创建 helper 和 public snapshot 生成。它可以引用 profile、session、extension 与 diagnostic 的事实类型，但不 import `AgentOrchestrator`。

它不拥有 `agents` map、status 写入策略、harness lifecycle、extension runner lifecycle 或 event fanout；这些仍由 `agent-orchestrator.ts` 协调。

### `agent-orchestrator.ts`

`AgentOrchestrator` 是 runtime coordinator。它持有 `agents` map，拥有 harness lifecycle、status 写入、event fanout、extension binding、command input 执行路径和 dependency layer 的组合顺序。

它可以委托给 collaborator，但仍负责把 collaborator 事件接回统一 orchestrator event/diagnostic path。

### `harness-event-facts.ts`

`harness-event-facts` 拥有 Pi harness event 到 WIDI facts 的转换逻辑。它持有 streaming tool-call refs，用 `contentIndex` 把 `toolcall_start/delta/end` 归并成稳定的 `ToolLifecycleEvent` facts。

它不拥有 harness 订阅、orchestrator event fanout、agent status 写入或 extension observer 通知；这些仍由 `agent-orchestrator.ts` 负责。

### `human-request.ts`

`human-request` 是一个真正的 runtime module，不再只是类型文件。

它拥有：

- request envelope 与 `human-request-N` id 分配。
- pending request map。
- timeout、abort、cancel 和 agent dispose cancellation。
- `human_request_pending/resolved/timeout/cancelled` 事件 shape。
- human-request failure 到 `OrchestratorDiagnostic` / `OrchestratorError` 的转换。

它不拥有：

- clients map。
- agent records。
- orchestrator event fanout 实现。
- session 写入。

`HumanRequestBroker` 通过 narrow host 接口向 orchestrator 请求四件事：找可处理 human request 的 client、emit event、publish diagnostic、记录 agent lifecycle cancellation failure。

### `model-registry.ts`

`model-registry` 拥有 model catalog、models.json load/merge、auth bridge、provider registration，以及纯模型事实 helper：`modelReference()`、`parseModelReference()`、thinking level 集合与名称解析。

它不拥有 agent runtime policy。`setAgentModelByReference()`、thinking level 支持性检查、resume 失败诊断仍由 `agent-orchestrator.ts` 负责。

### `command.ts`

`command.ts` 是 command 事实模块：command types、parser、built-in binding 表和 inline/built-in command facts 都在这里。

Command input 的运行时执行路径仍是 `AgentOrchestrator` 的 public runtime surface，不是 collaborator：`inputAgent`、`_nextCommandId` / `_nextInputId`、gateway、argument completion、inline expansion、command event emission 和 expansion session writes 都留在 orchestrator 的 command input 区块。后续若继续拆，应先定义 narrow host，再抽 command gateway/collaborator；不要把执行状态机塞回 `command.ts`。

### `diagnostics.ts`

`diagnostics.ts` 是 diagnostic contract 和小型 construction helper，不是有状态 service。它定义 `CoreDiagnostic`、`OrchestratorError`、message formatter、dedupe、resource adapter，以及 `createOrchestratorDiagnostic()` / `toDiagnostic()`。

需要产生 orchestrator-domain diagnostic 的 runtime module 应复用这些 helper，而不是在本地复制 code/domain/source 推断逻辑。

### `operation-source.ts`

`operation-source.ts` 定义 runtime operation provenance。它可以放与 `OperationSource` 直接相关的纯 helper，例如 `agentIdFromOperationSource()`。

它不应增长为 command/human-request/tool 的通用上下文模块。

## 拆分纪律

拆分的目标是形成可读的责任边界，不是追求行数均匀。

可以拆：

- 一个模块已经拥有独立状态或生命周期。
- 多个调用点围绕同一协议事件或状态机重复实现。
- 新模块可以通过 narrow host 接口工作，而不是 import 旧巨石。

不要拆：

- 只有一个消费者的单行 helper。
- 为避免长文件而迁出的任意 types。
- 尚未有第二个消费者的抽象。
- 会让 dependency layer import orchestration layer implementation 的模块。

当前后续最自然的拆分点是 command input gateway：它已有独立状态（command/input id）、事件轨道、gateway、argument completion 与 inline expansion。但它需要保留 built-in binding 对 orchestrator 原子方法的调用边界，抽取时应使用 narrow host，而不是让 `command.ts` 或 gateway 拿到私有 agent records。
