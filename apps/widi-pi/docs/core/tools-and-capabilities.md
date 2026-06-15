# Tools And Capabilities

Tools 是 agent 可调用入口。Core Capability 是 core 原生 runtime 能力。Profile Capability 是 profile 与 tool/runtime/channel policy 之间的连接层。

## 核心理念

Core Capability 不是 Tool。

Core Capability 是 core 原生提供、可通过受控 API 调用的 runtime 能力，例如创建 agent、发送 channel message、request human、解析 profile、加载 resource 或发出 diagnostic。

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

## Extension

Extension 可以注册 tool，也可以通过 hook 影响 tool 可用性。但 tool 是否进入某个 agent harness，应由 orchestrator/tool registry 基于 profile 和 policy 决定。

## 非职责

- 不把 tools 当作裸数组长期透传。
- 不让 profile 直接持有 runtime tool instance。
- 不让 extension 绕过 tool registry 向 harness 注入不可诊断工具。
- 不把 tool visibility 当成 profile capability。

## TODO

- [ ] 列出 core capabilities，并标记哪些需要 built-in tool adapter。
- [ ] 定义 built-in tool 的命名、可见性和 diagnostics 规则。
- [ ] 设计 tool registry 的来源优先级、冲突处理和 availability 诊断。
- [ ] 定义 Profile Capability 到 Tool Visibility 和 runtime policy 的映射。
- [ ] 将 `SpawnAgentHarnessOptions.tools` 收敛到 tool registry 或明确为测试/adapter escape hatch。
- [ ] 校验 resume 时 active tool names 与当前 registry 解析结果的一致性。
