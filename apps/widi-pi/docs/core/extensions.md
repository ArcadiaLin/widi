# Extensions

Extension 是 `widi-pi` 的高自由度扩展机制。它应能像 Pi coding-agent extension 一样深度参与 runtime，但不能绕过 core 的可观察边界。

当前目标不是宣称 extension runtime 已经稳定，而是把 extension loader/runner、Orchestrator、command input 和 `ToolRegistry` 的边界整理清楚。当前 loader/runner 已支持 factory/file/module activation、project trust gate、reload、tool define/patch、command contribution、observer/interceptor、session custom entry 和 inspect facts。`ToolRegistry` 继续负责 source、diagnostics、patch、visibility、active tools 和最终 wrap-to-`AgentTool`。

## 核心理念

Extension declaration 不是 extension instance。

Profile、preset 或 config 中声明的 extension 是可恢复、可解析的 dependency declaration。运行时激活后的 extension instance 属于 runtime state，不能写入 session metadata。

Extension 通过 hook 插入 core 能力。

Orchestrator 执行每个关键能力时，都应有 extension 观察、拦截、补充或改写的机会。包括 agent lifecycle、profile/resource/tool 解析、command dispatch、client interaction、model/runtime 请求、diagnostics 和 adapter interaction。

Extension hook 能力必须可描述。

每个 hook 点应明确 extension 能 observe、intercept、mutate，还是 invoke controlled core capabilities。Extension 的自由度来自这些受控入口，而不是绕过 core state ownership。安全边界优先依赖 project trust、runtime policy 和受控 API。

Extension 可以组合 core 能力。

`/team`、`/flow`、`/goal`、MCP、sandbox、remote worker 等都应作为 extension 或 preset 组合出现，而不是进入 core primitive。

Extension missing policy 只处理缺失声明。

声明引用解析不到时，按 declaration 的 missing policy 决定 ignore、warning 或 error。找到 extension 但 activation failed 是另一类 diagnostic，不应和 missing policy 混在一起。

Extension 不能直接拥有已存储 core state。

已经存储好的 profile、session、resource registry、agent registry 不能由 extension 私下接管。Extension 可以通过受控 API 请求变更、贡献资源、注册能力或响应 hook，但 core state 的所有权仍属于 core registry/orchestrator。

Extension 可以拥有自己的 storage。

Extension-owned storage 用于 extension/preset 的产品交互模式和多 session 组合。Core 可以提供路径、diagnostics、lifecycle hook 或 capability API，但不解释其中的数据模型。

Custom entry 是 extension-owned 恢复通道。

Extension-owned storage 之外，当前 MVP 已在 runtime context 暴露 `ctx.session.appendEntry()` / `ctx.session.findEntries()`，用于写入和当前 session tree 强相关的小型 extension state。Core 不提供共享 state layer，也不解释 `custom` entry 的 data shape。

当前 MVP 只支持 namespaced `custom` entry：extension 传入 local type，core 落库为 `extension:<extensionId>:<localType>`，读取时返回 local type。读取范围是 current branch path，返回 root-to-leaf 顺序；写入是 append-only，不提供 delete/update。`custom_message`、触发 turn、进入 LLM context、UI/RPC 展示、fork/compaction/export policy 仍待定义。

这层能力用于“当前 session 可恢复 extension 状态”，不是 extension 私有数据库。大型 artifact、多 session index、产品模式状态仍属于 extension-owned storage。WIDI-owned tools 的可恢复数据走 Pi tool call arguments、tool result `content` 和 typed `details`。

Extension 可以修改既有 tools。

WIDI extension 不只注册新 tool，也可以对 core/product tool 注册 patch。Patch 必须进入 tool registry 的 resolved pipeline，而不是直接改写某个 runtime object。允许的修改包括：

- 改写 `description`、`parameters` 或 `strict` metadata。
- 包装 execute，例如审计、确认、沙箱转发、远程执行。
- 替换 execute，例如让 `write` 写到不同 backend。

这种设计让 active tool name 保持稳定。例如 extension 可以修改 `write` 的执行行为，但最终 resolved tool 仍叫 `write`，session 中的 active tools 和历史 tool call 仍可解释。

Extension 不拥有 core tool 状态接口。Core 不提供共享的 tool preview 或状态 API；展示数据应由 UI 或 extension host 基于 orchestrator raw `agent_harness_event` 中的 tool events 派生。

