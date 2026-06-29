# Tools And Extensions Refactor

本文是下一阶段 tool/extension 重构草案。它记录目标方向，不描述当前已经完全落地的实现。

当前重点是 **extension loader/runner + Orchestrator + 现有 ToolRegistry 的接合**。本阶段不做 built-in coding extension 迁移，也不把 `ToolRegistry` 改造成 provider 聚合器。目标是先让 WIDI 的 extension 接入方式尽量贴近 Pi coding-agent，同时保留 WIDI 已有的 registry 设计：tool 定义、patch、source、diagnostics、profile visibility、active tool names 和最终 wrap-to-`AgentTool` 都仍由 registry 管理。

Phase 1 的交付物是文档边界，不是代码迁移：所有 core docs 应一致表达当前 coding tools 已移出 core，作为 frozen legacy examples 保留；extension loader/runner 的第一目标是通过 Orchestrator 激活 agent/profile scoped extension scope，并让 `registerTool` 贡献到 scoped registry overlay。高级 patch/storage/file-module loader 能力后置设计。

## 背景

Pi `AgentHarness` 持有 `ExecutionEnv`，但 `AgentTool.execute(...)` 的签名没有接收 `env`。Pi coding-agent 的 built-in coding tools 也是闭包捕获 `cwd`，并在 tool 内部直接使用 `fs`、`spawn`、managed `fd/rg`、local shell utils 和各自的 operations seam。

这说明 Pi upstream 的 `ExecutionEnv` 更像 harness-adjacent host capability，而不是 coding tool runtime abstraction。

WIDI 早期的 `ToolDefinition.execute(..., context)` 把 `ExecutionEnv` 注入 tool context，能让 `read/write/bash` 通过统一 env 运行。但继续沿这个方向开发 `find/grep/edit/ls` 会遇到越来越多非 `ExecutionEnv` 能自然表达的需求：

- managed `fd/rg` binary。
- gitignore-aware glob/search。
- edit/patch engine。
- interactive shell session、stdin、poll、cancel 和 process cleanup。
- sandbox、remote worker、SSH、本地 shell 等 backend 差异。
- tool-specific UI preview 与 typed result details。

因此，coding tools 长期看不应继续被视作 core primitive。它们更像一个随产品分发的 capability pack。

不过这不是当前阶段要解决的问题。当前阶段只处理 extension loader/runner 如何经由 WIDI `AgentOrchestrator` 为当前 agent/profile 贡献 tool 和 handlers，以及 registry 如何继续作为 runtime 的唯一 tool 管理层。

## Pi Reference

Pi coding-agent 的 agent session runtime 是 **definition-first, wrap-last**。

Session build 时先创建带好 runtime 参数的 `ToolDefinition`：

```text
createAllToolDefinitions(cwd, options)
```

这些 definition 已经通过闭包捕获 `cwd`、settings-derived options、managed binary strategy 或 operations seam。Extension tools 也是先注册 definition。

在交给 `AgentHarness` 前，Pi 才将 definition wrap 成最终 `AgentTool`：

```text
ToolDefinition + ctxFactory -> AgentTool
```

最终进入 `AgentHarness` 的是结构完整、可直接执行的 `AgentTool[]`。Harness 不再解析 tool definition，也不会给 tool 注入 `ExecutionEnv`。

WIDI 应参考这个结构，但不需要照搬 Pi 的所有目录和内置 coding extension 组织方式：

- extension activation 阶段注册 `ToolDefinition`。
- registry 以 definition 为单位做 source、diagnostics、visibility、active tool names 和 debug facts。
- registry resolve 的末端统一 wrap 成 Pi `AgentTool[]`。
- 只有 SDK/backward-compat 入口可以接受裸 `AgentTool`，并转换成 synthetic `ToolDefinition`。

## 目标

新的分层应区分三类对象：

- **Core agent tools**：WIDI core 原生协作/编排 tool，例如 subagent、human request、ask、orchestrator command wrapper。
- **Legacy coding examples**：当前已经存在的 `read/write/bash`，已移到 `apps/widi-pi/examples/coding/`，只保留为参考实现，不继续补功能、Pi parity 或 backend abstraction。
- **External extension tools**：用户、项目或插件 extension 贡献的 tools。

