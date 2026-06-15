# Orchestrator

`AgentOrchestrator` 是 `widi-pi` 的 runtime coordinator。它不是单个 agent 的实现，也不是 UI/RPC adapter，而是把 profile、session、resources、tools、models、extensions 与 channels 组合成可运行 agent runtime 的中心。

## 核心理念

Agent 不是 AgentHarness。

Agent 是 WIDI runtime entity，由 `AgentId` 标识，并由 profile、Pi `AgentHarness`、session、model state、resolved dependencies 和 runtime status 共同构成。当前实现中 `Map<AgentId, AgentHarness>` 只是早期压缩表达，长期概念上不能把二者等同。

AgentId 是 runtime-local identity。

`AgentId` 可以被持久 session 作为 recovery reference 或 session id 使用，但它不是全局主键，也不是 `ProfileId`。

Orchestrator 拥有 agent lifecycle。

它负责创建、恢复、缓存、暂停、唤醒、更新、dispose 或标记 agent 状态。单个 `AgentHarness` 不应该知道其他 agent，也不应该直接创建兄弟或子 agent。

Unavailable 是 agent 状态。

当已知 agent 因 profile/resource/extension/model/auth/runtime boundary 缺失或失败而不能运行时，应标记为 `unavailable` 并保留 diagnostics。它不是所有创建失败的同义词；主 agent 创建失败仍可以直接让 capability 失败。

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
- 不把具体产品交互模式固化为 core primitive。
- 不拥有 extension/preset 的多 session 存储和产品模式关系。

## TODO

- [ ] 将 `agents: Map<AgentId, AgentHarness>` 收敛为能表达 runtime status、diagnostics、resolved dependencies 的 agent record。
- [ ] 定义 agent lifecycle capability：create、resume、mark unavailable、dispose、update model/tools/resources。
- [ ] 将 resume profile 缺失从默认 fallback 改为 policy-driven diagnostic path。
- [ ] 为 unavailable agent 增加事件和 diagnostics，覆盖 subagent 恢复失败场景。
- [ ] 明确 extension hook 在每个 lifecycle 阶段的 observe/intercept/mutate/invoke capability 权限。
