# Core 机制

本目录拆分记录 `widi-pi` 的 core 机制理念。这里不定义最终类型字段、配置属性或 API 参数，只约束每个机制为什么存在、负责什么、不负责什么。

核心术语以仓库根目录的 `CONTEXT.md` 为准。分文档可以展开机制边界，但不应重新定义 glossary 中已经定下来的词。

核心机制包括：

- `TODO`：milestone 序列与验收标准，位于 [`../TODO.md`](../TODO.md)；非当前 milestone 条目见 [`../BACKLOG.md`](../BACKLOG.md)。
- `orchestrator`：multi-agent runtime coordinator。
- `runtime modules`：`src/core/` 直属 runtime modules 的组织规则，特别是共享 `core/types.ts` 与 owner-local types 的边界。
- `runtime lifecycle`：runtime 模块顺序、agent 创建/恢复、事件传递、extension 执行点和持久化边界。
- `command experiment`：command 独立 runtime 实验的裁决记录与 trigger-based command input 设计（registry、事件、门控、inline、参数补全、迁移计划）。
- `extensions`：通过 hook 插入 core 能力的扩展系统。
- `profiles and resources`：声明式 agent 配置与依赖解析。
- `tools and capabilities`：tool 可见性、能力声明、registry patch、raw harness events 与 runtime policy。
- `diagnostics`：profile、dependency、runtime 问题的结构化输出。
- `sessions and runtime`：Pi session、ExecutionEnv、model/auth 与 settings 的边界。
- `pi upstream roadmap`：需要回到 Pi 上游沉淀的底层原语。

这些机制共同目标是：让 multi-agent 编排可观察、可恢复、可诊断，同时保持 Pi `AgentHarness` 的单 agent 语义不被污染。

Core 不是产品交互模式集合。`/team`、`/flow`、`/goal` 等能力可以由 preset 或 extension 组合出来，但不作为 core primitive。Core 也不引入通用多 session storage；多 session 的关系和持久化由 extension 或 preset 自己管理。

## TODO

Core 后续任务按 milestone 维护在 [Milestones](../TODO.md)，非当前 milestone 条目在 [Backlog](../BACKLOG.md)。本目录内的分文档只记录机制边界和当前事实；任何"不让 X 做 Y"的边界宣言必须附代码锚点，否则属于设计愿望，应写入 BACKLOG 而非机制文档。
