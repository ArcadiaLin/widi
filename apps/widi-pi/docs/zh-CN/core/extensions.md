# Extensions

Extension 是 `widi-pi` 的高自由度扩展机制。作者 API 当前为 v1：在首次公开发布前允许原地重塑（presentation-protocol 裁决），发布后冻结、破坏性变更才 bump 版本。Extension 可以深入参与 runtime，但不能绕过 core state ownership 和可观察边界。作者用法见 [Extension 开发指南](../extension-authoring.md)。

## Declaration 与 instance

Profile/config 中的 extension id 是可恢复的 dependency declaration。Loader 解析 module 并为每个 agent 激活；激活后的 runner、factory closure 和 callback context 是 runtime state，不进入 session metadata。

每个 `(extension, agent)` 组合独立激活。Factory closure 是 per-agent state；module top-level state 跨 agent 共享。Reload 重新 discover/import 并替换 runner，旧 context 变成 stale：不再收到事件，contributions 退出后续 resolve，任何 action 立即失败。

Project `.widi/extensions` discovery 受 project trust gate；settings/agent-dir roots 仍按其 source policy 加载。Loader 支持 direct file、directory index、package manifest entry 与 in-memory registration。

## 公开契约与版本

第三方 extension 的唯一 import 面是 `src/core/extension/api.ts`。`extension/index.ts` 是 loader/runner 使用的内部 barrel，不属于作者契约。

公开面包括：

- 版本常量与 compatibility check。
- `ExtensionDefinition` / `ExtensionFactory` / `ExtensionActivationApi` / `ExtensionDivisionDeclaration`。
- tool、resource、provider definitions。
- observer/interceptor events 与 results。
- callback context、scoped actions、session custom entry。
- `ExtensionStatus`、`ExtensionStatusProgress`、`ExtensionStatusSnapshot`。
- `ExtensionMessage`、`ExtensionMessageKind`。
- `ExtensionDiagnosticDraft`。
- 由作者签名使用的 diagnostic、human request、tool snapshot 与 runtime model facts。

Pi typed hook events/results、raw `AgentHarnessEvent`、`ImageContent`、`ThinkingLevel`、`ShellExecOptions`、`Result`/`ExecutionError` 和 TypeBox schema 按引用属于契约面。它们发生破坏性变更时，WIDI extension API 同样需要 bump。

版本使用单调递增整数。当前支持区间为 `[1, 1]`；公开发布前 v1 仍会原地补充 presentation actions 等契约调整，不因此 bump。第三方 extension 应导出：

```ts
const extension: ExtensionDefinition = {
  apiVersion: 1,
  activate(api) {
    // Declare contributions.
  },
};

export default extension;
```

裸 factory 视为面向当前版本，适合与 runtime 同仓演进。不兼容版本在 load/registration 阶段被拒绝；引用它的 agent 收到 `extension.version_incompatible`（severity `error`，构成阻断性 load diagnostic），不受 missing severity 调节。

## Divisions 与 integration

Extension 的开关粒度默认只到 id 一层：profile 声明 id，loader 激活 factory，它注册的全部 contribution 无差别进入 scope。Division 在 extension 内部加一层可命名、可寻址的分区，使"只启用其中一部分"成为配置而不是重新打包。声明了 division 的 extension 称为 **integration**；runtime 不引入独立的 integration 类型，运行单元仍是 extension。

Division 声明在 default export 的 `divisions` 上，而不是 package manifest：loader 先 import module 再激活，因此清单在**任何 extension 代码运行之前**就可列举，且单文件 extension 没有 manifest 可用。`ExtensionIdentity.divisions` 因此是激活前的 catalog。

Id 是点分层级路径（`servers.github`），段只能包含字母、数字、`_`、`-`，整体不超过 128 UTF-8 bytes。`divisions` 是未经校验的 module 数据，因此非数组、非对象条目、字段类型错误、id 非法或重复都只丢弃该条声明并产生 `extension.division_invalid`，绝不抛出。它是 `warning` 而非 `error`：agent 创建会被任何 error 级 extension diagnostic 阻断，而"丢掉一条声明"是可恢复的，其余部分照常加载。

