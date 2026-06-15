# Orchestrator

`AgentOrchestrator` 是 `widi-pi` 的 runtime coordinator。它不是单个 agent 的实现，也不是 UI/RPC adapter，而是把 profile、session、resources、tools、models、extensions 与 channels 组合成可运行 agent runtime 的中心。

## 核心理念

Orchestrator 拥有 agent lifecycle。

它负责创建、恢复、缓存、暂停、唤醒或标记 agent 状态。单个 `AgentHarness` 不应该知道其他 agent，也不应该直接创建兄弟或子 agent。

Orchestrator 负责跨 agent 可观察性。

所有 A2A、human-request、extension 插入、resource 缺失、profile fallback 和 runtime 降级，都应通过 orchestrator 的事件或 diagnostics 暴露，而不是隐藏在 extension 或 tool 的私有状态中。

Orchestrator 不直接解析文件。

Profile、resource、extension、tool、model/auth 都应该由对应 registry/loader 解析。Orchestrator 调用它们、汇总结果，并根据 policy 决定继续、失败或降级。

## Extension 插入

Orchestrator 执行每个 core 能力时，都应允许 extension 通过 hook 插入：

- agent 创建与恢复前后。
- profile 解析后、harness 创建前。
- resources/tools/extensions 解析后。
- channel message 投递前后。
- model/auth/runtime action 前后。
- diagnostics 产生时。

这种插入能力应接近 Pi coding-agent extension 的自由度，但所有跨 agent 动作必须回到 orchestrator 主路径。

## 非职责

- 不拥有具体 UI 呈现。
- 不直接解析 markdown/profile/resource 文件。
- 不把 extension 私有状态当作 core state。
- 不把 mailbox/team 固化为 core primitive。
