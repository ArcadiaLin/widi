# Profile Orchestration 设计

本文记录 `AgentOrchestrator` 如何使用 `AgentProfile`，以及 profile、resources、extensions 与 diagnostics 在后续需要补齐的边界。

## 当前状态

`AgentProfile` 当前是创建 `AgentHarness` 的声明式配置：

- `id`、`label` 用于 profile 引用、session metadata 和 agent id 分配。
- `systemPrompt` 直接传给 `AgentHarness`。
- `persist` 由 `SessionManager.createAgentSession()` 用来选择 JSONL session 或 in-memory session。
- `skills`、`promptTemplates` 传给 `ResourceLoader`，由 loader 从 agent dir 与 project `.widi` 目录解析。
- `extensions` 声明 profile 需要哪些 extension。
- `missingExtensionSeverity` 声明 extension 缺失时的处理等级。
- `capabilities` 目前只是声明字段，orchestrator 还没有消费。

`AgentOrchestrator` 当前只在这些位置使用 profile：

1. 创建 agent 时选择 `options.profile ?? defaultProfile`。
2. 创建 agent 时用 `profileOverride` 做一层浅合并。
3. 按 `profile.label` 分配 `agentId`。
4. 把 profile 引用写入 session header metadata。
5. resume 时按 metadata 中的 profile id 调用 `resolveProfile`，找不到时回退到 `defaultProfile`。
6. 构建 harness 时用 `profile.skills`、`profile.promptTemplates`、`profile.systemPrompt`。

这说明 orchestrator 已经有 profile 的最小运行路径，但还没有形成完整的 profile runtime contract。

## 主要缺漏

### Profile 加载

`AgentProfileLoader` 已能按 profile 名称从 `agentDir/profiles` 与 `cwd/.widi/profiles` 加载 profile，但 orchestrator 目前并不持有 loader 或 registry，只接受一个 `resolveProfile` 回调。

这让 resume 路径可以工作，但缺少统一的 profile registry 语义：

- 没有定义多个同名 profile 的优先级或冲突处理。
- 没有定义 `defaultProfile` 是否也应从 loader/registry 取得。
- 没有把 profile loader diagnostics 合并到 orchestrator events。
- 没有定义 profile id 与文件名不一致时的索引策略。

### Resource Diagnostics

`ResourceLoader.loadSkills()` 与 `loadPromptTemplates()` 已返回 diagnostics，但 `_buildAgentHarness()` 当前只取成功加载的 resources，并丢弃 diagnostics。

缺失处理需要区分：

- profile 显式声明了某个 resource，但文件缺失。
- profile 未声明 resource，因此 loader 加载默认目录。
- resource 文件存在但 schema 或 markdown 解析失败。
- 同一个 resource 从 agent dir 与 cwd 同时加载时是否允许重复。
- resource source 是否应暴露给 UI、日志或 debug command。

当前注释里已经标出 `resourceLoader also return a resource diagnostics`，但尚未定义事件、错误等级和恢复策略。

### Extensions

`AgentProfile.extensions` 已声明 profile 需要的 extension，但 extension lifecycle 仍是空白：

- `ExtensionRunner` 还没有 loader、registry、activation API。
- orchestrator 没有根据 `profile.extensions` 解析 extension。
- `missingExtensionSeverity` 还没有被执行。
- extension 启动失败、缺失、版本不兼容、权限不足等情况还没有统一 diagnostic shape。
- session metadata 暂时没有保存 extension runtime 状态。

推荐先把 `extensions` 视为 profile 的声明式依赖列表，而不是已激活 extension 实例。缺失等级只影响启动策略，不应该改变 profile schema。

### Tools

`AgentProfile.tools` 当前没有被 orchestrator 消费。创建 agent 时实际使用的是 `SpawnAgentHarnessOptions.tools`。

需要决定 `profile.tools` 的语义：

- 是默认启用工具列表。
- 是允许工具 allowlist。
- 是 extension/tool registry 中的 tool names。
- 还是只用于 UI 展示。

还需要定义 resume 时 `context.activeToolNames` 与当前 profile/tools 的关系。当前 resume 会把 session context 中的 active tool names 传给 harness，但没有校验这些工具是否仍然存在。

### Capabilities

`capabilities` 目前未参与任何决策。

需要明确哪些地方消费它：

- `acceptsUserInput` 是否影响 UI/RPC 是否允许用户直接对该 agent 发消息。
- `canSpawn` 是否影响 agent 是否能创建子 agent。
- `canRequestUser` 是否影响 request-user 类工具是否注册。

这些能力应由 orchestrator 或 tool registry 转换成实际可用工具和事件策略，不能只停留在 profile 类型上。

### Profile Override

`profileOverride` 当前是浅合并：

```ts
const agentProfile = options.profileOverride ? { ...baseProfile, ...options.profileOverride } : baseProfile;
```

这会带来几个问题：