当前 `ToolRegistry` 已支持 `defineTool(tool, source)` 与 `patchTool(targetToolName, patch, source)`。Extension loader/runner 的职责是把 extension declaration 激活为当前 agent/profile 的 loaded scope，再由 Orchestrator 在 resolve 边界把该 scope 写入 scoped registry overlay；registry 不直接加载 extension、不执行 activation hook，也不决定 missing extension policy。

Patch 执行时的 `context.extension` 按当前 patch source 绑定；调用 `next()` 时会恢复内层 tool source 的 context。这样 extension 可以在 `aroundExecute` 中使用自己的 context、storage 和 diagnostics 上下文，同时不会把自身身份泄漏到 core/base execute。

需要继续设计的细节：

- 多个 extension patch 同一字段时，只按注册顺序决定最终值；extension loader 需要让加载顺序可解释、可诊断。
- patch 失败、restore 失败或 runtime action 失败应如何进入统一 diagnostic。

Extension 可以实现 tool tracking。

Tool tracking 不进入 core primitive。它应作为 extension pattern：通过 `aroundExecute` 包装目标 tool，在 execute 前 start，在 `context.onUpdate` 中 update，在成功或抛错时 finish/fail。

Extension 开发需要注意这个语义：观察、审计、耗时统计和轻量 run tracking 适合 `aroundExecute`（契约见 `ToolDefinitionPatch`，由 ToolRegistry patch 管线按注册顺序合成）；真正改变 tool 行为时才替换 `execute`。

## 当前实现

当前实现是 Orchestrator-owned extension runner MVP，可用于内部/product extension 验证，但还不是稳定第三方扩展系统：

- `ExtensionLoader` 支持内存 factory registry：`registerExtensionFactory(extensionId, factory)`。
- `ExtensionLoader.discover()` / module importer 支持 direct file、directory index、轻量 `package.json` entry、jiti import、cache busting、id conflict diagnostics 和 project trust gate。
- `loadForAgent()` 按当前 agent/profile 的 `profile.extensions` 激活 scope，并处理 missing、load failed、activation failed 和 id/source diagnostics。
- Runtime reload 已能重新 discover/load extension catalog，并替换 eligible agent runner；旧 context 会被标记 stale。
- Activation API 支持 `registerTool()`、`patchTool()`、`registerCommand()`、`observe()` 和 `intercept()`。
- `ExtensionRunner` 将 loaded scope 贡献到当前 agent 的 scoped `ToolRegistry` overlay，不污染 global registry。
- Extension command 通过 `registerCommand()` 注册 UI-neutral 事实（name、trigger、description、argumentHint）与执行形态。当前代码只支持 `handler(argument, ctx)` line 命令；inline `expand(argument)` 后续接入。所有 command 由 orchestrator `inputAgent` 按统一 trigger 模板解析、门控并执行。契约详见 [Command Experiment](./command-experiment.md)（`inputInvoke` 字段名随收编退役）。
- Orchestrator 已将 `before_agent_start`、`context`、`tool_call`、`tool_result` 四个 harness hook 桥接到 interceptors。
- Orchestrator 已将 raw `agent_harness_event` 桥接到 observers，内部 Pi `AgentHarnessEvent` 原样透传；observer error 变成 `extension.handler_failed` diagnostic。
- Runner 使用 lazy context：`bindCore()` / `bindCommandContext()` 后，handler 通过 `createContext()` / `createCommandContext()` 获取 own-agent scoped actions 与 session custom entry facade（全量 `dispatch` 已随 M1 移除；own-agent scope 收敛已随 ME 切片 3 落地，契约见下文 Scoped Actions 节）。
- Human request action 回到 orchestrator 主路径；request lifecycle 由 `human-request.ts` 的 `HumanRequestBroker` 管理，extension 不直接选择 client 或持有 pending request。
- `agent.inspect` 已能暴露 loaded extensions、registered hooks、commands、tool contributions、patches、diagnostics 和 stale state。
- Interceptor 按注册顺序串行执行；合成类跳过失败者并保留其余结果，`tool_call` 失败 fail-closed。详细契约见下一节。
- 仓库内真实 consumer `tests/extensions/audit-extension.ts` 只使用 activation API 与 callback context，组合 raw observer、`tool_call` interceptor、scoped human request 和 session custom-entry 账本；其集成测试是 interceptor 失败语义与 scoped actions 的锚点回归。

