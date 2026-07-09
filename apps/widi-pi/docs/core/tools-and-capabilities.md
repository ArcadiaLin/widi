# Tools And Capabilities

Tools 是 agent 可调用入口。Core Capability 是 core 原生 runtime 能力。Profile Capability 是 profile 与 tool/runtime/orchestrator policy 之间的连接层。

## 核心理念

Core Capability 不是 Tool。

Core Capability 是 core 原生提供、可通过受控 API 调用的 runtime 能力，例如创建 agent、prompt/steer agent、request human、解析 profile、加载 resource 或发出 diagnostic。orchestrator 的原子方法是这些能力的唯一事实面；command input 只是它们面向 human input 的 trigger-based 协议（见 [Command Experiment](./command-experiment.md)）。

Product Tool 暴露 Runtime Capability。

Tool 是把 core capability、runtime boundary 或产品能力暴露给 `AgentHarness` 和模型的 adapter。它是访问路径，不是能力本体。Tool backend 应由 definition factory 或 extension activation 闭包捕获，而不是由 `ToolDefinition` 声明通用 `ExecutionEnv` requirement。Extension 或 adapter 可以通过受控 core API 调用同一 capability，而不必绕成 tool。

Tool registry 定义工具来源和可见性结果。

Profile 不定义 tool 本身。Profile 只声明哪些 tool 对当前 harness 可用、可见或受限。具体 tool 来自 core、extension 或 runtime adapter。

`profile.tools` 只处理 Tool Visibility。

它回答的问题是：某个 tool 是否加入当前 `AgentHarness`，是否对模型可见。它不表达更高层产品能力，也不替代 capabilities。

Profile Capability 连接 profile 与 policy。

Profile 用 capabilities 表达 agent 被允许做什么。Tool registry 和 runtime policy 根据 capabilities、extension 和 adapter 状态，决定最终暴露哪些 tools。

Tool Registry 属于 dependency layer。

Tool Registry 解析 core/product tools、extension-contributed tools 和 adapter-contributed tools，处理 name conflicts、availability 和 diagnostics，并为某个 agent harness 生成最终 tools。

当前实现位于 `apps/widi-pi/src/core/tool-registry.ts`。它负责 tool definition 解析和 Pi `AgentTool` adapter，并已接入 orchestrator create/resume/runtime tool update 路径；它不直接激活 extension，也不负责 runtime event 转发。

## Tool Registry

Registry 的 public API 是显式 registration：

- `defineTool(tool, source)` 新增一个 tool definition，来源可以是 core、extension 或 adapter。
- `patchTool(targetToolName, patch, source)` 以 tool name 为目标修改既有 tool。

Registry 输出是 resolved tools：

- `allTools` 是所有成功定义并应用 patch 后的工具。
- `tools` 是 profile/policy 请求后仍可见的工具。
- `activeToolNames` 是可见工具中实际启用的名字。
- `diagnostics` 记录冲突、缺失、重复和无效名字。

同名 `defineTool` 不是覆盖机制。Registry 采用 first registration wins，后注册的同名 tool 会被忽略并产生 `tool.define_conflict` diagnostic。修改既有 tool 应使用 `patchTool`，这样 extension 注入能被诊断、排序和审计。

Patch 规则：

- patch 按注册顺序应用。
- 后应用的 `description`、`parameters`、`strict` 和 `execute` 覆盖前者。
- `aroundExecute` 会包装当前 execute；后注册的 patch 因为后应用，会成为更外层 wrapper。
- `aroundExecute` 执行时，`context.extension` 绑定当前 patch source；调用 `next()` 时恢复内层 tool source 的 context，避免外层 extension context 泄漏到 core/base execute。
- patch 修改 `parameters` 但没有同步修改 `execute` 或 `aroundExecute` 时，会产生 `tool.patch_contract_risk` diagnostic。因为模型看到的新 schema 可能不再匹配旧 execute 逻辑。
- patch 目标不存在时产生 `tool.patch_target_missing` diagnostic，不会创建隐式 tool。

Tool visibility 规则：

- `requestedToolNames` 未提供时，所有 resolved tools 可见。
- `requestedToolNames` 提供时，只暴露其中存在的工具；重复和缺失会产生 diagnostic。
- `activeToolNames` 未提供时，默认等于可见工具。
- `activeToolNames` 提供时，会被校验到可见工具集合中；重复和缺失会产生 diagnostic。

Pi coding-agent 当前是 definition-first：built-in tools、custom tools 和 extension tools 最终都变成 `ToolDefinition`，再 wrap 成 Pi `AgentTool`。它的 extension runner 对同名 extension tool 采用 first registration wins，最终合成时 extension/custom tool 可以覆盖 built-in。WIDI 参考了这个 definition-first 结构，但用显式 `defineTool`/`patchTool` 替代裸 Map 覆盖，以便支持更强 diagnostics 和 extension 注入。WIDI 不保留 tool priority；同名 define 采用 first registration wins，需要改变既有 tool 时使用 `patchTool`。

ToolRegistry 是唯一的 `ToolDefinition -> AgentTool` wrap 入口。Create/resume harness 和 runtime `agent.setTools` 都应通过 registry resolve 后的 wrapped tools 更新 harness。裸 `AgentTool[]` 不再作为 orchestrator command API 暴露。

## Extension