Core 负责 runtime composition、diagnostics、profile visibility、active tool names 和 lifecycle event。Extension loader/runner 由 Orchestrator 拥有：loader 负责激活 extension factory 并产出 loaded scope，runner 负责将 loaded scope 绑定到 Orchestrator actions 并处理 runtime emit。

本阶段目标：

- 建立与 Pi coding-agent 接近的 extension runner 语义。
- Extension API 第一版以 `registerTool` 和少量命名 lifecycle handlers 为核心，而不是要求 extension 实现 provider 聚合接口。
- ToolRegistry 保持 WIDI 当前设计，继续负责冲突、patch、resolve 和最终 `AgentTool` 生成。
- 不迁移 `read/write/bash` 到 built-in coding extension，也不继续维护它们作为主线 coding tool set。
- 不引入 tool load order、priority 或 provider order。

## Tool Definition Ownership

`ToolDefinition` 应从 `core/tools` 移到 extension-facing model 附近，例如：

```text
apps/widi-pi/src/core/extension/types.ts
```

它应参考 `pi/packages/coding-agent/src/core/extensions/types.ts`，但保留 WIDI 已经做出的关键设计：

- `ToolDefinition` 不包含 `TState`。
- Core 不维护 tool preview/state/reducer。
- UI、RPC、debug view 或 extension host 从 `tool_lifecycle_event`、tool call arguments、tool result content/details 派生展示状态。
- `execute` 只接收 tool call、params，以及 per-call context，例如 abort signal、onUpdate、extension context 和 human request。

`ToolDefinition` 不包含 `executionEnv` requirement，`ToolExecutionContext` 也不注入 `ExecutionEnv`。需要 shell/filesystem/sandbox 的 tool 应在 factory/extension activation 阶段闭包捕获自己的 backend 或 operations，这与 Pi coding-agent 的 built-in tools 更接近。

## Tool Registry Ownership

`ToolRegistry` 仍应放在 core，且本阶段保持 WIDI 当前设计。

它是 runtime tool manager：

- 收集 core agent tools。
- 在 scoped resolve 中接收当前 agent/profile 的 external extension tools。
- 处理 name conflict 和 diagnostics。
- 根据 profile/policy 解析 visible tools。
- 解析 active tool names。
- 产出 Pi `AgentTool[]` 给 `AgentHarness`。
- 为 orchestrator/debug view 暴露 resolved tool facts。

换句话说，registry 管理的是“当前 runtime 里有哪些 tool”，不是“所有 tool 的 backend 如何执行”。

当前 registry API 不需要切换成 provider model。应保留：

- `defineTool(tool, source)`。
- `patchTool(targetToolName, patch, source)`。
- first definition wins，并为 duplicate 产生 diagnostics。
- profile visibility / active tool names resolution。
- wrap-to-`AgentTool` 的唯一出口。

Extension loader/runner 是 scoped resolve 的上游贡献者，不替代 registry，也不绕过 registry；它不应把 per-agent extension state 直接写入全局 registry。

## Extension Runner Registration

第一阶段 extension runner 应尽量对齐 Pi coding-agent 的 extension 体验：extension activation 时拿到一个受控 API，通过 API 注册 tool definition 和 lifecycle handlers。

概念上接近：

```ts
interface ExtensionApi {
	registerTool(tool: ToolDefinition): void;
	on(event: ExtensionEventName, handler: ExtensionHandler): void;
}
```

WIDI 与 Pi coding-agent 的关键差异是 multi-agent 底层来自 `AgentHarness`，而 `AgentHarness` 并不理解 extension。Extension 的接入点必须是 `AgentOrchestrator`：

