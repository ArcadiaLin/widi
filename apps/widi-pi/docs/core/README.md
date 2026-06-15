# Core 机制

本目录拆分记录 `widi-pi` 的 core 机制理念。这里不定义最终类型字段、配置属性或 API 参数，只约束每个机制为什么存在、负责什么、不负责什么。

核心机制包括：

- `orchestrator`：multi-agent runtime coordinator。
- `channels`：agent、human、extension、external transport 之间的通信语义。
- `extensions`：通过 hook 插入 core 能力的扩展系统。
- `profiles and resources`：声明式 agent 配置与依赖解析。
- `tools and capabilities`：tool 可见性、能力声明与 runtime policy。
- `diagnostics`：profile、dependency、runtime 问题的结构化输出。
- `sessions and runtime`：Pi session、ExecutionEnv、model/auth 的边界。

这些机制共同目标是：让 multi-agent 编排可观察、可恢复、可诊断，同时保持 Pi `AgentHarness` 的单 agent 语义不被污染。
