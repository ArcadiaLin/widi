# WIDI Pi 核心设计

本文档定义 `widi-pi` 的核心设计边界。它不是实现清单，也不讨论具体类型字段、配置属性或 API 参数形状。具体机制的理念拆分在 `docs/core/` 下，后续实现细节再进入对应模块文档或 ADR。

## 定位

`widi-pi` 是一个基于 Pi `AgentHarness` 的原生 multi-agent harness 应用。

Pi 的 `AgentHarness` 负责单个 agent 的模型交互、session tree、resources、tools 与 stream lifecycle。`widi-pi` 在其上增加 multi-agent runtime：它管理多个 harness 的生命周期、profile、session、resource、model/auth、agent 间通信、agent-human 交互，以及 extension 对这些能力的组合。

核心目标：

- 保留 Pi `AgentHarness` 的单 agent 能力，而不是重写 harness。
- 把 multi-agent 编排作为一等能力，而不是外部脚本或子进程技巧。
- 让 shell/runtime 能力通过 `ExecutionEnv` 明确受控；`ExecutionEnv` 是核心运行环境边界，不等同于具体 tool 实现。
- 让 profile、resources、tools、extensions 都成为可声明、可恢复、可诊断的 runtime dependency。
- 允许 extension 组合 core 能力实现 `/team`、`/flow`、`/goal`、MCP、sandbox 等复杂产品模式。

## 当前阶段

当前阶段的主要成果是把 WIDI 的 core runtime 底座从单个 agent harness 外围逻辑，推进为可组合、可诊断的 multi-agent runtime：

- runtime composition 已能组合 settings、profile、resources、model/auth、session、tool registry、extension loader 和 orchestrator。
- agent record/lifecycle 已替代直接持有 `AgentHarness` 的简单 map，承载 status、profile、session、tools、extensions 和 diagnostics。
- extension loader/runner 已具备注册 tool、patch tool、observe/intercept、session-local custom entry、reload 和 inspect facts 的 MVP。
- client fanout 与 human-request 已形成 orchestrator 的受控输出语义；command 层实验已裁决——trigger-based command input 是 orchestrator 自身的 input 能力，独立 command runtime 不再存在（收编进行中，见 [Command Experiment](core/command-experiment.md)）。
- coding tools 与 agent collaboration tools 进入设计落地阶段，通过 tool registry/orchestrator 主路径接入。

这些成果的目的不是立即固定产品形态，而是提供一次可审核的 core 边界：哪些能力属于 runtime core，哪些能力属于 extension、adapter、preset 或未来发行版。

## 核心议题与裁决

以下方向经历过实验或争论，当前状态如下。

### Command（已裁决）

Command 曾作为可选 core runtime 实验：用 typed `CommandRequest` union 描述 human/client-facing capability。架构 review（2026-07-03）证明该形态失败——它是 orchestrator 的伪可选硬依赖，且两个入口事件语义分叉。

裁决：command 收回 orchestrator，core 中的 "command" 一词只指 input-triggered command——orchestrator 内置的 human input 协议（trigger 解析、门控、参数补全、事件轨道）。programmatic consumer 直接调用 orchestrator 原子方法，不经过任何 command 包装。typed union、`dispatch()` 与旧 `Command` 类删除。完整裁决、事件语义与迁移计划见 [Command Experiment](core/command-experiment.md)。

### Agent Collaboration（M3 落地）

即使 extension 可以组合出复杂工作流，core 仍需要为 agent 协作准备一组基础工具和语义：spawn、prompt、wait、status（handoff 语义未定义，暂不做）。它们不直接持有 raw harness，而是以 core tools 形态注册进 ToolRegistry，execute 通过 orchestrator 的 collaboration facade 实现，并由 profile `capabilities.canSpawn` 门控可见性。

这保证多 agent 协作不是松散的外部脚本调用，而是可观察、可恢复、可诊断的 runtime 能力。

### Coding Tools（已裁决）

WIDI 需要让 agent 具备真实运行环境中的读、写、编辑、搜索和命令执行能力；这些能力构成 coding-agent 产品的基础，也让 agent 能够管理文件形式的 skill、prompt、profile 和 workspace state。

裁决：coding tools（read/write/edit/bash/grep/find/ls）是 **core built-in tools**，以 `source: core` 注册进 ToolRegistry，实现尽量复刻 pi-coding-agent 的工具语义与 result 形态（arguments/content/typed details）。理由：skill、prompt、profile 都是文件形态资源，read 是 runtime 自身依赖（`/skill` 的展开产物指引模型用 read 加载 skill 正文）；有读则写/编辑顺带。曾经的 "extension-contributed" 结论撤销——extension 的组合自由不受影响，它仍可通过 `patchTool` 改写任一 built-in tool 的 backend（sandbox、远程、审计包装），这正是 ToolRegistry patch 管道存在的意义。未来按产品事实再评估 built-in 集合的裁减。

