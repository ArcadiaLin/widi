# Extensions

Extension 是 `widi-pi` 的高自由度扩展机制。作者 API 已冻结为 v1；extension 可以深入参与 runtime，但不能绕过 core state ownership 和可观察边界。作者用法见 [Extension 开发指南](../extension-authoring.md)。

## Declaration 与 instance

Profile/config 中的 extension id 是可恢复的 dependency declaration。Loader 解析 module 并为每个 agent 激活；激活后的 runner、factory closure 和 callback context 是 runtime state，不进入 session metadata。

每个 `(extension, agent)` 组合独立激活。Factory closure 是 per-agent state；module top-level state 跨 agent 共享。Reload 重新 discover/import 并替换 runner，旧 context 变成 stale：不再收到事件，contributions 退出后续 resolve，任何 action 立即失败。

Project `.widi/extensions` discovery 受 project trust gate；settings/agent-dir roots 仍按其 source policy 加载。Loader 支持 direct file、directory index、package manifest entry 与 in-memory registration。

## 公开契约与版本

第三方 extension 的唯一 import 面是 `src/core/extension/api.ts`。`extension/index.ts` 是 loader/runner 使用的内部 barrel，不属于作者契约。

公开面包括：

- 版本常量与 compatibility check。
- `ExtensionDefinition` / `ExtensionFactory` / `ExtensionActivationApi`。
- tool、command、resource、provider definitions。
- observer/interceptor events 与 results。
- callback context、scoped actions、session custom entry。
- 由作者签名使用的 command、diagnostic、human request、tool snapshot 与 runtime model facts。

Pi typed hook events/results、raw `AgentHarnessEvent`、`ImageContent`、`ThinkingLevel`、`ShellExecOptions`、`Result`/`ExecutionError` 和 TypeBox schema 按引用属于契约面。它们发生破坏性变更时，WIDI extension API 同样需要 bump。

版本使用单调递增整数。当前支持区间为 `[1, 1]`。第三方 extension 应导出：

```ts
const extension: ExtensionDefinition = {
  apiVersion: 1,
  activate(api) {
    // Declare contributions.
  },
};

export default extension;
```

裸 factory 视为面向当前版本，适合与 runtime 同仓演进。不兼容版本在 load/registration 阶段被拒绝；引用它的 agent 收到 `extension.version_incompatible`（error、blocked），不受 missing severity 调节。

## Activation API

### Tools

`registerTool()` 定义新 tool。Tool name first-registration-wins；extension 不能用同名 definition 覆盖 core built-in。

`patchTool()` 修改既有 tool 的 description、parameters、strict 或 execute，也可以用 `aroundExecute` 包装原实现。Patch 进入 ToolRegistry resolved pipeline，保持 tool name、active state 和 session history 可解释。

### Commands

`registerCommand()` 支持：

- Line command：`/name args`，handler 获得 `ExtensionCommandContext`。
- Inline command：`<name:argument>`，`expand(argument)` 只返回替换文本，拿不到 actions，因此展开无副作用。

Extension commands 与 built-in commands 共用 parser、gateway、arguments completion 和 `command_*` events。Built-in name 是保留字；冲突的 extension command 以带 provenance 的名字注册。

Line-command handler 的返回值沿用 built-in command 通道：同时出现在 `InputResult.value` 与 `command_completed.result`。只执行副作用的 handler 返回 `undefined`；需要在 command 完成前报告增量进度时使用 scoped `emitOutput()`。

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
- `command_detected/accepted/completed/rejected/failed`。
- agent-scoped `human_request_pending/resolved/timeout/cancelled`。
- agent-scoped `diagnostic`。
- `agent_spawned/resumed` 与 session info/fork facts。
- `input_transformed/blocked`。

Observer 按注册顺序串行执行。Handler failure 产生 `extension.handler_failed`，不改变原操作，后续 observer 继续。Global diagnostic/request 不广播给每个 runner；diagnostic observer failure 不递归回灌。

`extension_output` 有意不属于 observed event：extension 发出的 client output 不会再次进入任何 extension observer，避免反馈与递归。

### Intercept

| Hook | 合成 | Handler failure |
| --- | --- | --- |
| `before_agent_start` | messages 追加；最后一个 systemPrompt 胜出 | 跳过失败者 |
| `context` | 后者接收前者 messages | 跳过失败者 |
| `before_provider_request` | streamOptions patch 管线 | 跳过失败者 |
| `tool_result` | 字段级 last-success-wins；`terminate: true` 保留 | 跳过失败者 |
| `tool_call` | 第一个 block 短路 | fail-closed，阻断本次调用 |
| `input` | transform pipeline；第一个 block 短路 | fail-closed，拒绝整条输入 |

`input` 在 command parsing 前运行且只运行一次。改写结果重新进入完整 input pipeline；extension 自己通过 scoped actions 发起的 prompt/steer/followUp 不经过该 hook。Transform/block 会发布带 extension attribution 的 canonical facts。

需要策略门禁时使用 `tool_call` 或 `input`；`before_provider_request` 是 request shaping hook，不承担 fail-closed policy。

## Scoped context 与 actions

Callback context 绑定 extension 自己的 agent；作者 API 中不出现可任意指定的 `agentId`。Actions 包括：

- 查询/修改 visible 与 active tools。
- `prompt`、`steer`、`followUp`、`abort`、`compact`。
- `requestHuman`；source 由 runner 注入，受 `canRequestUser` 门控。
- `emitOutput(text)`：向 listeners/clients 追加一条 own-agent、带 extension attribution 的 plain-text output。顺序 `await` 的调用保持顺序；每次调用都是独立 event，不合并、不 replace。
- session name、commands、model candidates、model/thinking getters/setters。
- `exec`；受 project trust 门控。

Action failure 发布 `extension.action_failed` 并 rethrow。Extension tool execute context 使用同一 scoped host，不越过 stale runner 边界。

`emitOutput` 是 ephemeral 单向通道：不进入 model context，不写 session，也不在 resume/hydration 后恢复。需要持久状态时仍使用 session custom entry；不要把 output event 当作 storage。

`ExtensionCommandContext` 额外提供人类触发的 session control：new、fork、navigate tree、list 与 resume。Spawn 类操作受 `canSpawn` 门控；fork/navigation 要求 source agent idle。它们返回收窄结果，不暴露 SessionManager、raw session path 或 mutable entry。

## State 与 storage

Extension state 分为三类：

- Factory closure：per-agent runtime state，reload 后重置。
- Session custom entry：当前 session 可恢复的小型 append-only state。
- Extension-owned file：大型 artifact、多 session index 或产品模式状态，经受信 `exec`/filesystem 自行管理。

Core 不提供 per-extension KV 或目录 API。Custom entry 的 namespace、fork、compaction、missing extension 与 export 语义见 [Sessions And Runtime](sessions-and-runtime.md)。

## Inspect 与 diagnostics

`agent.inspect` 暴露 loaded extensions、hooks、commands、tool/resource/provider contributions、patches、diagnostics 与 stale state，不包含 secrets。

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