### 注册与执行

`api.division(id, register)` 划定归属。关键语义：**division 关闭时 `register` 回调不执行**，而不是执行后过滤 contribution——否则被关掉的部分仍会打开连接、注册 watcher。嵌套 scope 内的 id 相对父级解析。`api.isDivisionEnabled(id)` 是同语义的命令式查询，共用同一道 id 校验：非法 id 一律返回 `false`，命令式分支不会执行 scoped 形式会拒绝的副作用。不在任何 division 内的注册属于隐式 root，永远启用。

一个 division 的回调抛错只记为一条 `extension.division_activation_failed`（warning，带 division 归属），不阻断该 extension 后续注册、也不阻断 agent 创建：integration 的一个部件坏掉不应连坐其余部件。它与整体 `extension.activation_failed`（error，阻断）是不同的 code。

未 `await` 的 `division()` 由 loader 在收敛 scope 前排空——**包括 root factory 自身抛错的情况**，否则一个仍在运行的异步 division 会在 scope 交出去之后继续改写 contribution 数组。

未声明就使用的 id 按启用处理（fail-open），并产生 `extension.division_undeclared`（warning）；它以 `declared: false` 出现在 inspect facts 中。静默丢弃作者已注册的 contribution 比一个未列出的开关更有害。

### 选择与解析

用户侧规则复用 `extensions` 列表的前缀 token：

```yaml
extensions: ["mcp", "-mcp/tools", "+mcp/experimental"]
```

- `mcp` — 按声明默认启用。
- `-mcp/tools` — 关闭该 division 及其整个子树。
- `+mcp/experimental` — 打开默认关闭的 division。

裸 `mcp/tools`（无 `+`/`-`）被拒绝并产生 error：它读起来像 allowlist，实际语义相反。为未列入 `extensions` 的 extension 写规则只产生 `profile.division_without_extension`（warning）并忽略——规则不会隐式启用 extension。

`settings.json` 的 `extensionDivisions`（按 extension id 键控）承载安装时的默认形态，走既有 global/project 合并：project 条目整体替换同一 extension id 的 global 条目。

Division 规则与 `extensions` 一样是 recoverable profile field：persistent agent 不能带临时 division override 创建（`profile.override_not_persistable`）——恢复时只按 profile id 重解析，否则 tool/hook/provider 集合会静默变化。

解析顺序：声明的 `enabledByDefault`（默认 `true`）→ settings → profile。规则作用于命名 division 及其子树，**最近的规则胜出**；同一层内 `disable` 压过 `enable`，profile 压过 settings。随后是硬闸：任一祖先解析为关闭时，后代强制关闭，`+` 也无法翻越——"关掉这一部分"必须意味着整块。解析结果以 `source: default | settings | profile | ancestor` 出现在 inspect facts 中。

引用了既未声明也未使用的 division id 的规则产生 `extension.division_unknown`（warning）并忽略。

切换 division 改变 contribution 集合，因此需要重建 runner：走既有 `reloadExtensions` 路径，没有额外机制。

## Activation API

### Tools

`registerTool()` 定义新 tool。Tool name first-registration-wins；extension 不能用同名 definition 覆盖 core built-in。

`patchTool()` 修改既有 tool 的 description、parameters、strict 或 execute，也可以用 `aroundExecute` 包装原实现。Patch 进入 ToolRegistry resolved pipeline，保持 tool name、active state 和 session history 可解释。

### 主动入口边界

Extension API 不提供 `registerCommand()`。Extension 保留 tool/resource/provider contribution、observer/interceptor 与 own-agent scoped actions 等被动能力；交互命令属于 `src/tui/commands/` 的 TUI 命令引擎（CLI 复用）。未来若需要主动唤醒 extension，由前端以 `/extension` 一类命令另行设计，不把 command ownership 放回 core 或 extension runtime。

### Resources

`contributeResources({ skillPaths, promptTemplatePaths })` 在激活期声明 paths。ResourceLoader 仍是唯一 filesystem reader/interpreter。

