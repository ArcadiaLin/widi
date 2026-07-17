# WIDI Pi 核心设计

本文定义 `widi-pi` 的产品定位、架构分层和长期边界。具体机制由 [`core/`](core/) 下的文档说明，近期工作见 [Milestones](TODO.md)。

## 定位

`widi-pi` 是基于 Pi `AgentHarness` 的原生 multi-agent coding harness。

Pi `AgentHarness` 负责单个 agent 的模型交互、session tree、resources、tools 与 stream lifecycle。WIDI 在其上管理多个 agent 的 profile、session、resource、model/auth、运行状态、人机交互和 extension，并让跨 agent 行为回到统一、可观察的 runtime 主路径。

核心目标：

- 保留 Pi 的单 agent 语义，不重写 harness。
- 把 multi-agent 协作建设为 core runtime 能力，而不是外部脚本或子进程技巧。
- 让 profile、resources、tools、extensions 和 model/auth 都成为可解析、可恢复、可诊断的 runtime dependency。
- 通过 `ExecutionEnv` 等明确边界注入 filesystem、shell、sandbox 或远程运行能力。
- 允许 extension 组合 core 能力形成 team、flow、goal、MCP、sandbox 等产品模式。

## 架构分层

1. Harness layer

   单个 Pi `AgentHarness`，负责 agent loop、model/tool execution、queue 和 session tree。

2. Runtime dependency layer

   settings、profile registry、resource loader、session manager、tool registry、extension loader、model registry 与 auth storage。它们解析依赖并产生 diagnostics，但不拥有 agent lifecycle。

3. Orchestration layer

   `AgentOrchestrator` 组装 agent runtime，管理 lifecycle、文本输入、client fanout、human request、diagnostic publish 和跨 agent 协作。

4. Application layer

   CLI、TUI、RPC、product preset 与 client-side extension host。该层负责具体交互和呈现；`src/commands/` 的 `CommandEngine` 也属于这一层，不反向拥有 core state。

## 核心所有权

Agent 是 WIDI runtime entity，不等同于 `AgentHarness`。`AgentId` 是 runtime-local identity；profile 是声明式构建输入；session 是单 agent 历史；extension instance 是随 agent 生命周期存在的 runtime state。

`AgentOrchestrator` 是 agent lifecycle 的唯一 owner。Adapter、tool 和 extension 不直接持有 agents map 或创建 sibling/child harness；它们通过原子方法、scoped actions 或 collaboration facade 使用能力。

Core state 由对应 owner 管理：

- profile registry 拥有 profile identity、priority 和解析语义。
- resource loader 拥有 skill 与 prompt template 的文件读取和解释。
- ToolRegistry 拥有 tool registration、patch、visibility 和最终 adapter。
- SessionManager 协调 Pi session repo，但不重新定义 session entry。
- ModelRegistry/AuthStorage 组合 pi-ai runtime 与 WIDI 配置、凭据边界。
- ExtensionLoader/Runner 管理发现、激活、reload、贡献和 stale context。

## 已稳定的关键裁决

### 交互命令与文本输入

Programmatic consumer 直接调用 orchestrator 原子方法。人类输入中的 line/inline command 由共享交互层 `src/commands/` 的 `CommandEngine` 解析、补全和执行；CLI 与 TUI 消费同一引擎。Core 不感知 command，也不维护 command parser、policy、事件或扩展注册。

`promptAgent` 是 core 唯一文本输入入口。它始终执行 extension `input` interception；交互层完成 inline expansion 后把 expansion 记录随 prompt 交给 core，由 core 以既有 session custom entry 格式持久化，再把模型可见文本交给 Pi harness。

### Coding tools

`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls` 是 core built-in tools，由 ToolRegistry 统一解析。Extension 可以用 `patchTool` 包装或替换 backend，但不绕过 registry 修改 runtime object。

### Extension

Extension 作者契约冻结为 API v1。Extension 可以注册或 patch tool、贡献 resources/provider、观察或拦截 runtime、调用 own-agent scoped actions，并使用 namespaced session custom entry 保存小型 session-local 状态。Extension 保留这些被动能力，不注册交互命令；未来主动入口由前端 `/extension` 一类命令另行设计。UI 渲染、命令和快捷键属于 client adapter。

### Session 与持久化

WIDI 沿用 Pi session tree。Session body 保存 harness 运行产物，不保存 agent lifecycle、pending human request 或 extension instance。持久 session metadata 只保存恢复所需的小型 reference。当前 persistence 明确支持单进程写入，多进程锁属于上游能力缺口。

### Auto-compaction

Orchestrator 在 harness `settled` 后按 context threshold 触发自动 compaction；失败发布 warning diagnostic，不改变原有运行语义。实际保留 token 数仍受 Pi `AgentHarness.compact()` 的上游设置边界约束，见 [Pi Upstream Roadmap](core/pi-upstream-roadmap.md) 的 compaction settings passthrough 条目。

## 非目标

- 不修改 `pi/*` vendor 代码来隐藏 WIDI 自身边界问题。
- 不让 extension 成为绕过 orchestrator 的旁路系统。
- 不把产品交互模式固化为 core primitive。
- 不在 session metadata 中保存 secrets、大型资源正文、runtime object 或函数。
- 不提前承诺具体 TUI、RPC 或 product preset 形态。
- 不为没有真实 consumer 的能力预建 registry、协议或兼容层。

## 延伸阅读

- [Runtime](core/runtime.md)
- [Extensions](core/extensions.md)
- [Profiles And Resources](core/profiles-and-resources.md)
- [Sessions And Runtime](core/sessions-and-runtime.md)
- [Tools And Capabilities](core/tools-and-capabilities.md)
- [Diagnostics](core/diagnostics.md)
