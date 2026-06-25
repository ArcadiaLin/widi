# Tools And Capabilities

Tools 是 agent 可调用入口。Core Capability 是 core 原生 runtime 能力。Profile Capability 是 profile 与 tool/runtime/orchestrator policy 之间的连接层。

## 核心理念

Core Capability 不是 Tool。

Core Capability 是 core 原生提供、可通过受控 API 调用的 runtime 能力，例如创建 agent、dispatch command、request human、解析 profile、加载 resource 或发出 diagnostic。

Built-in Tool 暴露 Core Capability。

Built-in Tool 是把 core capability 暴露给 `AgentHarness` 和模型的 tool adapter。它是访问路径，不是能力本体。Extension 或 adapter 可以通过受控 core API 调用同一 capability，而不必绕成 tool。

Tool registry 定义工具来源和可见性结果。

Profile 不定义 tool 本身。Profile 只声明哪些 tool 对当前 harness 可用、可见或受限。具体 tool 来自 core、extension 或 runtime adapter。

`profile.tools` 只处理 Tool Visibility。

它回答的问题是：某个 tool 是否加入当前 `AgentHarness`，是否对模型可见。它不表达更高层产品能力，也不替代 capabilities。

Profile Capability 连接 profile 与 policy。

Profile 用 capabilities 表达 agent 被允许做什么。Tool registry 和 runtime policy 根据 capabilities、ExecutionEnv、extension 和 adapter 状态，决定最终暴露哪些 tools。

Tool Registry 属于 dependency layer。

Tool Registry 解析 built-in tools、extension-contributed tools 和 adapter-contributed tools，处理 name conflicts、availability 和 diagnostics，并为某个 agent harness 生成最终 tools。

当前实现先落在 `apps/widi-pi/src/core/tools/tool-registry.ts`。它负责 tool definition 解析和 Pi `AgentTool` adapter，并已接入 orchestrator create/resume harness build；它不直接激活 extension。

## Tool Registry

Registry 输入是 `ToolContribution`：

- `define` 新增一个 tool definition，来源可以是 core、extension 或 adapter。
- `patch` 以 tool name 为目标修改既有 tool。

Registry 输出是 resolved tools：

- `allTools` 是所有成功定义并应用 patch 后的工具。
- `tools` 是 profile/policy 请求后仍可见的工具。
- `activeToolNames` 是可见工具中实际启用的名字。
- `diagnostics` 记录冲突、缺失、重复和无效名字。

同名 `define` 不是推荐的覆盖机制。Registry 会按 priority 和注册顺序选出 deterministic winner，并产生 `tool.define_conflict` diagnostic。修改既有 tool 应使用 `patch`，这样 extension 注入能被诊断、排序和审计。

Patch 规则：

- patch 按 priority 从低到高应用；同 priority 按注册顺序应用。
- 后应用的 metadata、prompt、argument preparation、execution env、state reducer 和 execute 覆盖前者。
- `aroundExecute` 会包装当前 execute；高 priority patch 因为后应用，会成为更外层 wrapper。
- patch 目标不存在时产生 `tool.patch_target_missing` diagnostic，不会创建隐式 tool。

Tool visibility 规则：

- `requestedToolNames` 未提供时，所有 resolved tools 可见。
- `requestedToolNames` 提供时，只暴露其中存在的工具；重复和缺失会产生 diagnostic。
- `activeToolNames` 未提供时，默认等于可见工具。
- `activeToolNames` 提供时，会被校验到可见工具集合中；重复和缺失会产生 diagnostic。

Pi coding-agent 当前是 definition-first：built-in tools、custom tools 和 extension tools 最终都变成 `ToolDefinition`，再 wrap 成 Pi `AgentTool`。它的 extension runner 对同名 extension tool 采用 first registration wins，最终合成时 extension/custom tool 可以覆盖 built-in。WIDI 参考了这个 definition-first 结构，但用显式 `define`/`patch` contribution 替代裸 Map 覆盖，以便支持更强 diagnostics 和 extension 注入。

## Extension

Extension 可以注册 tool，也可以通过 hook 影响 tool 可用性。但 tool 是否进入某个 agent harness，应由 orchestrator/tool registry 基于 profile 和 policy 决定。

Extension 对既有 tool 的修改必须经过 Tool Registry。

Tool Registry 应把 tool 输入视为贡献集合，而不是裸数组：

