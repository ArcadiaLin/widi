# Profiles And Resources

Profile 是 agent 的声明式配置。Resource 是 profile、runtime policy 或 extension 声明的外部依赖。两者都由 dependency layer 解析，不拥有 agent lifecycle。

## Profile identity

Profile 不是 agent instance。同一 profile 可以创建多个 agent；`ProfileId` 用于 registry lookup、session recovery reference 和 diagnostics，不是 `AgentId`，也不等同于文件名。

`AgentProfileRegistry` 拥有 profile identity 和索引语义：

- Storage backend 只发现 entry 并读取 raw content。
- Registry 解析 markdown/frontmatter，按 `ProfileId` 建 lazy metadata index。
- `listProfiles()` 返回 summary，不返回完整 system prompt。
- `inspectProfiles()` 暴露 candidates、source、status 与 diagnostics。
- `resolveProfile(id)` 区分 missing、invalid、duplicate、parse failure 等结果。
- `reload()` / `invalidate()` 显式清理 cache，不隐式运行 filesystem watcher。

正常 profile 只按声明 id 索引。未声明 id 时可以使用 filename-derived id；文件名不是 alias。Id 与文件名不一致允许加载但产生 diagnostic。

## Source 与 priority

Runtime composition 向 file backend 注入显式 roots，通常从高到低为：

1. settings 指定的 profile path。
2. project `cwd/.widi/profiles`。
3. user `agentDir/profiles`。
4. builtin default profile。

不同 priority 的同 id profile 由高优先级整份覆盖，不做字段级 merge，并产生 source override diagnostic。同 priority duplicate 是 hard conflict。高优先级 candidate 无效时不静默 fallback 到低优先级同 id candidate。

Builtin default 是普通低优先级 source，不是错误恢复 fallback。

## Orchestrator policy

`defaultProfileId` 与 `enabledProfiles` 属于 orchestrator/settings policy，不属于 registry。

- 创建时未指定 profile，orchestrator 使用 `defaultProfileId` lookup。
- `enabledProfiles === undefined` 表示不限制。
- 空数组表示禁用所有 profiles。
- 非空数组按 `ProfileId` allow-list。
- Create 与 resume 使用同一 enabled policy。

Resume 从 session metadata 读取 profile reference，并用当前 registry 重新解析。Profile missing、disabled、duplicate、invalid 或 parse failed 时结构化失败，不 fallback 到 default profile。

## Profile 字段的 runtime 消费

Profile 的主要职责是声明 agent build 输入：

- `systemPrompt`：进入 harness system prompt composition。
- `persist`：选择 persistent JSONL 或 in-memory session。
- `tools`：ToolRegistry 的 requested visibility。
- `skills` / `promptTemplates`：ResourceLoader 的 roots 与选择范围。
- `extensions`：per-agent extension dependencies。
- `missingExtensionSeverity`：只调节 missing declaration，不覆盖 activation/version failure。
- `commands`：command input 的 enable/deny policy。
- `capabilities`：连接 profile 与 runtime policy；当前由 user-facing command、extension human request、session control 和后续 collaboration 使用。

解析但没有 runtime consumer 的 policy 字段不应长期保留。

## Profile override

`profileOverride` 是 create-time assembly 输入，不是新的 profile identity。

- Override 不能修改 `id`。
- Nested capabilities 做浅层 merge。
- 修改 system prompt、tools、resources、extensions、capabilities 或 persist 等恢复关键字段时，不能创建 persistent session。
- Override 不写入 session metadata。

需要 resume 的差异应进入正式 profile，而不是依赖一次性 override。

## Resources

`ResourceLoader` 是 skills 和 prompt templates 的唯一文件读取与解释入口。它解析 profile/core roots 与 extension 贡献路径，返回 resolved resources、source provenance 和局部 diagnostics。

Extension 通过 `contributeResources()` 在激活期声明 paths，不注册内存 resource object。贡献是 own-agent overlay，只影响当前 agent 的：

- harness resources 与 system prompt skills 列表。
- `<skill:...>` / `<prompt:...>` candidates 与 expansion。
- inspect 中的 resolved provenance。

冲突采用 first-registration-wins：profile/cwd 等 core sources 先解析并优先；extension 同名贡献被丢弃并产生 `extension.resource_conflict`。Stale runner 的贡献退出后续加载与展开管线，不追溯修改已创建 harness 的 resources。

Core roots 之间的 duplicate identity 和 severity 细则仍按 [Backlog](../BACKLOG.md) 的真实需求推进，不在本机制文档维护实施清单。

## Diagnostics

Profile diagnostics 覆盖 source read、frontmatter parse、metadata validation、id mismatch、case conflict、duplicate、override、missing 与 disabled。

ResourceLoader 可以保留 Pi 的 `SkillDiagnostic` / `PromptTemplateDiagnostic`；进入 orchestrator event 时转换为 `CoreDiagnostic` 并补充 profile/agent context。第一版 resource failure 以报告为主，不由 loader 私自决定 agent lifecycle。

## 非职责

- Profile 不实例化 tool、extension 或 runtime object。
- Registry 不解析 resource body，也不拥有 default/enabled policy。
- ResourceLoader 不创建 agent 或决定 resume fallback。
- Session metadata 不保存 profile snapshot、source path 或大型 resource 内容。
