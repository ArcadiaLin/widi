# Profiles And Resources

Profile 是 agent 的声明式配置。Resource 是 profile 声明或 runtime policy 需要加载的外部依赖。

## 核心理念

Profile 不是 agent 实例。

同一个 profile 可以创建多个 agent。agent 的运行时身份由 orchestrator 分配和管理。Profile 只是构建 agent runtime 的输入。

ProfileId 是声明身份。

`ProfileId` 用于 profile registry lookup、recovery reference 和 diagnostics。它不是文件名，也不是 `AgentId`。文件名只能作为 loader 的发现路径或默认 id 来源。

DefaultProfileId 是调用层输入。

`defaultProfileId` 用于创建新 agent 时未显式指定 profile 的默认 lookup 输入，但不是 resume profile 缺失时的自动 fallback。缺失 profile 的失败、用户选择或 unavailable 都应由 caller policy 决定。

Profile 应可解析、可恢复、可诊断。

持久 session 只需要保存 profile reference。恢复时，core 用当前 profile registry 重新解析 profile，再构建 harness。这样可以让 profile 随配置演进，但也要求缺失、冲突和 policy decision 都有清晰 diagnostics。

Profile registry 拥有索引语义。

Profile storage backend 负责发现和读取 profile source。Profile registry 负责解析 markdown/frontmatter、按 `ProfileId` 建索引，并处理 source priority、冲突、validation 和 diagnostics。

Profile storage backend 只负责 source discovery。

Profile storage backend 是只读边界。它列出可读取的 profile entry，并按 opaque entry id 读取 raw profile content。它不解析 markdown，不建立 `ProfileId` 索引，也不读取 settings。

Profile registry 是具体 core service。

`AgentProfileRegistry` 类似 `ModelRegistry`，持有 `ProfileStorageBackend`，负责 lazy metadata index、source priority、duplicate、parse、validation 和 diagnostics。orchestrator 直接持有 registry service，但不接触 storage backend。

Profile registry 不拥有 runtime policy。

`defaultProfileId`、`enabledProfiles`、resume missing fallback 和 profile override 校验属于 orchestrator 或更高层 runtime composition。Registry 只回答当前 source 集合中某个 `ProfileId` 如何解析。

Profile 解析必须按需。

不引入显式 index 文件。Registry 可以在首次 lookup/list/inspect 时懒构建 metadata index，但不应在启动时解析所有完整 profile。完整 profile body 只在 `resolveProfile(id)` 选中具体 entry 后解析。`listProfiles()` 只返回 summary，不返回 `systemPrompt`。

Resources 是 dependency，不是 profile 内容。

Skills、prompt templates、extension 依赖和工具可见性都应作为 dependency 被解析。解析结果应包含来源和 diagnostics，让 orchestrator 决定继续、降级或失败。

Resource loader 和未来 resource registry 分工不同。

Resource loader 负责从具体来源读取/解析 resource declaration。第一版不引入 resource registry，避免在 resources 尚未复杂化前过早建立索引层。若后续需要跨来源 identity、duplicate、priority 或 validation policy，再引入 resource registry。

Harness resources 是 resource 子集。

传给 Pi `AgentHarness.resources` 的 skills、prompt templates 等是 resolved harness resources。不是所有 dependencies 都是 harness resources，tools、extensions、models/auth 和 runtime adapters 也属于 dependency resolution。

Duplicate resource 报错。

Core 不做静默覆盖或隐式合并。重复资源应产生明确 diagnostic，避免同名 skill/template/profile 在不同来源之间制造不可解释行为。

## Profile Override

Profile override 是 create-time runtime assembly 输入，不是 profile identity，也不是 session persistence 的分类。

Override 可以用于一次性试验，但不能污染持久恢复语义。需要 resume 的差异必须进入正式 profile 或其他持久化声明。

`persist` 不是 profile override 的分类。

`persist` 只在创建 `AgentHarness` 时决定 session storage 使用持久化 backend 还是 in-memory backend。Resume 能否发生由已有持久 session metadata 决定，不由当前 profile 的 `persist` 字段重新决定。

`profileOverride` 不能覆盖 `id`。

Override 在 registry resolve 之后应用，只影响本次 harness build。若 override 修改 `systemPrompt`、`tools`、`skills`、`promptTemplates`、`extensions`、`capabilities` 或 `persist` 等恢复关键字段，则不能创建 persistent session。需要恢复的差异必须进入正式 profile。

## Profile Storage Backend

`ProfileStorageBackend` 最小职责：

- `listEntries()`：发现 profile entry，不读取 profile 内容。
- `readEntry(entryId)`：按 opaque entry id 读取 raw content。

Entry 应包含 backend 内部 identity 和 source metadata。`entryId` 不是 `ProfileId`，可以是 `file:/abs/path`、`memory:default` 或 extension backend 自己的 opaque id。

File backend 接收显式 roots，而不是读取 settings 或硬编码 runtime policy。Root 应包含 source kind、path、priority 和 missing behavior。默认 runtime composition 可按以下优先级组装：

1. settings explicit profile paths
2. project `cwd/.widi/profiles`
3. user `agentDir/profiles`
4. builtin default profile

默认 profile directory 只扫描直接子级 `*.md`，不递归。显式 settings path 指向目录时也只读取该目录直接子级。子目录文件需要通过 settings path 显式声明。

需要的 backend：

- `FileProfileStorageBackend`：从显式 roots 发现本地 profile 文件。
- `InMemoryProfileStorageBackend`：用于测试、builtin 或 runtime composition 注入。
- `CompositeProfileStorageBackend`：组合多个 backend，对 registry 暴露单一 backend。