Extension 可以注册 tool，也可以通过 hook 影响 tool 可用性。但 tool 是否进入某个 agent harness，应由 orchestrator/tool registry 基于 profile 和 policy 决定。

Extension 对既有 tool 的修改必须经过 Tool Registry。

Tool Registry 应把 tool 输入视为带来源的 registrations，而不是裸数组：

- `defineTool` 新增一个 tool。
- `patchTool` 以 tool name 为目标修改既有 tool。
- patch 可以替换 `description`、`parameters`、`strict` 或 `execute`。
- patch 也可以通过 `aroundExecute` 包装既有 execute，用于审计、重写参数、转发到 sandbox、替换文件写入 backend 等。
- patch 执行上下文按 patch source 绑定；base execute 仍使用定义来源的 context。
- 多个 patch 按注册顺序合成，冲突应产生 diagnostic。

例如，extension 修改产品内置 `write` tool 不应直接改 registry 中的 write 对象。它应注册一个针对 `write` 的 patch：轻量场景用 `aroundExecute` 包住原始写入；完整替换场景用 `execute` 替换行为。最终暴露给 `AgentHarness` 的仍是名为 `write` 的 resolved tool，active tool names 和 session resume 才能保持稳定。

Tool tracking 也属于这种轻量 wrapper 场景。它不应进入 core tool definition 或 registry adapter；需要记录 tool run 时，extension 可以用 `ToolDefinitionPatch.aroundExecute`（由 `src/core/tool-registry.ts` 的 patch 管线应用）包装目标 tool——execute 前记 start、`context.onUpdate` 中记 update、成功或抛错时记 finish/fail——并自行决定记录字段、保留期限和暴露方式。

## Tool Lifecycle Events

WIDI core 不持有 tool preview 或状态。Tool definition 只描述可执行工具，ToolRegistry 只负责 registration resolve、patch、diagnostics，以及显式 `ToolDefinition -> AgentTool` wrap。

Orchestrator 是当前 runtime event hub。它保留两条事件轨道；完整传递顺序见 [Runtime Lifecycle](./runtime-lifecycle.md)。

- `agent_harness_event` 原样透传 Pi `AgentHarnessEvent`，用于调试、日志和未来兼容。
- `tool_lifecycle_event` 发布 WIDI 归一化的 tool-call facts，供 UI 和 extension runner 稳定消费。

第一版 lifecycle event 覆盖：

- `tool_call_created`
- `arguments_delta`
- `arguments_ready`
- `execution_started`
- `execution_update`
- `execution_result`

`tool_call_created`、`arguments_delta` 和 `arguments_ready` 来自 `message_update.assistantMessageEvent.toolcall_*`。Orchestrator 只维护短生命周期的 `contentIndex -> toolCall` 映射来补全 streaming facts；它不是 tool state，不暴露、不持久化、不参与 UI 设计。该映射会在 `toolcall_end`、`message_end`、`turn_end` 或 `agent_end` 时清理，避免中断流留下 stale refs。

`execution_started`、`execution_update` 和 `execution_result` 来自 Pi `tool_execution_*` events。`execution_result.isError` 表示 Pi harness 认为最终结果是错误结果。

UI preview/state 不属于 core。TUI、RPC、HTML export 或 extension runner 可以基于 `tool_lifecycle_event`、tool name、arguments、result content/details 自行派生展示状态。Extension patch 也不拥有 lifecycle state API；它只能 patch definition/execution 字段，或用 `aroundExecute` 观察执行。

## Tool Result Persistence

WIDI-owned tools 的可恢复数据应优先参考 Pi coding-agent：tool call arguments、tool result `content` 和 typed `details` 共同构成可恢复上下文。比如文件写入正文应来自 tool call arguments，成功结果只需要短文本和路径 details；文件读取内容进入 tool result `content`，截断信息进入 `details`；编辑类工具可以把 patch/diff/first changed line 放进 `details`。

Tool Registry 不提供 session persistence facade，也不把 Pi `custom` entry 包装成 core tool state API。Registry 只负责解析 tool registrations，并把 resolved tool wrap 成 Pi `AgentTool`。

Pi `custom` entry 仍是 session tree 的一部分，但 WIDI core 不解释它、不把它作为 WIDI-owned tool 的状态通道。当前 extension runner 已提供 `ctx.session.appendEntry()` / `findEntries()` MVP，作为 extension-owned 小型 session-local state 通道；数据 shape 仍归 extension 所有，branch/fork/compaction/export/debug policy 仍待定义。

Tool tracking、审计和 checkpoint 更适合作为 extension pattern：用 `aroundExecute` 观察 tool run，必要时把摘要写入 tool result `details`、extension-owned storage，或 extension-owned custom entry。Core 不提供共享的 tool/session state 层。

## 非职责

- 不把 tools 当作裸数组长期透传。
- 不让 profile 直接持有 runtime tool instance。
- 不让 extension 绕过 tool registry 向 harness 注入不可诊断工具。
- 不把 tool visibility 当成 profile capability。
- 不让 extension 直接修改产品内置 tool 对象或绕过 resolved tool pipeline。
- 不为 WIDI-owned tool 引入绕过 Pi `AgentHarness` 标准 tool call/result/history 的持久化通道。

## TODO

Tool/capability 后续任务按 milestone 维护在 [Milestones](../TODO.md) 与 [Backlog](../BACKLOG.md)。本文件只保留 ToolRegistry、visibility、tool lifecycle facts 和 persistence 边界。