- Orchestrator 在 spawn/resume 时根据当前 `AgentProfile.extensions` 激活 extension scope。
- Harness 只接收最终 `AgentTool[]`，不接收 extension runner，也不暴露 extension API。
- Extension handlers 由 Orchestrator 在 command、agent harness event、tool lifecycle、human request 等边界触发。
- Extension 可以获得 Orchestrator 绑定出来的强编排 facade，但不直接拿 raw `AgentOrchestrator`、raw `AgentHarness` 或内部 maps。

Loader 的职责：

- 管理内存 extension factory registry。
- 根据 profile extension ids 激活 agent/profile scoped extension。
- 创建 extension-scoped API。
- 执行 activation。
- 收集 extension 注册的 `ToolDefinition` 和 lifecycle handlers。
- 记录 activation diagnostics、invalid declaration、missing factory 等问题。
- 产出 loaded extension scope。

Runner 的职责：

- 绑定 loaded extension scope 与 Orchestrator actions facade。
- 将 loaded scope 的 tool contributions 写入 scoped registry overlay。
- 在 Orchestrator 转发 harness/lifecycle events 时执行 scoped handlers。
- 将 handler errors 转成 runtime diagnostics。

Orchestrator 的职责：

- 拥有 extension loader，并为每个 agent 创建 extension runner。
- 在 `_buildAgentHarness` 前通过 loader 加载当前 agent/profile 的 extension scope。
- 在 `_resolveAgentTools` 时合成 core/global registry 和当前 agent extension contributions。
- 在 `setAgentTools`、`setAgentActiveTools` 或 extension reload 后重新 resolve 并调用 harness `setTools`。
- 将 harness event 和 tool lifecycle event 转发给 scoped extension handlers。

Registry 的职责保持不变：

- 判断同名 tool 谁生效。
- 判断 tool 是否 visible/active。
- 处理 patch。
- 在 resolve 末端生成 `AgentTool[]`。

这样可以获得 Pi 的 extension activation 形态，但不会把 WIDI registry 的 source、diagnostics、patch 和 active tool 逻辑拆散，也不会让某个 agent/profile 的 extension tool 泄漏到其他 agent。

## Extension Scope And Registry Overlay

Extension contribution 默认是 agent/profile scoped，而不是写入全局 `ToolRegistry`。

当前 `ToolRegistry` 仍可以保持无 scope、无 priority、无 provider 聚合的简单模型。Scope 由 Orchestrator 在 resolve 前组装：

```text
core/global registrations
+ current agent extension scope registrations
-> temporary scoped registry / registry snapshot
-> resolve
-> AgentTool[]
-> AgentHarness
```

实现上可以选择临时 registry、registry snapshot 或 overlay helper；关键语义是全局 core registry 不持有 per-agent extension state。

这个设计保证：

- Extension tool 不跨 agent 泄漏。
- 同一个 extension factory 可以为不同 profile/agent 激活不同 scope。
- `ToolRegistry` 继续只负责“当前 runtime tool set”的 resolve 语义。
- Orchestrator 明确掌握 `agentId/profileId/extensions` 的边界。
- 未来支持 reload 时，只需要重建对应 agent scope 并重新 `setTools`。

## Extension Context And Orchestration Facade

WIDI extension 应允许 agent 编排，但通过稳定 facade 暴露能力，而不是直接暴露 raw `AgentOrchestrator`。

Pi coding-agent 的参考形态是强 facade：`ExtensionContext` 暴露 runtime 查询、abort、compact、system prompt 等能力；command context 额外暴露 `newSession`、`fork`、`navigateTree`、`switchSession`、`reload`；`pi.*` API 暴露 message、tool、model 等操作。这些能力由 session runtime 绑定，而不是让 extension 直接持有内部 session object。

WIDI 对应的 MVP 应分为两层：

- `ExtensionContext`：普通 lifecycle handler 使用，包含 `agentId`、`profileId`、extension identity、diagnostics、human request、有限查询能力和当前 signal。
- `ExtensionOrchestrationContext` 或 `ExtensionCommandContext`：command/tool/explicit orchestration handler 使用，允许强 agent 操作。

强编排 facade 可以包括：