这些能力足够验证 ToolRegistry、hook、diagnostics、reload、input command 和 session custom entry 的主路径。仍不足以作为稳定第三方 extension surface：provider/resource registration、更多 hook matrix、extension-owned storage、product presentation 和完整 RPC adapter 尚未收口。

### Interceptor 合成与失败语义

Observer 与 interceptor 是两条不同路径。Observer 被动接收 raw `agent_harness_event`；interceptor 直接接收 Pi harness 的 typed hook event，并返回对应的 Pi hook result，不经过 orchestrator event 转换。Orchestrator 只负责连接 harness 与 runner、记录 diagnostics，并把 runner 的结果原样交回 harness。

四个 interceptor 均按 extension 注册顺序串行执行：

- `before_agent_start`：成功 handler 的 `messages` 依次追加；最后一个成功提供的 `systemPrompt` 胜出。
- `context`：管线式改写；后一个 handler 接收最近一次成功 handler 返回的 `messages`。
- `tool_result`：管线式逐字段改写；后一个 handler 接收当前已合成的 result。`content`、`details`、`isError` 由最后一个成功提供该字段的 handler 胜出，`terminate: true` 一旦出现即保留。
- `tool_call`：第一个返回 `block: true` 的 handler 立即终止管线，其 `reason` 原样返回。

`before_agent_start`、`context`、`tool_result` handler 抛错时，runner 产生 `extension.handler_failed` diagnostic，只丢弃该 handler 的结果并继续执行后续 handler；此前与此后的成功结果都保留。多个失败分别产生 diagnostic。若没有任何成功 handler 返回结果，harness 按无拦截结果继续。

`tool_call` handler 抛错时 fail-closed：runner 产生同一 diagnostic，并立即返回 `{ block: true }`，后续 handler 不再执行。Pi harness 使用默认 blocked tool result 文案，当前 tool call 不会执行；agent/runtime 本身不进入 unavailable，可继续后续交互。异常消息与 extension 身份只进入 diagnostic，不注入 model-facing tool result。

`extension.handler_failed` 当前保持 warning、degraded、recoverable：失败会降低 extension runtime 能力，但合成类仍可继续，`tool_call` 也通过安全阻断收敛在单次调用内。

### Scoped Actions 契约

`ExtensionActions` 是 own-agent scoped 的动作/查询面（ME 切片 3 裁决）：agentId 由 runner 在 `createContext(extensionId)` 时注入，任何 action 签名中都不出现 agentId；跨 agent 操作不属于本契约，归 M3 collaboration facade。orchestrator 与 runner 之间的绑定契约是 `ExtensionCoreActions`（agentId 显式，不属于 extension 作者 API），收窄发生在 runner 单点——与 command 补参回调只收 `argumentPrefix` 是同一 narrowing 先例。

| Action | 背书的 core 能力 | 说明 |
| --- | --- | --- |
| `getTools` / `setTools` / `setActiveTools` | `getAgentTools` / `setAgentTools` / `setAgentActiveTools` | ToolRegistry re-resolve 语义不变 |
| `requestHuman(draft)` | `requestHuman` | source 由 runner 注入为 `{ kind: "extension", extensionId }`，不可伪造；profile `capabilities.canRequestUser === false` 时抛 `extension.human_request_denied` |
| `prompt` / `steer` / `followUp` | `promptAgent` / `steerAgent` / `followUpAgent` | 均返回 void（结果经 raw event 流可达）；custom message 形态等切片 7 policy |
| `setSessionName` | `setAgentSessionName` | |
| `getCommands` | `listCommands` | 与 client 同一门控口径（profile deny、scope、availability） |
| `setModel(reference)` / `getThinkingLevel` / `setThinkingLevel` | `setAgentModelByReference` / `getAgentThinkingLevel` / `setAgentThinkingLevel` | 失败为结构化 diagnostic（`model.reference_invalid` 等） |
| `exec(command, options)` | `ExecutionEnv.exec` | project trust 未通过时抛 `extension.exec_denied`，命令不执行（裁决见 [Extension Experiment](./extension-experiment.md) 切片 3 记录） |

失败语义：async action 抛错时 runner 上报 `extension.action_failed`（warning、degraded，`details.action` 含 action 名）并原样 rethrow 给调用方；同步查询（`getTools`/`getCommands`/`getThinkingLevel`）只做 stale 检查不上报。reload 后 stale runner 上的任何 action 立即抛错。

Extension 贡献的 tool 在 execute context 中拿到的 host actions 走同一 runner scoped 管线；reload 会重新 resolve tools 并重建 context，因此 tool context 不会越过其 runner 的 stale 边界。