Contribution 是 own-agent overlay。Core/profile resources 先注册并优先，同名 extension contribution 被丢弃并产生 `extension.resource_conflict`。Declaration 与 resolved provenance 进入 inspect facts。

### Providers

`registerProvider(name, config)` 声明完整的新 provider。Provider fact 是 process-global，但 registration 按 `(extension, agent)` 记账并随 runner reload/dispose 撤销；多个 agent 共享相同 contribution 时使用 reference count。

Extension provider 不能 override built-in、models.json、runtime dynamic 或其他 extension 已注册的 name。Config value 由 core 在请求期解析；包含 `!command` 时必须通过 project trust gate。Credential 与 OAuth refresh 仍归 AuthStorage/pi-ai runtime。

## Hook model

Hook 只有两条注册通道：

- `observe(name, handler)`：只读事实，返回值忽略。
- `intercept(name, handler)`：拦截、改写或阻断。

### Observe

Own-agent observers 可以读取：

- raw `agent_harness_event`：Pi agent/turn/message/tool/provider/compact/tree/model/thinking facts。
- agent-scoped `human_request_pending/resolved/timeout/cancelled`。
- agent-scoped `diagnostic`。
- `agent_spawned/resumed` 与 session info/fork facts。
- `input_transformed/blocked`。
- background job 的三条通道：`agent_background_job_changed`（每个可观测 transition：t0 `backgrounded`、`aborting`、`settled`，携带不可变 snapshot 与 `liveCount`）、`agent_background_job_progress`（增量输出，Base64，按绝对字节偏移）、`agent_background_job_report_updated`（tool 自有的 latest-value 结构化 report）。

三条 job 通道共用同一条 per-agent 串行发射尾，因此顺序有保证，且 `settled` 是 barrier：该 job 最后一份 output 增量与 report 一定排在终态事件之前。Progress 是有损的——增量缓冲溢出时从头部丢弃，`startByte` 会跳过上一次的 `endByte`，`progressDroppedBytes` 随之上升；需要完整字节流的 extension 必须自己按偏移累积，事后无法从 rolling tail 补回。

Observer 按注册顺序串行执行。Handler failure 产生 `extension.handler_failed`，不改变原操作，后续 observer 继续。Global diagnostic/request 不广播给每个 runner；diagnostic observer failure 不递归回灌。

`extension_output`、`extension_notification`、`extension_status_changed` 与 `extension_message_published` 有意不属于 observed event：extension 主动发布的 presentation facts 不会再次进入任何 extension observer，避免反馈与递归。同理，`reportDiagnostic` 产生的 diagnostic 只发送给 listeners/clients，不回灌 extension diagnostic observers。

### Intercept

| Hook | 合成 | Handler failure |
| --- | --- | --- |
| `before_agent_start` | messages 追加；最后一个 systemPrompt 胜出 | 跳过失败者 |
| `context` | 后者接收前者 messages | 跳过失败者 |
| `before_provider_request` | streamOptions patch 管线 | 跳过失败者 |
| `tool_result` | 字段级 last-success-wins；`terminate: true` 保留 | 跳过失败者 |
| `tool_call` | 第一个 block 短路 | fail-closed，阻断本次调用 |
| `input` | transform pipeline；第一个 block 短路 | fail-closed，拒绝整条输入 |

`input` 在 core `sendMessage` 内对**每一条**入站消息运行一次，不只是人类文本：agent 之间的消息、background job 的结果（t1）与 system notice 走同一条管线，因此没有输入路径能绕过 input policy。Event 携带 `source` 与 `targetAgentId`：只想改写人类输入的 handler 必须检查 `source`，否则也会改写模型正在等待的工具结果；`targetAgentId` 是将要读到这条消息的 agent，跨 agent 投递时它不是 handler 自己的 agent。

Block 按来源分级。`human` / `agent` / `system` 的 block 会被执行，调用方收到拒绝结果；`background_job` 的 block 只降级为 `orchestrator.message_block_ignored` 诊断，消息照常投递——模型已经握着该 job 的 t0 handle，静默丢弃会让它永远等下去。