- `spawnAgent(...)`。
- `promptAgent(agentId, text, options?)`。
- `steerAgent(agentId, text, options?)`。
- `followUpAgent(agentId, text, options?)`。
- `nextTurnAgent(agentId, text, options?)`。
- `abortAgent(agentId)`。
- `compactAgent(agentId, customInstructions?)`。
- `navigateAgentTree(agentId, targetId, options?)`。
- `getAgentTools(agentId)` / `setAgentTools(agentId, toolNames, activeToolNames?)` / `setAgentActiveTools(agentId, toolNames)`.
- `getAgentModel(agentId)` / `setAgentModel(agentId, model)`.
- `requestHuman(request)`。
- `dispatch(command)` for stable orchestrator commands.

不应暴露：

- Raw `AgentOrchestrator` instance。
- Raw `AgentHarness` instance。
- `agents` map。
- Raw `ToolRegistry` mutation surface。
- client maps、pending human request maps、streaming tool call maps 等内部状态。

如果 context 会跨 session replacement、reload 或 agent teardown 存活，应参考 Pi 的 `assertActive/invalidate` 语义，避免 stale context 继续操作旧 runtime。

## Patch Model

当前 `patchTool`/`aroundExecute` 能表达审计、确认、sandbox 转发和 backend replacement。但 external extension 是否可以 patch tool，不一定是第一阶段必须能力。

建议迁移时分两步：

1. 先保留现有 patch 能力以避免倒退，但不把新设计建立在 patch 必须存在之上。
2. 等 extension permission model 明确后，再决定 patch 是否作为正式 extension API 暴露。

正式暴露 patch 前，需要先回答：

- 哪些 extension 可以替换 `execute`。
- 哪些 extension 只能 `aroundExecute`。
- 多个 patch 的加载顺序如何解释。
- patch 失败、permission denied、contract risk 如何诊断。
- patch 的 extension context 如何绑定，`next()` 如何恢复内层 tool source context。

## Deferred: Built-in Coding Extension

Coding tools 长期可以迁出 core tool primitive，成为 built-in extension，例如：

```text
apps/widi-pi/src/builtin-extensions/coding/
```

或：

```text
apps/widi-pi/src/extensions/coding/
```

届时它可以负责：

- 注册 `read/write/bash/find/grep/edit/ls`。
- 管理 coding backend abstraction。
- 选择 local/sandbox/remote tool implementation。
- 管理或声明 `fd/rg` 等 binary dependency。
- 实现 interactive shell session 或连接上游 `ExecutionEnv` future session API。
- 维护 Pi coding-agent parity 文档与测试。

但这个工作明确延期。当前阶段不迁移 `read/write/bash`，也不以 built-in coding extension 作为 extension runner 的第一目标。

当前约束：

- `apps/widi-pi/examples/coding/*` 作为 frozen legacy examples 保留。
- 新的 extension runner 不要求先承载 coding tools。
- `core-tools.md` 只记录这些 historical examples 的历史行为。
- 后续实现 `find/grep/edit/ls` 时，不应继续扩展当前 legacy coding tool 目录；应等待 extension runner/backend 方向稳定后另起设计。

## Core Agent Tools

Core 仍可以拥有少量 agent collaboration tools。它们直接暴露 WIDI core capability，而不是 coding runtime capability。

候选包括：

- subagent spawn / route / inspect。
- human request / ask user。
- orchestrator command wrapper。
- session/debug/diagnostics inspection。

这些 tool 由 core 直接注册到 `ToolRegistry`。它们可以直接调用 orchestrator/core APIs，因为能力本体属于 core。

## ExecutionEnv

`ExecutionEnv` 不应再被视为 coding tools 的必经 backend。它仍可以作为 harness host capability，被 settings、resource loader、profile loader、auth/model config 和 core agent tools 使用。

未来如果 WIDI fork Pi upstream，可以考虑扩展 `ExecutionEnv` 或相邻 runtime capability，提供更强的通用原语：

- lock/transaction/lease。
- interactive shell session：start、poll、write stdin、cancel、yield timeout、output cursor、resource cleanup。
- maybe glob/search capability。