## 未来规划

完成 core runtime 后，WIDI 的第一条产品演化路径应是原生 multi-agent coding-agent：它不是单 agent coding harness 加子进程技巧，而是以 orchestrator、extension、tool registry 和 agent collaboration 为基础的 multi-agent 编程环境。

实现这个方向时，发行版层需要认真设计 coding-agent 专用工具。调研现有 coding agent 产品后，一个明显结论是：不同产品的优势往往来自它们为 agent 编程流程定义的工具集合、交互策略和恢复策略。因此 WIDI core 只提供可组合底座，具体产品能力应在 preset、extension 和 adapter 中沉淀。

其他方向也应主要通过 extension 演化。例如：

- 长期记忆模块。
- MCP、sandbox 或外部服务 connector。
- 数据治理 agent：由主 agent 调度子 agent 作为数据工人，逐步识别重复工作模式，并把稳定流程固化为更原子、确定的调用单元，而不是继续依赖不确定的 ReAct 循环。

这些方向要求 extension 不只是注册工具，还能观察、编排、记录状态、触发 agent 协作，并把诊断事实回到 orchestrator 主路径。

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

Orchestrator 的原子方法是 core 唯一的 capability 事实；client fanout 是受控输出语义；command input 是 orchestrator 内置的 human input 协议。跨 agent 协作与 human-request 都应经过 `AgentOrchestrator`，但不引入独立通信层。具体产品交互模式不进入 core；它们应作为 extension 或 coding-agent 组配集合实现。

Extension 具备接近 orchestrator 的能力：core 执行每个关键能力时，都应允许 extension 通过 hook 观察、拦截、补充或改写，就像 Pi coding-agent extension 一样。但 extension 不能直接接管已经存储好的 profile、session 或 resource registry；它必须通过 orchestrator 暴露的受控入口参与 runtime。

## Human Request

`human-request` 是 orchestrator 的结构化人机请求能力。它目标为 human-facing client，可能等待 human response。

`human-request` 的响应通常不进入 agent session。只有当它作为 tool call 的结果发生时，才自然进入 Pi session tree；这时它已经是 tool message，不需要 core 额外管理 session 写入。

因此 human-request 的核心重点是路由、等待、取消、超时与 UI/RPC 呈现，不是 session 管理。

## Extension 自由度

Pi coding-agent 的 extension 已经可以注册 tool/command/provider、拦截 input/tool/system prompt/provider request、发起 UI 交互、写扩展状态、定制渲染并触发 session 操作。WIDI extension 应该至少具备同等级自由度，并额外支持 multi-agent 编排。

区别在于：WIDI 的跨 agent 能力必须经过 orchestrator command/helper 和 diagnostics。extension 可以定义 team/flow/goal 等模式，但不能私下维护不可观察的 agent lifecycle 或跨 agent 通信。

在 core 构建完成后，`widi-pi` 可以首先提供一个 coding-agent 组配集合：默认 profile、默认 tools、预装 extensions 与 adapter 组合成具体产品体验。具体 team、flow 或 goal 模式属于这个层级。

## 推荐分层

1. Harness layer

   单个 Pi `AgentHarness`，保持上游语义。

2. Runtime dependency layer

   profile registry、resource loader、extension registry、tool registry、model registry、auth storage。

3. Orchestration layer

   agent lifecycle、session lifecycle、command input 执行、client fanout、diagnostics、agent-human request、跨 agent 协作。

4. Application adapter layer

   TUI、RPC、CLI、extension commands、外部 transport、coding-agent preset。

## Core 文档

- [Milestones](TODO.md)
- [Backlog](BACKLOG.md)
- [Orchestrator](core/orchestrator.md)
- [Runtime Lifecycle](core/runtime-lifecycle.md)
- [Command Experiment](core/command-experiment.md)
- [Extensions](core/extensions.md)
- [Profiles And Resources](core/profiles-and-resources.md)
- [Tools And Capabilities](core/tools-and-capabilities.md)
- [Diagnostics](core/diagnostics.md)
- [Sessions And Runtime](core/sessions-and-runtime.md)
- [Pi Upstream Roadmap](core/pi-upstream-roadmap.md)

这些文档只记录核心理念，不定义最终 API。