交互层会先解析 line command 或完成 inline expansion；只有 pass/expanded prompt 进入该 hook，line command 执行不进入它。Transform 结果直接继续 model-facing path，不重新解析为命令。Extension 通过 scoped `prompt` 发起的文本进入该 hook；scoped `steer` / `followUp` 是直达 harness 的低层原语，不经过 `sendMessage`，因此也不经过该 hook。Transform/block 会发布带 extension attribution 的 canonical facts。

需要策略门禁时使用 `tool_call` 或 `input`；`before_provider_request` 是 request shaping hook，不承担 fail-closed policy。

## Scoped context 与 actions

Callback context 绑定 extension 自己的 agent；作者 API 中不出现可任意指定的 `agentId`。Actions 包括：

- 查询/修改 visible 与 active tools。
- `prompt`、`steer`、`followUp`、`abort`、`compact`。
- `listJobs()`：own-agent 当前 live 的 backgrounded job 快照，也就是模型手里握着 t0 handle 的那些。仅限 `backgrounded` 阶段：`running` 阶段的 job 还在 t0 之前的同步窗口内，从未对外可观测。
- `readJobOutput(jobId)`：live job 的当前 rolling tail；job 结算后返回 `undefined`。它是 pull-only 且有界的（tail 超出上限时从头部丢弃），与 job change event 刻意不携带 output 配套。需要完整输出的 extension 应累积 progress 增量，而不是轮询这里。
- `killJob(jobId, reason?)`：请求终止一个 live job，`reason` 会记到该 job 的 snapshot 与它最终的 result message 上。返回 `false` 表示没有这样的 live job——列出来的 job 可能在 extension 动手之前就已结算。这是请求而非强杀：local job 只有在其 tool 响应 abort signal 时才真正结束；external job 没有执行者在看 signal，由 table 自身结算为 cancelled。
- `requestHuman`；source 由 runner 注入。
- `emitOutput(text)`：向 listeners/clients 追加一条 own-agent、带 extension attribution 的 plain-text output。顺序 `await` 的调用保持顺序；每次调用都是独立 event，不合并、不 replace。事件携带 core 生成的 `presentationId` 作为 consumer 的稳定 view key。
- `notify(text)`：发布一次 own-agent、带 extension attribution 的 info-only transient notice。事件携带 core 生成的 `presentationId`；consumer 决定显示位置和寿命。它没有 severity、code、dedupe、clear 或 attention 语义，问题事实必须使用 `reportDiagnostic`。Text 必须非空白且不超过 4 KiB（UTF-8 字节）。
- `setStatus(key, status)` / `clearStatus(key)`：维护 own-agent、own-extension 的 keyed runtime current state。`status` 至少含非空 `text`，可选 `progress: { completed, total? }`；进度值必须是非负整数，且存在 `total` 时 `completed <= total`。
- `publishMessage(message)`：发布可恢复的展示内容。core 先把 core-owned `core:extension_message` custom entry 写入 session，再发布 `extension_message_published`；entry id 同时出现在 action 返回值 `{ entryId }`、canonical event 与持久 entry 上，consumer 用它在 hydration 与 live event 之间去重。`kind` 限于 `text | markdown | code`；`title` 可选、非空白且不超过 4 KiB，`content` 非空且不超过 64 KiB（UTF-8 字节）。Message 永不进入 model context。
- `reportDiagnostic(draft)`：把作者事实交给既有 diagnostic 管线。draft 只有 `severity`（`warning | error`）、`code` 与 `message`；`agentId`、`extensionId` 由 core 注入，local `code` 规范化为 `extension.<extensionId>.<code>`。Core 不再注入 fresh per-report id：code、message 与 attribution 完全相同的重复上报在 consumer 侧塌缩为同一 view item，而不是保持为独立条目；持续性问题应由 attention 表达，而不是轮询式重报。Local code 只能包含字母、数字、`.`、`_`、`-`，不超过 128 UTF-8 bytes；`message` 非空白且不超过 4 KiB。上报产生的 diagnostic 不回灌任何 extension observer。
- session name、model candidates、model/thinking getters/setters。
- `exec`；受 project trust 门控。