但这些是 upstream/runtime primitive，不应成为当前 coding extension 的唯一设计支点。

## Migration Plan

迁移目标是分阶段建立 extension runner 和 registry 的边界，不一次性重写 coding tool 行为。每个 phase 都应保持现有测试可运行，并尽量只改变一个边界。

### Phase 1: Documentation And Type Boundary

目标：明确方向，不改 runtime 行为。

状态：文档边界已收口；后续 Phase 才涉及类型移动、runner 实现或 runtime 行为变化。

- 新增本草案。
- 明确 `ExecutionEnv` 不是 coding tool runtime abstraction。
- 明确 coding tools 是未来 built-in extension/backend 候选，不是本阶段目标。
- 明确本阶段重点是 extension runner、Orchestrator 和 `ToolRegistry` 接合。
- 标注当前 `examples/coding/*` 为 frozen legacy examples。
- 同步 `extensions`、`tools and capabilities`、`core tools`、`sessions and runtime`、`diagnostics` 的相关表述。

验收：

- 文档能解释为什么不继续将 `find/grep/edit/ls` 做成 core `ExecutionEnv` tool。
- 文档明确 extension 注册 `ToolDefinition`，registry 最后 wrap 成 `AgentTool[]`。
- 文档明确 `ToolRegistry` 不切换为 provider 聚合器，不恢复 priority/order API。
- 文档明确 `bash/read/write` 当前只作为 frozen legacy examples 记录行为，不属于 core ownership。
- 不移动代码，不改变当前 `read/write/bash` 行为。

### Phase 2: Move ToolDefinition

目标：把 tool definition 的 ownership 从 `core/tools` 移到 extension-facing model，但不改变 registry 行为。

状态：已完成类型搬迁；`core/tools/types.ts` 仅作为 compatibility barrel 保留，核心实现从 `core/extension/types.ts` 引用类型。

- 将 `ToolDefinition`、`ToolDefinitionPatch`、`ToolSource` 等类型迁到 `core/extension/types.ts`。
- 保留无 `TState` 的设计。
- 保留 lifecycle event 作为 preview/state 的唯一 core 事实来源。
- 更新 import，不移动具体 coding tool 实现。

建议步骤：

1. 新建 `src/core/extension/types.ts`，搬入 definition/patch/source/context 类型。
2. `src/core/tools/types.ts` 暂时 re-export，减少一次性 import churn。
3. 将 `read/write/bash` 和 `tool-registry` 逐步改为从 extension types import。
4. 删除 `core/tools/types.ts` 中已迁出的定义，或保留为 compatibility barrel。

验收：

- `ToolDefinition` 不再语义归属于 core tools。
- 现有 `ToolRegistry` 测试和 `read/write/bash` 测试不需要行为重写即可通过。
- 文档里不再把 coding tools 的长期 ownership 描述为 core primitive。

### Phase 2.5: Remove ExecutionEnv From ToolDefinition

目标：移除 tool definition 对 `ExecutionEnv` 注入模型的依赖，让 tool 行为由 definition factory/extension activation 闭包捕获。

状态：已完成。`ToolDefinition.executionEnv`、`ToolExecutionEnvRequirement` 和 `ToolExecutionContext.env` 已移除；`ToolRegistry` 不再向 tool execute context 注入 env；legacy `bash/read/write` 已移出 core，只在 examples 中通过 factory options 捕获 `ExecutionEnv` 或 operations。

建议步骤：

1. 从 extension-facing types 中移除 `executionEnv` metadata。
2. 从 `ToolExecutionContext` 中移除 `env`。
3. 从 `ToolAgentAdapterContext` 和 registry adapter 中移除 env 注入。
4. 将 legacy coding example factory 改为闭包捕获 backend，例如 `createReadToolDefinition({ env })`。
5. 保留 `ExecutionEnv` 作为 orchestrator/harness/resource/settings 等 runtime boundary，而不是 generic tool definition contract。

验收：