- nested `capabilities` 会整体替换。
- `skills`、`promptTemplates`、`tools`、`extensions` 是整体替换还是追加尚未写成规则。
- override 没有写入 session metadata，因此 resume 只能回到当前 profile 默认值。
- override 缺少 diagnostics，错误配置会延迟到 harness 构建阶段才暴露。

如果 override 是产品能力，就需要持久化声明式 override 或保存 profile snapshot/reference。

### Fallback 策略

resume 时 profile 缺失会回退到 `defaultProfile`，并发出 `agent_profile_missing` event。这个策略对早期开发友好，但长期不够精确：

- main agent 缺失 profile 与 subagent 缺失 profile 的处理可能不同。
- 持久 agent 与 ephemeral agent 的处理可能不同。
- 缺失 profile 是否允许继续，应该有 severity 或 policy。
- fallback 到 default profile 后，session header 仍记录旧 profile id，后续 resume 会重复触发同一问题。

需要定义明确的 profile missing policy，并让 UI 能把 fallback 信息展示给用户。

## Diagnostic 策略

建议把 diagnostics 分成三个阶段，而不是混成一类：

1. Profile diagnostics

   来自 profile 文件加载和 schema 校验，例如读取失败、frontmatter 解析失败、profile id 缺失、字段类型错误。

2. Dependency diagnostics

   来自 profile 声明的依赖解析，例如 skills、prompt templates、extensions、tools 缺失或加载失败。

3. Runtime diagnostics

   来自 harness 或 extension 启动后的运行时问题，例如 extension activation failed、tool registry conflict、model auth failed。

每条 diagnostic 至少应包含：

- `severity`: `info | warning | error`
- `code`: 稳定机器可读 code
- `message`: 面向用户的说明
- `agentId`
- `profileId`
- `source`: profile/resource/extension 的来源路径或 registry key
- `recoverable`: 是否已经 fallback 或忽略

orchestrator 不应直接打印 diagnostics。它应该通过事件流、返回值或 runtime service 汇总，让 UI/RPC/CLI 决定如何展示。

## 建议的 Orchestrator 边界

`AgentOrchestrator` 应保持为 runtime coordinator：

- 接收已解析或可解析的 profile。
- 调用 profile registry 解析 resume profile。
- 调用 resource loader 与 extension registry 构建 harness dependencies。
- 汇总 diagnostics。
- 根据 severity 决定继续、fallback 或失败。
- 发出结构化 events。

它不应直接解析 markdown，不应直接扫描 extension 目录，也不应负责 UI 文案。

## TODO

- [ ] 引入 `ProfileRegistry`，统一管理 profile id 到 `SourcedAgentProfile` 的解析、优先级、冲突和 diagnostics。
- [ ] 让 `AgentOrchestrator` 接收 `ProfileRegistry` 或更明确的 profile resolver result，而不是只接收 `AgentProfile | undefined`。
- [ ] 定义 `OrchestratorDiagnostic` 类型，覆盖 profile、resource、extension、tool 和 model 相关问题。
- [ ] 为 `agent_spawned`、`agent_resumed` 增加 diagnostics 或新增 `agent_diagnostics` event。
- [ ] 在 `_buildAgentHarness()` 中处理 `loadSkills()` 与 `loadPromptTemplates()` 返回的 diagnostics。
- [ ] 定义 resource diagnostic severity：缺失显式声明资源是否为 warning/error，默认目录不存在是否忽略。
- [ ] 决定 resource source 是否进入 harness metadata、debug command 或 session custom entry。
- [ ] 定义 duplicate resource 策略：同名 skill/template 是覆盖、合并、保留全部还是报诊断。
- [ ] 实现 extension registry/loader，并让 orchestrator 消费 `profile.extensions`。
- [ ] 执行 `profile.missingExtensionSeverity`：`ignore` 跳过，`warning` 继续并发诊断，`error` 阻止 harness 创建。
- [ ] 定义 extension activation failure 与 missing extension 的不同 diagnostic code。
- [ ] 明确 `profile.tools` 的语义，并把它接入 tool registry 或 spawn options。
- [ ] 校验 resume context 中的 `activeToolNames` 是否仍存在，不存在时按 policy 诊断或降级。
- [ ] 明确 `capabilities` 到 tools/events 的映射规则，例如 spawn、request user、direct user input。
- [ ] 定义 `profileOverride` 的 merge 规则，特别是 arrays 与 nested capabilities。
- [ ] 持久化创建 agent 时使用的 `profileOverride`，或明确禁止需要 resume 的 override。
- [ ] 定义 profile missing policy：main/subagent、persistent/ephemeral、interactive/non-interactive 是否不同。
- [ ] 决定 fallback 到 `defaultProfile` 后是否写入新的 session metadata 或只发一次诊断。
- [ ] 为 profile/resource/extension diagnostics 增加 focused tests，覆盖 spawn 和 resume 两条路径。