Action failure 发布 `extension.action_failed` 并 rethrow。Extension tool execute context 使用同一 scoped host，不越过 stale runner 边界。

`emitOutput` 与 `notify` 都是 ephemeral 单向通道：不进入 model context，不写 session，也不在 resume/hydration 后恢复。区别是 output 进入 append-only timeline，notify 只进入 consumer 的 transient notice 区。需要可恢复的展示内容时使用 `publishMessage`；需要持久业务状态时仍使用 session custom entry，不要把 presentation event 当作 storage。

CLI 将 notification 降级为单行 `[extension:<extensionId>] notice: <text>`：连续空白折叠为一个空格，text 最多显示 240 个字符，超出后追加省略号。

Status 由 core registry 按 `(agentId, extensionId, key)` 保存，并通过 `listExtensionStatuses(agentId)` 提供防御性快照。Set 先写 registry 再发 `extension_status_changed`；clear 先删除再发事件，缺失 key 的 clear 是无事件的 no-op。成功 reload extension runtime 或 dispose agent 时，core 先清空该 agent 的全部 status，再逐条发 clear mutation；skipped/failed reload 保留旧 status。Extension 必须显式决定状态寿命。

Status 同样是 ephemeral：不进入 timeline、model context 或 session。Consumer 使用 event 更新 live view，晚接入或 hydration 后使用 snapshot query 重建当前状态区。Core 限制单条 output 为 65,536 UTF-8 bytes、notification text 为 4,096 UTF-8 bytes、status key 为 128 UTF-8 bytes、status text 为 4,096 UTF-8 bytes；consumer 仍应按自身宽度做有界渲染。

`reportDiagnostic` 不建立另一套 presentation event；它发布标准 `diagnostic` event，并把同一事实加入 agent 的 extension diagnostics。Draft validation 或发布前 action failure 走统一 `extension.action_failed` 并 rethrow；无效 draft 不产生作者 diagnostic。

## State 与 storage

Extension state 分为三类：

- Factory closure：per-agent runtime state，reload 后重置。
- Session custom entry：当前 session 可恢复的小型 append-only state。
- Extension-owned file：大型 artifact、多 session index 或产品模式状态，经受信 `exec`/filesystem 自行管理。

Core 不提供 per-extension KV 或目录 API。Custom entry 的 namespace、fork、compaction、missing extension 与 export 语义见 [Sessions And Runtime](sessions-and-runtime.md)。

## Inspect 与 diagnostics

`agent.inspect` 暴露 loaded extensions、hooks、tool/resource/provider contributions、patches、divisions（声明与已使用的 id 及其解析状态）、diagnostics 与 stale state，不包含 secrets。每条 hook 与 contribution 携带 `divisionId`，root 注册为 `undefined`。

Missing、load failure、invalid factory/manifest、version mismatch、activation failure、handler/action failure 和 contribution conflict 使用不同 `extension.*` codes。Missing policy 只处理 declaration 无法解析；activation/version failure 属于已找到但不可运行的 dependency failure。

## 与 Pi extension 的主要差异

- WIDI 将 Pi 的单一 `on()` 分为 observe 与 intercept，并为每个 hook 固定合成/失败语义。
- Tool definition 不能覆盖 built-in，修改行为使用 patch。
- Provider 只能注册新 name，override 入口归 models.json。
- Core 不提供 shortcut、flag、renderer 或 `ctx.ui`；呈现由 client adapter 消费 events、custom entries 与 human request facts。
- WIDI actions 默认 own-agent scoped；跨 agent 行为进入 collaboration facade。
- `custom_message`、extension EventBus、provider payload mutation 等未收编能力由 [Backlog](../BACKLOG.md) 的真实 consumer 重新举证。

## 非职责

- 不私有维护 agent lifecycle 或跨 agent 通信。
- 不直接修改持久 profile/session 文件。
- 不把 runtime instance 当作可恢复 core state。
- 不绕过 ToolRegistry、ModelRegistry 或 project trust。