- `ToolDefinition` 不再声明 execution env requirement。
- `ToolRegistry` 不理解 shell/filesystem backend，也不负责把 env 注入 execute。
- Tool 的 backend 选择发生在 factory/extension activation 阶段；legacy coding examples 不再承载新的 backend 设计。
- `npm run check` 通过，现有 tool 行为不倒退。

### Phase 3: Extension Loader/Runner MVP

目标：实现最小 Orchestrator-owned extension loader/runner，让 extension 可以为当前 agent/profile 注册 tool definition 和少量 lifecycle handlers。

状态：已完成 MVP。当前实现拆分为 `ExtensionLoader` 和 `ExtensionRunner`：loader 支持内存 factory registration、agent/profile scoped activation、`registerTool`、`agent_harness_event` / `tool_lifecycle_event` handler collection、missing factory / activation diagnostics；runner 绑定 loaded scope 与 Orchestrator actions，负责 scoped registry overlay、handler emit 和 handler diagnostics。

- 定义 extension identity、source metadata、factory 和 activation lifecycle。
- 支持内存 extension factory registry，例如 `registerExtensionFactory(extensionId, factory)`。
- Profile `extensions` 先从内存 factory registry 解析，不做真实文件/模块 loader。
- Extension API 暴露 `registerTool(tool)` 和命名 lifecycle handler registration。
- Loader 产生 agent/profile scoped loaded scope；runner 绑定 runtime actions 并贡献到 scoped registry overlay，不写入全局 `ToolRegistry`。
- Activation errors、missing factory、handler errors 进入 diagnostics。

建议步骤：

1. 新建 Orchestrator-owned extension loader 和 per-agent extension runner。
2. 新增内存 factory registry；暂不做 ESM dynamic import、trust、path resolution 或 reload。
3. 在 agent spawn/resume 时根据 `AgentProfile.extensions` load 当前 agent scope。
4. Loader 提供 extension-scoped activation API，先包含 `registerTool` 和少量命名 handlers。
5. Loader 记录 loaded extensions、activation diagnostics、contributed tool names 和 registered handlers。
6. Orchestrator 保存 per-agent extension runner，并在 harness event/tool lifecycle/command 边界触发 handlers。

验收：

- 一个内存 factory extension 可以注册 tool，并只对声明该 extension 的 agent/profile 可见。
- Extension tool 的 source/provenance 可诊断。
- Orchestrator create/resume/runtime `setTools` 仍只消费 scoped registry resolve 结果。
- `AgentHarness` 不接收 extension runner，不直接暴露 extension API。
- Extension handler 可以通过 facade 做受控 agent 编排，但拿不到 raw `AgentOrchestrator` 或 raw `AgentHarness`。

### Phase 4: ToolRegistry Integration Hardening

目标：强化 scoped loader/runner 与现有 registry 的集成，而不是替换 registry。

状态：scoped registry overlay 的基础能力已随 Phase 3 落地；debug facts、source shape hardening 和更多 reload/diagnostics 场景仍留在本阶段。

- 保留 `defineTool` / `patchTool` 作为 registry 的核心入口。
- Extension loader/runner 只贡献当前 agent scope 的 definition、source 和 handlers。
- Registry 继续处理 duplicate、visibility、active names、patch 和 wrap-to-`AgentTool`。
- Debug view 展示 loaded extensions、resolved tools 和 diagnostics。

建议步骤：

1. 给 extension source 设计稳定 shape。
2. 将 extension activation diagnostics 接入现有 `CoreDiagnostic`。
3. 实现 core/global registry + current agent extension scope 的临时 registry/snapshot/overlay。
4. 保证 duplicate tool 仍是 first definition wins。
5. 保证 active tool names 不需要理解 extension runner。
6. 保证 resolved facts 能区分 core tool 与 extension tool。
7. 保证 extension scope 不跨 agent 泄漏。

验收：

- Registry 行为不因 extension loader/runner 引入而改变。
- Extension tool 与 core tool 走同一 resolve、diagnostic 和 wrap 流程。
- ToolRegistry 仍是 runtime 的唯一 tool 管理层。
- 同一进程中的不同 agents 可以拥有不同 extension tool set。

