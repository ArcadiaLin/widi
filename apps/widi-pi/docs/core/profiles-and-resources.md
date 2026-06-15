# Profiles And Resources

Profile 是 agent 的声明式配置。Resource 是 profile 声明或 runtime policy 需要加载的外部依赖。

## 核心理念

Profile 不是 agent 实例。

同一个 profile 可以创建多个 agent。agent 的运行时身份由 orchestrator 分配和管理。Profile 只是构建 agent runtime 的输入。

Profile 应可解析、可恢复、可诊断。

持久 session 只需要保存 profile reference。恢复时，core 用当前 profile registry 重新解析 profile，再构建 harness。这样可以让 profile 随配置演进，但也要求缺失、冲突和 fallback 都有清晰 diagnostics。

Resources 是 dependency，不是 profile 内容。

Skills、prompt templates、extension 依赖和工具可见性都应作为 dependency 被解析。解析结果应包含来源和 diagnostics，让 orchestrator 决定继续、降级或失败。

Duplicate resource 报错。

Core 不做静默覆盖或隐式合并。重复资源应产生明确 diagnostic，避免同名 skill/template/profile 在不同来源之间制造不可解释行为。

## 临时 Profile 覆盖

持久 agent 不允许使用临时 profile 覆盖。需要 resume 的差异必须进入正式 profile 或其他持久化声明。

临时 agent 是否允许 override 可以另行设计，但不能污染持久恢复语义。

## 非职责

- Profile 不直接实例化 tools/extensions/runtime。
- Resource loader 不拥有 agent lifecycle。
- Extension 不直接处理已存储 profile。
