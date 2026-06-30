# WIDI Pi 核心设计

本文档定义 `widi-pi` 的核心设计边界。它不是实现清单，也不讨论具体类型字段、配置属性或 API 参数形状。具体机制的理念拆分在 `docs/core/` 下，后续实现细节再进入对应模块文档或 ADR。

## 定位

`widi-pi` 是一个基于 Pi `AgentHarness` 的原生 multi-agent harness 应用。

Pi 的 `AgentHarness` 负责单个 agent 的模型交互、session tree、resources、tools 与 stream lifecycle。`widi-pi` 在其上增加 multi-agent runtime：它管理多个 harness 的生命周期、profile、session、resource、model/auth、agent 间通信、agent-human 交互，以及 extension 对这些能力的组合。

核心目标：

- 保留 Pi `AgentHarness` 的单 agent 能力，而不是重写 harness。
- 把 multi-agent 编排作为一等能力，而不是外部脚本或子进程技巧。
- 让 shell/runtime 能力通过 `ExecutionEnv` 明确受控。
- 让 profile、resources、tools、extensions 都成为可声明、可恢复、可诊断的 runtime dependency。
- 允许 extension 组合 core 能力实现 `/team`、`/flow`、`/goal`、MCP、sandbox 等复杂产品模式。

## 非目标

当前阶段不追求这些事情：

- 不修改 `pi/*` 上游/vendor 代码。
- 不把 extension 做成绕过 orchestrator 的旁路系统。
- 不把 multi-agent 仅实现为多个独立进程之间的松散调用。
- 不在 session metadata 中保存大型快照、API key、runtime 对象或 extension 实例。
- 不先承诺最终 UI、RPC、TUI 命令形态。
- 不把具体产品交互模式作为 core primitive；它们应基于 orchestrator command/client 能力由 extension 或 preset 实现。

## 核心边界

`AgentHarness` 是单 agent 执行内核。它不应该直接知道 multi-agent 编排、profile registry、extension registry 或其他 agent 的生命周期。

`AgentOrchestrator` 是 runtime coordinator。它负责通过 profile、resources、tools、sessions、models 与 extensions 组装和管理多个 harness，并把跨 agent 的事情放到可观察、可诊断的主路径上。

`AgentProfile` 是 agent 的声明式配置，不是 agent 实例。同一个 profile 可以创建多个 agent。agent 的运行时身份由 `AgentId` 表示。

`ResourceLoader`、profile registry、extension registry、tool registry、model registry、auth storage 都属于 runtime dependency layer。它们解析依赖，但不拥有 agent lifecycle。

Orchestrator command/client 是 core 的受控操作入口和输出 fanout 语义。A2A 与 human-request 都应经过 `AgentOrchestrator`，但不引入独立通信层。具体产品交互模式不进入 core；它们应作为 extension 或 coding-agent 组配集合实现。

Extension 具备接近 orchestrator 的能力：core 执行每个关键能力时，都应允许 extension 通过 hook 观察、拦截、补充或改写，就像 Pi coding-agent extension 一样。但 extension 不能直接接管已经存储好的 profile、session 或 resource registry；它必须通过 orchestrator 暴露的受控入口参与 runtime。

## Human Request

`human-request` 是 orchestrator 的结构化人机请求能力。它目标为 human-facing client，可能等待 human response。

`human-request` 的响应通常不进入 agent session。只有当它作为 tool call 的结果发生时，才自然进入 Pi session tree；这时它已经是 tool message，不需要 core 额外管理 session 写入。

因此 human-request 的核心重点是路由、等待、取消、超时与 UI/RPC 呈现，不是 session 管理。

## Extension 自由度

Pi coding-agent 的 extension 已经可以注册 tool/command/provider、拦截 input/tool/system prompt/provider request、发起 UI 交互、写扩展状态、定制渲染并触发 session 操作。WIDI extension 应该至少具备同等级自由度，并额外支持 multi-agent 编排。

区别在于：WIDI 的跨 agent 能力必须经过 orchestrator command/helper 和 diagnostics。extension 可以定义 team/flow/goal 等模式，但不能私下维护不可观察的 agent lifecycle 或 A2A 通信。

在 core 构建完成后，`widi-pi` 可以首先提供一个 coding-agent 组配集合：默认 profile、默认 tools、预装 extensions 与 adapter 组合成具体产品体验。具体 team、flow 或 goal 模式属于这个层级。

## 推荐分层

1. Harness layer

   单个 Pi `AgentHarness`，保持上游语义。

2. Runtime dependency layer

   profile registry、resource loader、extension registry、tool registry、model registry、auth storage。

3. Orchestration layer

   agent lifecycle、session lifecycle、command dispatch、client fanout、diagnostics、agent-human request、A2A。

4. Application adapter layer

   TUI、RPC、CLI、extension commands、外部 transport、coding-agent preset。

## Core 文档

- [下一阶段 TODO](TODO.md)
- [Orchestrator](core/orchestrator.md)
- [Orchestrator Commands](core/orchestrator-commands.md)
- [Extensions](core/extensions.md)
- [Profiles And Resources](core/profiles-and-resources.md)
- [Tools And Capabilities](core/tools-and-capabilities.md)
- [Diagnostics](core/diagnostics.md)
- [Sessions And Runtime](core/sessions-and-runtime.md)
- [Pi Upstream Roadmap](core/pi-upstream-roadmap.md)

这些文档只记录核心理念，不定义最终 API。
