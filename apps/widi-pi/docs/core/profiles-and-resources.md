# Profiles And Resources

Profile 是 agent 的声明式配置。Resource 是 profile 声明或 runtime policy 需要加载的外部依赖。

## 核心理念

Profile 不是 agent 实例。

同一个 profile 可以创建多个 agent。agent 的运行时身份由 orchestrator 分配和管理。Profile 只是构建 agent runtime 的输入。

ProfileId 是声明身份。

`ProfileId` 用于 profile registry lookup、recovery reference 和 diagnostics。它不是文件名，也不是 `AgentId`。文件名只能作为 loader 的发现路径或默认 id 来源。

DefaultProfile 是调用层输入。

`DefaultProfile` 可以用于创建新 agent 时未显式指定 profile 的默认输入，但不是 resume profile 缺失时的自动 fallback。缺失 profile 的 fallback、失败、用户选择或 unavailable 都应由 caller policy 决定。

Profile 应可解析、可恢复、可诊断。

持久 session 只需要保存 profile reference。恢复时，core 用当前 profile registry 重新解析 profile，再构建 harness。这样可以让 profile 随配置演进，但也要求缺失、冲突和 fallback 都有清晰 diagnostics。

Profile registry 拥有索引语义。

Profile loader 负责读取和解析 profile 文件。Profile registry 负责按 `ProfileId` 建索引，处理 source priority、冲突、validation 和 diagnostics。

Resources 是 dependency，不是 profile 内容。

Skills、prompt templates、extension 依赖和工具可见性都应作为 dependency 被解析。解析结果应包含来源和 diagnostics，让 orchestrator 决定继续、降级或失败。

Resource loader 和 resource registry 分工不同。

Resource loader 负责从具体来源读取/解析 resource declaration。Resource registry 负责按 identity 组织 resources，处理 duplicate、priority、source 和 validation diagnostics。

Harness resources 是 resource 子集。

传给 Pi `AgentHarness.resources` 的 skills、prompt templates 等是 resolved harness resources。不是所有 dependencies 都是 harness resources，tools、extensions、models/auth 和 runtime adapters 也属于 dependency resolution。

Duplicate resource 报错。

Core 不做静默覆盖或隐式合并。重复资源应产生明确 diagnostic，避免同名 skill/template/profile 在不同来源之间制造不可解释行为。

## 临时 Profile 覆盖

持久 agent 不允许使用临时 profile 覆盖。需要 resume 的差异必须进入正式 profile 或其他持久化声明。

临时 agent 可以允许 profile override，但它只作为一次性 runtime assembly 输入。override 仍然必须走 diagnostics，不能污染持久恢复语义。

## 非职责

- Profile 不直接实例化 tools/extensions/runtime。
- Resource loader 不拥有 agent lifecycle。
- Extension 不直接处理已存储 profile。
- Session metadata 不保存 profile snapshot 或大型 resource 内容。

## TODO

- [ ] 引入 profile registry，按 `ProfileId` 解析 sourced profile 并产生 diagnostics。
- [ ] 定义 profile id 与文件名不一致时的索引和 diagnostic 规则。
- [ ] 将 resume profile 缺失改为 policy-driven diagnostic，不默认 fallback 到 `DefaultProfile`。
- [ ] 定义 persistent/ephemeral agent 对 profile override 的校验路径。
- [ ] 引入 resource registry，处理 duplicate、priority、source 和 validation diagnostics。
- [ ] 区分 explicit resource missing、default directory missing、parse failed、duplicate identity。
- [ ] 定义哪些 resolved resources 会变成 Pi harness resources。
