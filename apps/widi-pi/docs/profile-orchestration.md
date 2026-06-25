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

1. 创建 agent 时选择 `options.profileId ?? defaultProfileId`，并通过 `AgentProfileRegistry` 解析 profile。
2. 创建 agent 时在 registry resolve 后应用受限 `profileOverride`。
3. 按 `profile.label` 分配 `agentId`。
4. 把 profile 引用写入 session header metadata。
5. resume 时按 metadata 中的 profile id 调用 registry；找不到、禁用、重复或无效时结构化失败，不 fallback。
6. 构建 harness 时用 `profile.skills`、`profile.promptTemplates`、`profile.systemPrompt`。

这说明 orchestrator 已经接入第一版 profile registry contract。Profile、resource、model/auth、tool registry 和 command/human-request diagnostics 已经通过 orchestrator `diagnostic` event 统一发布；extension diagnostics 仍未完成。

## 主要缺漏

### Profile 加载

`AgentProfileRegistry` 是 profile 入口。Registry 持有 storage backend，按 `ProfileId` 建 lazy metadata index，并处理 source priority、冲突和 profile diagnostics。

第一版已经覆盖：

- `cwd` 高于 `agent_dir`，整份覆盖，不做字段级合并。
- 同 priority duplicate hard fail。
- `defaultProfileId` 由 orchestrator policy 持有，并通过 registry 解析。
- `enabledProfiles` 由 settings/orchestrator policy 按 `ProfileId` 过滤。
- profile id 与文件名不一致时只按声明 id 索引，并产生 diagnostic。

仍未完成的是 runtime composition 接入真实 file roots、settings paths 和 builtin default source。Profile diagnostics 已经使用统一 `CoreDiagnostic` shape，并在 create/resume profile resolve 时由 orchestrator 发布。

### Resource Diagnostics

`ResourceLoader.loadSkills()` 与 `loadPromptTemplates()` 已返回 Pi agent harness 定义的局部 diagnostics。`_buildAgentHarness()` 会把这些 diagnostics 转成 core `resource.*` diagnostics 并通过 orchestrator event 发布。

缺失处理需要区分：

- profile 显式声明了某个 resource，但文件缺失。
- profile 未声明 resource，因此 loader 加载默认目录。
- resource 文件存在但 schema 或 markdown 解析失败。
- 同一个 resource 从 agent dir 与 cwd 同时加载时是否允许重复。
- resource source 是否应暴露给 UI、日志或 debug command。

第一版只做报告，不阻止 harness 创建。仍需定义 explicit/default resource 缺失、parse failed 和 duplicate resource 的 severity/disposition 策略。

### Extensions

`AgentProfile.extensions` 已声明 profile 需要的 extension，但 extension lifecycle 仍是空白：

- `ExtensionRunner` 还没有 loader、registry、activation API。
- orchestrator 没有根据 `profile.extensions` 解析 extension。
- `missingExtensionSeverity` 还没有被执行。
- extension 启动失败、缺失、版本不兼容、权限不足等情况还没有统一 diagnostic shape。
- session metadata 暂时没有保存 extension runtime 状态。

推荐先把 `extensions` 视为 profile 的声明式依赖列表，而不是已激活 extension 实例。缺失等级只影响启动策略，不应该改变 profile schema。

### Tools

`AgentProfile.tools` 已在 orchestrator harness build 时作为 ToolRegistry `requestedToolNames` 消费。创建或恢复 agent 时不再传入 raw `AgentTool[]`；所有 `AgentTool` 都应由 registry resolve 后的 `ToolDefinition` wrap 而来。

`ToolRegistry` 已经提供 definition/contribution 解析能力并接入 `_buildAgentHarness()`。`profile.tools` 表示 profile/policy 请求暴露给当前 harness 的 tool names，即 registry resolve 的 `requestedToolNames`。它不是 tool definition 本身，也不是 capability。

当前 registry 行为：

- 未提供 `requestedToolNames` 时，所有 resolved tools 可见。
- 提供 `requestedToolNames` 时，只暴露存在的工具，并为重复或缺失工具产生 diagnostic。
- 未提供 `activeToolNames` 时，默认启用所有可见工具。
- resume 提供旧 `activeToolNames` 时，registry 会按当前可见工具校验，过滤不存在的名字并产生 diagnostic。

当前 orchestrator 会把 `profile.tools` 传给 registry，把 resume context 中的 `activeToolNames` 传给 registry，并把 registry diagnostics 发布为 orchestrator `diagnostic` event。调用方需要新增工具时，应注册 tool contribution，而不是传入 Pi runtime closure。

Tool execution context 已经包含 `SessionFactStore`。它由 orchestrator 在 harness build 时用当前 agent 的真实 Pi `Session` 构造，供 tool/extension 写入 WIDI session facts。这个能力不属于 profile schema；profile 只影响哪些 tools 被 resolve，后续还需要定义 fact definition 如何随 tool/extension contribution 注册、在 resume 时恢复，以及恢复失败如何产生 diagnostics。

### Capabilities

`capabilities` 目前未参与任何决策。

需要明确哪些地方消费它：

- `acceptsUserInput` 是否影响 UI/RPC 是否允许用户直接对该 agent 发消息。
- `canSpawn` 是否影响 agent 是否能创建子 agent。
- `canRequestUser` 是否影响 request-user 类工具是否注册。