第一版 registry/storage backend 只读，不提供 create/update/delete profile API。

## Profile Registry

Registry 按 `ProfileId` 建 lazy metadata index。正常 profile 只按 frontmatter `id` 索引；未声明 `id` 时，文件名可作为默认 id 来源。文件名不是 alias。

`id` 与文件名不一致时允许加载，但产生 diagnostic。`resolveProfile("declared-id")` 可以命中该文件，`resolveProfile("filename")` 不应命中，除非另有 profile 的真实 id 是 `"filename"`。

Profile id 第一版采用宽松 validation：

- 非空字符串。
- 不包含 `/`、`\` 或控制字符。
- 大小写敏感。

仅大小写不同的 id 可以同时存在，但应产生 warning diagnostic。

Source priority 规则：

- 不同 priority 的相同 `ProfileId`：高优先级整份覆盖低优先级，不做字段级合并，并产生 override diagnostic。
- 同 priority 的相同 `ProfileId`：hard conflict，`resolveProfile(id)` 失败。
- 高优先级 duplicate、invalid 或 parse failed 会阻断低优先级 fallback。
- 低优先级 parse/validation 问题不阻止高优先级有效 profile 解析成功，但应出现在 diagnostics/inspect 中。

Frontmatter parse failed 时，registry 可以用 filename-derived id 作为 blocking/diagnostic heuristic，但这不是正式 identity，也不会出现在可用 profile list 中。

Registry API 语义：

- `resolveProfile(id)`：返回 result object，不返回 `AgentProfile | undefined`。失败必须区分 missing、parse failed、invalid、duplicate 等 reason，并携带 diagnostics。
- `listProfiles()`：返回当前 registry 可解析的 profile summary，不返回 raw content 或 `systemPrompt`。
- `inspectProfiles()`：返回所有 candidates 的 metadata、source、status 和 diagnostics，包括 shadowed、duplicate、invalid、parse failed；默认不返回 raw content 或完整 prompt。
- `reload()` / `invalidate()`：显式清理 cache。不做 filesystem watcher。

Registry 不解析 resources。`skills`、`promptTemplates`、`extensions` 等字段只做声明形态 validation，实际 resource dependency resolution 在 resource loader / harness build 阶段完成。

## Orchestrator Policy

`defaultProfileId` 属于 orchestrator 或更高层 runtime policy，不属于 registry。创建 agent 未显式指定 profile 时，orchestrator 使用 `defaultProfileId` 调用 registry resolve。若 default profile 解析失败或被禁用，create 结构化失败，不自动 fallback。

`enabledProfiles` 属于 settings 与 orchestrator policy，不属于 registry。语义：

- `undefined`：不限制 profile 使用。
- `[]`：禁用所有 registered profiles。
- 非空数组：只允许数组中的 `ProfileId`。

`enabledProfiles` 按 `ProfileId` 过滤，不按文件名、路径或 glob 过滤。Create 和 resume 都必须受该 allow-list 限制。Builtin default profile 也受限制。

Resume 使用 session metadata 中的 profile reference id 调用 registry resolve，然后由 orchestrator 检查 `enabledProfiles`。缺失、disabled、duplicate、invalid 或 parse failed 都应结构化失败，不 fallback 到 `defaultProfileId`，也不创建 unavailable harness。第一版直接不创建 harness。

Persistent session metadata 只保存 profile reference，例如 `{ id, label? }`。不保存 source/path，不保存 profile snapshot 或 raw content。

为了首次启动可用，runtime composition 可以注入低优先级 builtin default profile backend。它不是 failure fallback，而是普通 profile source，可被 user/project/settings profile 覆盖。

## 非职责

- Profile 不直接实例化 tools/extensions/runtime。
- Resource loader 不拥有 agent lifecycle。
- Extension 不直接处理已存储 profile。
- Session metadata 不保存 profile snapshot 或大型 resource 内容。

## TODO

- [x] 实现 markdown/frontmatter profile loader，覆盖 agent dir 与 project `.widi/profiles`。
- [x] 实现 skills/prompt templates resource loader，并在 harness build 时注入 Pi resources。
- [x] 在 persistent session metadata 中保存 profile reference，并在 resume 时通过 resolver 恢复 profile。
- [x] 引入 profile registry，按 `ProfileId` 解析 sourced profile 并产生 diagnostics。
- [x] 定义 profile id 与文件名不一致时的索引和 diagnostic 规则。
- [x] 将 resume profile 缺失改为 policy-driven diagnostic，不默认 fallback 到 `DefaultProfile`。
- [x] 定义 create-time profile override 的校验路径，尤其是恢复关键字段与 persistent session 的关系。
- [x] 引入 `enabledProfiles` setting，并在 orchestrator policy 层按 `ProfileId` 过滤。
- [x] 将 orchestrator default profile 输入收敛为 `defaultProfileId`。
- [x] 引入 profile storage backend：file、in-memory、composite，以及低优先级 builtin default source。
- [ ] 将 runtime composition 接入真实 profile registry roots、settings paths 与 builtin default source。
- [x] 统一 profile/orchestrator diagnostics shape，并通过 orchestrator `diagnostic` event 汇总到 UI/RPC 边界。
- [ ] 评估是否需要 resource registry；当前 resource loader 保持轻量，Pi resource diagnostics 通过 adapter 进入 `CoreDiagnostic`。
- [ ] 区分 explicit resource missing、default directory missing、parse failed、duplicate identity。
- [ ] 定义哪些 resolved resources 会变成 Pi harness resources。
