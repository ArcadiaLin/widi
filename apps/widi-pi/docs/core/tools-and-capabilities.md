# Tools And Capabilities

Tools 是 agent 可调用能力。Capabilities 是 profile 与 tool/runtime policy 之间的连接层。

## 核心理念

Tool registry 定义工具。

Profile 不定义 tool 本身。Profile 只声明哪些 tool 对当前 harness 可用、可见或受限。具体 tool 来自 core、extension 或 runtime adapter。

`profile.tools` 只处理可见性。

它回答的问题是：某个 tool 是否加入当前 `AgentHarness`，是否对模型可见。它不表达更高层产品能力，也不替代 capabilities。

Capabilities 连接 profile 与 policy。

Profile 用 capabilities 表达 agent 被允许做什么。Tool registry 和 runtime policy 根据 capabilities、ExecutionEnv、extension 和 adapter 状态，决定最终暴露哪些 tools。

## Extension

Extension 可以注册 tool，也可以通过 hook 影响 tool 可用性。但 tool 是否进入某个 agent harness，应由 orchestrator/tool registry 基于 profile 和 policy 决定。

## 非职责

- 不把 tools 当作裸数组长期透传。
- 不让 profile 直接持有 runtime tool instance。
- 不让 extension 绕过 tool registry 向 harness 注入不可诊断工具。