### Phase 5: Extension API Parity

目标：继续贴近 Pi coding-agent extension API，但只暴露 WIDI 已经能稳定支持的能力。

- 对齐 extension factory / activation 形态。
- 明确 activation context 能拿到哪些 runtime 信息。
- 明确 `ExtensionContext` 与 `ExtensionCommandContext` / `ExtensionOrchestrationContext` 的能力边界。
- 完善 agent orchestration facade。
- 决定是否暴露 `patchTool`。
- 设计真实 file/module loader、trust gate、reload、missing extension policy。

建议步骤：

1. 对比 `pi/packages/coding-agent/src/core/extensions` 的 API 面。
2. 保持 `registerTool` 语义一致。
3. 将 WIDI multi-agent orchestration facade 对齐到 Pi 的强 facade 思路，但不暴露 raw runtime objects。
4. 暂不引入 order/priority。
5. 如果暴露 patch，先限定 permission 和 diagnostics。
6. 为 extension declaration/version/compatibility 补测试。

验收：

- WIDI extension 作者能用接近 Pi coding-agent 的方式注册 tool。
- WIDI registry 的行为仍可预测。
- External extension 不需要理解 `AgentHarness` 或直接构造最终 `AgentTool[]`。
- External extension 可以通过稳定 facade 做明确授权的 agent 编排。

### Phase 6: Patch And Advanced Runtime Capabilities

目标：在 extension runner 和 registry 集成稳定后，再恢复或正式化高级 patch/runtime 能力。

候选工作：

- 决定 `patchTool` 是否对 external extension 开放。
- 设计 patch permission：metadata-only、aroundExecute、replace execute。
- 评估 built-in coding extension 是否进入下一阶段。
- 设计 coding backend：local/sandbox/remote。
- 设计 interactive shell session、managed `fd/rg`、glob/search backend。
- 对齐 Pi upstream roadmap 中的 `ExecutionEnv` future primitives。

验收：

- Patch 行为有权限、加载顺序和 diagnostics。
- 如果后续启动 coding extension，backend 演进不要求 core registry 理解 backend state。
- Core agent tools 和 coding extension tools 的 ownership 清晰分离。

## Non-goals

- 不在 Phase 3 实现用户动态 extension loader、真实文件/模块加载、dynamic import cache busting 或 trust gate。
- 不在本阶段实现 built-in coding extension。
- 不在本阶段迁移 `read/write/bash` 到 extension 目录；它们已移到 examples。
- 不在本阶段继续维护或扩展 `read/write/bash` 行为；只保留最小兼容。
- 不把 `ToolRegistry` 改成 provider 聚合器。
- 不把 coding runtime backend 塞进 core `ExecutionEnv`。
- 不让 extension 绕过 registry 直接替换 `AgentHarness` tools。
- 不让 extension 直接持有 raw `AgentOrchestrator`、raw `AgentHarness` 或内部 mutable maps。
- 不把 per-agent extension contribution 写入全局 registry 状态。
- 不恢复 tool-local `TState` 到 core definition。
- 不让 core 解释 coding extension 的 backend state。
- 不把 `AgentHarness` 改造成理解 extension 的 runtime；它仍只接收 `AgentTool[]`。

## Open Questions

- Core agent tools 是否仍使用同一个 `ToolDefinition`，还是直接提供 Pi `AgentTool`。
- `patchTool` 是否继续是正式 extension API，还是只保留 internal compatibility。
- Extension declaration/version/compatibility 的最小字段是什么。
- Phase 4/5 的真实 file/module loader 如何处理 trust、path resolution、reload 和 import cache。
- `ExtensionContext` 与 `ExtensionOrchestrationContext` 的最小 API 面应包含哪些具体 command。
- Coding extension backend 如何表达 local/sandbox/remote 的选择。
- Profile capabilities 如何映射到 extension availability，而不把 tool visibility 当作 capability。
- Debug view 展示 extension、tool、patch、source 和 diagnostics 的具体结构。
