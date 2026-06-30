# Tools And Extensions Refactor

本文记录 tool/extension 重构的阶段性结论。详细后续任务集中维护在 [WIDI 下一阶段 TODO](../TODO.md)。

## 背景

Pi coding-agent 的 agent runtime 是 definition-first、wrap-last：

- built-in tools 和 extension tools 先注册为 `ToolDefinition`。
- tool definition 通过闭包捕获 cwd、settings、managed binary strategy 或 operations seam。
- 进入 `AgentHarness` 前再 wrap 成 Pi `AgentTool[]`。
- `AgentHarness` 不理解 extension，也不向 tool execute 注入 coding backend。

WIDI 早期尝试让 `ToolDefinition` / `ToolExecutionContext` 注入 `ExecutionEnv`，这对 `read/write/bash` demo 有用，但不适合继续扩展成完整 coding tool backend。`find/grep/edit/ls`、managed `rg/fd`、interactive shell、sandbox/remote backend、UI render 和 typed details 都不是一个通用 `ExecutionEnv` 字段能自然表达的能力。

因此当前结论是：

- Coding tools 不再作为 core primitive 扩展。
- `apps/widi-pi/examples/coding/*` 是 frozen legacy examples，只保留行为参考。
- 后续可交付 coding 能力应作为 built-in/product extension 或 preset capability pack。
- Core 保留 ToolRegistry、orchestrator、diagnostics、profile visibility、active tools 和 lifecycle event。

## 当前状态

已落地：

- `ToolDefinition`、`ToolDefinitionPatch`、`ToolSource` 已迁到 `src/core/extension/types.ts`；`core/tools/types.ts` 只做 compatibility re-export。
- `ToolDefinition` 不再声明 `ExecutionEnv` requirement，`ToolExecutionContext` 不再注入 `env`。
- `ToolRegistry` 位于 `src/core/tool-registry.ts`，负责 `defineTool`、`patchTool`、conflict diagnostics、visibility、active tools 和 wrap-to-`AgentTool`。
- Orchestrator create/resume/runtime tool mutation 都通过 ToolRegistry resolve，不再暴露 raw `AgentTool[]` command API。
- `ExtensionLoader` / `ExtensionRunner` MVP 已落地：内存 factory、profile scoped activation、`registerTool`、`patchTool`、observers、interceptors、scoped registry overlay。
- Harness hook MVP 已桥接：`before_agent_start`、`context`、`tool_call`、`tool_result`。
- Orchestrator 已发布 raw `agent_harness_event` 和 normalized `tool_lifecycle_event`，extension observers 可消费两者。
- Extension `ctx.session.appendEntry()` / `findEntries()` MVP 已落地，用 Pi-compatible namespaced `custom` entry 保存小型 session-local state。

仍是 demo/原型：

- Extension loader 只支持内存 factory，没有真实 file/module discovery、trust、reload、version/compatibility。
- Permission model 尚未定义，尤其是 replace execute、filesystem/shell/model/session/orchestrator capability。
- Debug/inspection command 缺失，无法系统查看 loaded extensions、hooks、patches、resolved tools、custom entries 和 diagnostics。
- Product coding tools 未接入 runtime composition。
- Agent collaboration tools 尚未实现。

## 分层结论

### Tool Definition

`ToolDefinition` 属于 extension-facing model，而不是 core coding tool model。Tool backend 应由 definition factory 或 extension activation 闭包捕获。

Core 不维护 tool preview/state/reducer。UI/RPC/debug view/extension host 从 `tool_lifecycle_event`、tool call arguments、tool result `content` 和 typed `details` 派生展示状态。

### Tool Registry

ToolRegistry 是 runtime tool manager：

- 收集 core tools、extension tools 和 patches。
- 使用 first definition wins 处理同名 define。
- 用 `patchTool()` 修改既有 tool。
- 根据 profile/policy 解析 visible tools。
- 根据 session/runtime policy 解析 active tool names。
- 输出 diagnostics 和 final `AgentTool[]`。

Extension loader/runner 是 scoped contribution source，不替代 registry，也不写 per-agent extension contribution 到 global registry。

### Extension Runner

Extension runner 由 Orchestrator 拥有：

- spawn/resume 时根据 `AgentProfile.extensions` load 当前 scope。
- `_resolveAgentTools()` 时把 global registry clone 成 scoped registry，并 replay extension contributions。
- harness events 和 tool lifecycle events 由 Orchestrator fan out 给 runner observers。
- harness hooks 由 Orchestrator bridge 到 runner interceptors。
- extension context 只能拿到 facade，不能拿 raw `AgentOrchestrator`、raw `AgentHarness`、agents map 或 raw registry mutation surface。

### Session State

Extension custom entry MVP 只负责小型 session-local state：

- API：`ctx.session.appendEntry(type, data?)`、`ctx.session.findEntries(type?)`。
- Persisted type：`extension:<extensionId>:<localType>`。
- Read scope：current branch path，root-to-leaf order。
- Mutation：append-only。
- Non-goals：large artifact store、multi-session index、shared tool state、custom message semantics。

## Phase Status

- Phase 1 Documentation/type boundary：完成。
- Phase 2 Move `ToolDefinition`：完成。
- Phase 2.5 Remove `ExecutionEnv` from tool definition：完成。
- Phase 3 Extension loader/runner MVP：完成。
- Phase 4 ToolRegistry integration hardening：基础 overlay 完成；debug facts、permission 和 reload 场景未完成。
- Phase 5 Extension API parity：observer/interceptor MVP 完成；command/provider/resource/session hook parity 未完成。
- Phase 6A Patch API：MVP 完成；permission 分级未完成。
- Phase 6B Custom entries：MVP 完成；fork/compaction/export/debug/custom_message policy 未完成。
- Phase 6C File loader/trust/reload/runtime backends：未开始。

## Deferred Coding Extension

完整 coding capability pack 后续可以进入 built-in/product extension，例如：

```text
apps/widi-pi/src/extensions/coding/
```

它应负责注册 `read/write/edit/bash/grep/find/ls`，并管理 local/sandbox/remote backend、managed binary、interactive shell 和 Pi coding-agent parity 测试。这个工作应等待 extension discovery、trust、reload、permission 和 runtime composition 更稳定后再做。

## Core Agent Tools

Core 仍可以拥有少量 agent collaboration tools。它们暴露 WIDI core capability，而不是 coding runtime capability。

候选能力：

- subagent spawn / prompt / wait / inspect。
- human request / ask user。
- orchestrator command wrapper。
- session/debug/diagnostics inspection。

这些 tool 可以由 core 或 built-in extension 注册到 ToolRegistry，但执行必须经过 orchestrator facade，不能直接持有 raw harness。

## Non-goals

- 不把 ToolRegistry 改成 provider 聚合器。
- 不恢复 priority/order API。
- 不把 coding runtime backend 塞进 `ToolDefinition` 或 core `ExecutionEnv`。
- 不让 extension 绕过 registry 直接替换 harness tools。
- 不让 extension 直接持有 raw orchestrator/harness/internal maps。
- 不把 per-agent extension contribution 写入 global registry。
- 不让 `AgentHarness` 理解 extension runtime。