- `define` contribution 新增一个 tool。
- `patch` contribution 以 tool name 为目标修改既有 tool。
- patch 可以替换 metadata、prompt snippet、argument preparation、execution env requirement、state reducer 或 execute。
- patch 也可以通过 `aroundExecute` 包装既有 execute，用于审计、重写参数、转发到 sandbox、替换文件写入 backend 等。
- 多个 patch 按来源、priority 和 policy 合成，冲突应产生 diagnostic。

例如，extension 修改 built-in `write` tool 不应直接改 registry 中的 write 对象。它应注册一个针对 `write` 的 patch：轻量场景用 `aroundExecute` 包住原始写入；完整替换场景用 `execute` 替换行为。最终暴露给 `AgentHarness` 的仍是名为 `write` 的 resolved tool，active tool names 和 session resume 才能保持稳定。

Tool tracking 也属于这种轻量 wrapper 场景。它不应进入 core tool definition 或 registry adapter；需要记录 tool run 时，extension 可以用 `aroundExecute` 包装目标 tool，并自行决定记录字段、保留期限和暴露方式。`apps/widi-pi/examples/tool-tracker-extension.ts` 是这个方向的示范骨架。

## Tool State

WIDI tool definition 不直接依赖 UI。Tool call streaming、arguments ready、execution update、result 和 error 都应先归入 tool state。TUI、RPC、HTML export 或其他 adapter 消费这个 state 并落实展示。

这保留 Pi coding-agent 的流式 tool UI 能力，同时避免 tool registry 直接依赖某个 UI 实现。

## Tool Result Persistence

Core built-in tools 的可恢复数据应优先参考 Pi coding-agent：tool call arguments、tool result `content` 和 typed `details` 共同构成可恢复上下文。比如 `write` 的正文来自 tool call arguments，成功结果只需要短文本和 `details.path`；`read` 的内容进入 tool result `content`，截断信息进入 `details`；`edit` 可以把 patch/diff/first changed line 放进 `details`。

Tool Registry 不提供 session persistence facade，也不把 Pi `custom` entry 包装成 core tool state API。Registry 只负责解析 `ToolDefinition` contribution，并把 resolved tool wrap 成 Pi `AgentTool`。

Pi `custom` entry 仍是 session tree 的一部分，但 WIDI core 不解释它、不把它作为 built-in tool 的状态通道。未来 extension runner 可以暴露 extension-owned custom entry API；数据 shape、恢复策略、branch/fork/compaction/export policy 都应由 extension API 明确定义。

Tool tracking、审计和 checkpoint 更适合作为 extension pattern：用 `aroundExecute` 观察 tool run，必要时把摘要写入 tool result `details`、extension-owned storage，或未来 extension-owned custom entry。Core 不提供共享的 tool/session state 层。

## 非职责

- 不把 tools 当作裸数组长期透传。
- 不让 profile 直接持有 runtime tool instance。
- 不让 extension 绕过 tool registry 向 harness 注入不可诊断工具。
- 不把 tool visibility 当成 profile capability。
- 不让 extension 直接修改 built-in tool 对象或绕过 resolved tool pipeline。
- 不为 built-in tool 引入绕过 Pi `AgentHarness` 标准 tool call/result/history 的持久化通道。

## TODO

- [ ] 列出 core capabilities，并标记哪些需要 built-in tool adapter。
- [ ] 定义 built-in tool 的命名、可见性和 diagnostics 规则。
- [x] 设计 tool registry 的来源优先级、冲突处理和 availability 诊断。
- [x] 定义 `define`/`patch` tool contribution 的合成顺序、冲突策略和 diagnostics。
- [x] 将 tool human request 能力收敛为 `context.human.request(...)`。
- [ ] 为 built-in tool wrapper 增加示例，先覆盖 `write` 的 sandbox/backend 替换场景，并采用 Pi 风格 tool call/result/details 持久化。
- [ ] 定义 extension-owned custom entry API：append/read 权限、branch scope、fork、compaction、export、debug view 和 diagnostics。
- [ ] 定义 Profile Capability 到 Tool Visibility 和 runtime policy 的映射。
- [x] 移除 create/resume raw `AgentTool[]` 输入；AgentTool 只由 ToolRegistry resolve 后的 ToolDefinition wrap 产生。
- [x] 校验 resume/runtime active tool names 与当前 registry 解析结果的一致性。
