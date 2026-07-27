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

Builtin default 是普通低优先级 source，不是错误恢复 fallback。它的 id 是 `main`，与发行版 `.widi/profiles/main.md` 同名：发行版那份以更高 priority 整份覆盖它，而不是并排多出一个角色。没有任何地方指定 default profile 时，orchestrator 回落到的也是 `main`。

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
- `tools`：ToolRegistry 的 requested visibility，也是 agent 协作能力的唯一边界（见下）。
- `skills`：ResourceLoader 的选择范围；未写则加载 roots 下全部 skill。
- `commands`：command input 的 enable/deny policy。
- `description` / `whenToUse`：只面向调用方。前者说这个角色是什么，后者说什么时候该选它而不是隔壁那个，是 `list_agent_profiles` 真正依赖的字段。两者都不进 system prompt。

解析但没有 runtime consumer 的 policy 字段不应长期保留。

### Frontmatter 形态

Frontmatter 是自带的极简 YAML 子集，不是完整 YAML：单行标量、`[a, b]` 数组、一层嵌套 mapping，以及 block scalar。

`whenToUse` 这类选择建议通常是一整段，只能写成 block scalar：

```markdown
whenToUse: |
  Use for a self-contained change.

  It cannot see your conversation.
```

首个内容行的缩进即被剥离的缩进，空行保留，块在第一个缩进不深于 key 的非空行处结束。`|-` 会被接受但与 `|` 等价：末尾空行一律丢弃，且所有消费方都会 trim，clip 与 strip 在下游无法区分。序列化走同一条路——含换行的文本写成 block scalar，读回来完全一致。

### Profile 不管的两件事

- **哪些 extension 加载**：由 settings 的 `enabledExtensions` 决定，未配置即"运行时发现到的全部启用"；`extensionDivisions` 负责扩展内部裁剪。extension 是一次安装范围的事实，不是角色的属性，因此 profile 不再有 `extensions` / `extensionDivisions` / `missingExtensionSeverity` 字段。
- **有哪些 prompt template**：prompt template 是用户自己的 slash 命令，始终整体加载，与 agent 扮演什么角色无关，因此 profile 不再有 `promptTemplates` 字段。

旧 profile 文件里残留这些键不会报错，但会被忽略。

### `tools` 决定协作能力

Profile 没有单独的 collaboration capability 字段。谁能 spawn、分派任务、给别的 agent 发消息、销毁 agent，完全由 `tools` 是否列出对应工具决定：

- `spawn_agent` 是真正的闸门。没有它的 agent 只能与已知 agent 交互。
- `list_agents` 是发现能力的开关。给了它，agent 可以枚举并寻址全部存活 agent（适合编排者）；不给，它只知道自己 spawn 的结果、任务信封里的 owner 与 taskId、以及别人在消息里告诉它的 agentId（适合 worker）。
- `send_message` 同时承担普通消息、任务分派与任务完成三种模式，配不出"能聊天但不能分派"的粒度。

因为未写 `tools` 的 profile 会拿到全部已注册工具，**被 spawn 出来的 worker profile 应当显式列出 `tools`**，否则它同样具备完整协作能力。Core 不设 agent 数量上限，也没有第二道兜底：`tools` 就是唯一的闸门。

## Profile override

`profileOverride` 是 create-time assembly 输入，不是新的 profile identity。

- Override 不能修改 `id`。
- 修改 `systemPrompt`、`tools`、`skills` 或 `persist` 等恢复关键字段时，不能创建 persistent session：resume 会按 profile id 重新解析，恢复出来的将是另一套输入。
- Override 不写入 session metadata。

需要 resume 的差异应进入正式 profile，而不是依赖一次性 override。

## Resources

`ResourceLoader` 是 skills 和 prompt templates 的唯一文件读取与解释入口。它解析 profile/core roots 与 extension 贡献路径，返回 resolved resources、source provenance 和局部 diagnostics。

Extension 通过 `contributeResources()` 在激活期声明 paths，不注册内存 resource object。贡献是 own-agent overlay，只影响当前 agent 的：

- harness resources 与 system prompt skills 列表。
- `/skill` / `/prompt` candidates 与 expansion。
- inspect 中的 resolved provenance。

冲突采用 first-registration-wins：profile/cwd 等 core sources 先解析并优先；extension 同名贡献被丢弃并产生 `extension.resource_conflict`。Stale runner 的贡献退出后续加载与展开管线，不追溯修改已创建 harness 的 resources。

Core roots 之间的 duplicate identity 和 severity 细则仍按 [Backlog](../BACKLOG.md) 的真实需求推进，不在本机制文档维护实施清单。

## Diagnostics

Profile diagnostics 覆盖 source read、frontmatter parse、metadata validation、id mismatch、case conflict、duplicate、override、missing 与 disabled。

ResourceLoader 把 Pi 的 `SkillDiagnostic` / `PromptTemplateDiagnostic` 归一化为 `CoreDiagnostic`，code 加上 `resource.skill.` / `resource.prompt_template.` 前缀并拼上出错路径；orchestrator 只补 agent context 再发布。Resource failure 以报告为主，不由 loader 私自决定 agent lifecycle。

`loadAgentResources(profile)` 是 agent build 的单一入口：按 profile 收窄 skills、整体加载 prompt templates，并一次返回归一化 diagnostics。Orchestrator 不再自行组合这两类资源。

## 非职责

- Profile 不实例化 tool、extension 或 runtime object。
- Registry 不解析 resource body，也不拥有 default/enabled policy。
- ResourceLoader 不创建 agent 或决定 resume fallback。
- Session metadata 不保存 profile snapshot、source path 或大型 resource 内容。