这些能力应由 orchestrator 或 tool registry 转换成实际可用工具和事件策略，不能只停留在 profile 类型上。

### Profile Override

`profileOverride` 当前在 registry resolve 后应用：

```ts
const profile = await profileRegistry.resolveProfile(profileId);
const agentProfile = applyProfileOverride(profile, options.profileOverride);
```

第一版规则：

- override 不能覆盖 `id`。
- nested `capabilities` 做浅层合并。
- 如果 override 修改 `systemPrompt`、`tools`、`skills`、`promptTemplates`、`extensions`、`capabilities` 或 `persist` 等恢复关键字段，则不能创建 persistent session。
- override 不写入 session metadata。

后续仍需决定 arrays 是否需要更细的 merge/append 语义。需要 resume 的差异仍应进入正式 profile。

### Fallback 策略

resume 时 profile 缺失、禁用、重复或无效不再回退到 `defaultProfile`，而是由 orchestrator 产生结构化 diagnostic 并停止恢复。

后续仍需让 UI/RPC/CLI 更好地展示失败原因，并提供修复后重试、选择替代 profile 或 unavailable session record 等产品路径。

## Diagnostic 策略

建议把 diagnostics 分成三个阶段，而不是混成一类：

1. Profile diagnostics

   来自 profile 文件加载和 schema 校验，例如读取失败、frontmatter 解析失败、profile id 缺失、字段类型错误、source override。

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

orchestrator 不应直接打印 diagnostics。当前统一出口是 orchestrator `diagnostic` event；UI/RPC/CLI 订阅事件并决定如何展示。

## 建议的 Orchestrator 边界

`AgentOrchestrator` 应保持为 runtime coordinator：

- 接收 `profileId` 或 session metadata 中的 profile reference。
- 调用 profile registry 解析 create/resume profile。
- 调用 resource loader 与 extension registry 构建 harness dependencies。
- 汇总 diagnostics。
- 根据 severity 和 runtime policy 决定继续或失败。
- 发出结构化 events。

它不应直接解析 markdown，不应直接扫描 extension 目录，也不应负责 UI 文案。

## TODO

- [x] 实现 markdown/frontmatter profile loading 与 profile storage backend，从 agent dir 与 project `.widi/profiles` 加载 profile 并返回 diagnostics。
- [x] 实现 `ResourceLoader`，从 agent dir 与 project `.widi` 加载 skills/prompt templates。
- [x] 让 `SessionManager` 在创建持久 agent session 时写入 profile reference，并让 resume 通过 resolver 恢复 profile。
- [x] 引入 `ProfileRegistry`，统一管理 profile id 到 sourced profile 的解析、优先级、冲突和 diagnostics。
- [x] 让 `AgentOrchestrator` 接收 concrete `AgentProfileRegistry`，不再接收 `AgentProfile | undefined` resolver。
- [x] 定义 command/client/human-request 使用的最小 `OrchestratorDiagnostic` 类型。
- [x] 将 `OrchestratorDiagnostic` 收敛为 `CoreDiagnostic` alias，覆盖 profile、resource、tool、model/auth、extension source shape。
- [x] 新增 orchestrator `diagnostic` event，作为 UI/RPC/CLI 的统一 diagnostics 出口。
- [x] 在 `_buildAgentHarness()` 中处理 `loadSkills()` 与 `loadPromptTemplates()` 返回的 diagnostics，并发布 core resource diagnostics。
- [ ] 定义 resource diagnostic severity：缺失显式声明资源是否为 warning/error，默认目录不存在是否忽略。
- [ ] 决定 resource source 是否进入 harness metadata、debug command 或 session custom entry。
- [ ] 定义 duplicate resource 策略：同名 skill/template 是覆盖、合并、保留全部还是报诊断。
- [ ] 实现 extension registry/loader，并让 orchestrator 消费 `profile.extensions`。
- [ ] 执行 `profile.missingExtensionSeverity`：`ignore` 跳过，`warning` 继续并发诊断，`error` 阻止 harness 创建。
- [ ] 定义 extension activation failure 与 missing extension 的不同 diagnostic code。
- [x] 明确 `profile.tools` 的推荐语义：registry requested tool names。
- [x] 实现 `ToolRegistry.resolve()` 的 requested/active tool name 校验和 diagnostics。
- [x] 将 `profile.tools` 和 resume/runtime `activeToolNames` 接入 `ToolRegistry.resolve()`，并把 diagnostics 汇总到 orchestrator。
- [x] 将 `SessionFactStore` 注入 tool execution context，并基于当前 agent Pi `Session` 写入 `custom` entry。
- [ ] 定义 tool/extension `SessionFactDefinition` 的注册、resume 恢复和 diagnostic 汇总流程。
- [ ] 明确 `capabilities` 到 tools/events 的映射规则，例如 spawn、request user、direct user input。
- [x] 定义第一版 `profileOverride` 规则：禁止覆盖 id；修改恢复关键字段时不能创建 persistent session。
- [x] 明确 `profileOverride` 不写入 session metadata；需要 resume 的差异进入正式 profile。
- [x] 定义第一版 profile missing policy：缺失、禁用、重复、无效时结构化失败，不 fallback。
- [ ] 将 runtime composition 接入真实 profile roots、settings paths 和 builtin default source。
- [x] 为 startup diagnostics 与 spawn profile diagnostics 增加 focused tests。
- [ ] 为 resume profile/resource/extension diagnostics 增加 focused tests。