## Pi Extension 对比

Pi coding-agent extension 已经支持注册 tool/command/provider、拦截 input/tool/system prompt/provider request、发起 UI 交互、注入消息、写扩展状态、定制渲染和触发 session 操作。

Pi 的 extension model 是 runtime-first：

- Extension 是 TypeScript factory，接收 `ExtensionAPI`。
- `pi.registerTool(tool)` 注册 LLM-callable tool。
- `pi.on(event, handler)` 订阅 lifecycle、session、message、tool、input、provider 等事件。
- `pi.registerCommand()`、`registerShortcut()`、`registerFlag()`、`registerProvider()` 把扩展能力接入 CLI/TUI/model runtime。
- Extension runner 管理 auto-discovery、project trust、reload、stale context、extension errors、UI context 和 command context。
- 同名 extension tools 在 runner 内 first registration wins；合成到 session tool registry 时 extension/custom tools 可以覆盖 built-in tools。

WIDI 的当前形态更偏 core-first：

- 已有 `ToolDefinition`、`ToolDefinitionPatch`、`ToolSource` 和 `ToolRegistry`。
- `ToolRegistry.defineTool(tool, source)` 使用 first registration wins；后续同名 define 只产生 diagnostic。
- `ToolRegistry.patchTool(targetToolName, patch, source)` 按注册顺序应用；后注册的 `aroundExecute` 包在外层。
- Patch 可以修改 model-facing contract，也可以包装或替换 execute；contract risk 和 field conflict 会进入 `CoreDiagnostic`。
- Orchestrator 已能把 resolved tools wrap 成 Pi `AgentTool`，并通过 raw `agent_harness_event` 转发 Pi tool events。

因此 WIDI 已经具备 extension runner MVP 和 tool registry 底座，但还没有具备 Pi coding-agent 那种可交付 extension runtime。

### Extension Readiness

当前结论：**已经可以继续开发 runner 能力和内部验证 extension；还不适合把第三方/product extension 作为稳定交付面。**

已具备：

- Tool definition/patch 的稳定 core API，不再暴露 contribution DSL 或 priority。
- Tool source provenance，可用于 diagnostics、inspect facts 和未来 extension context。
- Patch composition、`aroundExecute` context 绑定、human request 和 execution env adapter。
- Raw Pi harness events，可供 UI 和未来 extension host 观察 tool call/run。
- CoreDiagnostic 管道已能承载 tool/profile/model/session 等模块的结构化问题。
- 内存 factory loader、file/module loader、project trust gate、reload、observer/interceptor MVP、extension input command MVP、scoped registry overlay、own-agent scoped actions、inspect facts 和 session custom entry MVP。

仍缺：

- Extension API：已具备 `registerTool`、activation-time `patchTool`、`registerCommand`、`observe` 和 MVP `intercept`；后续仍需设计 resource/provider registration 等入口。
- Hook event matrix：已落地 observer 与四个 MVP interceptor；provider/session hook、mutate 行为和更多返回值合成仍需继续设计。
- Extension-owned storage；session `custom` entry 已有 MVP，但 fork/compaction/export/custom_message policy 未定义。
- Product presentation：`agent.inspect` 已有 facts，但还没有产品级 UI/RPC 呈现。

Hook matrix、provider/resource registration、extension-owned storage 的推进已收编为 ME milestone，总方案（目标公式、pi 能力对照表、裁决原则、切片）见 [Extension Experiment](./extension-experiment.md)；product presentation 移入 backlog 随 client adapter 举证。等这些边界稳定后，再把 team/flow/goal 类 extension 作为 product surface；coding tools 已裁决为 core built-in（见 DESIGN.md），不再依赖 extension 形态交付。

## 非职责

- 不私有维护 agent lifecycle。
- 不私有维护跨 agent 通信。
- 不直接修改持久 profile/session 文件。
- 不把 extension runtime state 当作可恢复 core state。
- 不把 extension-owned storage 升格为 core persisted state。
- 不绕过 tool registry 直接替换产品内置 tool runtime object。
- 不把 Pi `custom` entry 用作大型 extension 数据库。

## TODO

Extension 后续任务按 milestone 维护在 [Milestones](../TODO.md) 与 [Backlog](../BACKLOG.md)。模块执行顺序见 [Runtime Lifecycle](./runtime-lifecycle.md)。本文件只保留 extension 机制边界、当前能力和与 Pi coding-agent 的差异。
