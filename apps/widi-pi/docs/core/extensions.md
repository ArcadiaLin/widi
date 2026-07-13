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

Extension 可以拥有自己的 storage，core 不代管。

Extension 的状态需求三分（ME 切片 7 裁决）：与当前 session 强相关的小型状态走 session custom entry（core 提供的唯一 storage 通道，契约见下）；读 runtime 事实走 scoped actions / inspect；大型 artifact、多 session index、产品模式状态由 extension 经 `exec` 与自有文件自理。core 不分配 per-extension 目录或 KV API——无 consumer 举证，且会带出多进程写入、reload、trust 边界等新裁决面；真实需求出现时再评估（举证缺口见 BACKLOG）。

Custom entry 是 extension-owned 恢复通道，契约已成文（ME 切片 7 定案）。

Runtime context 暴露 `ctx.session.appendEntry()` / `ctx.session.findEntries()`。Core 不提供共享 state layer，也不解释 `custom` entry 的 data shape：

- Namespace：extension 传入 local type，core 落库为 `extension:<extensionId>:<localType>`，读取时返回 local type；extension 读不到其他 extension 的条目。
- 写入 append-only，不提供 delete/update；读取范围是 current branch path，返回 root-to-leaf 顺序。
- Fork：custom entry 是分支事实。fork 复制 fork 点的 path-to-root，路径上的条目随 fork 带走，分叉点之后的留在源分支；无 per-extension 迁移 hook，extension 经 `agent_session_forked` observed 事实自行补种。
- Compaction：零影响。custom entry 不进模型 context，compaction 只追加 compaction entry、不删除条目，`findEntries` 可见性不变——custom entry 是存储事实，不是 context 事实。
- Export：core 无 export 面；条目经 `getAgentSessionTree` 事实可达，渲染归 client adapter（与 renderer 通道的 client 裁决同族）。
- Missing extension / version mismatch / restore failed：条目原样保留。custom entry 是 session 的存储事实，不随 extension 可用性删除或隐藏；持久 type `extension:<extensionId>:<localType>` 经 `getAgentSessionTree` 仍可达，只是无人再以 `findEntries` 消费。孤儿条目如何向用户展示归 client adapter，且依赖切片 10 的 `extension.version_incompatible` 语义（举证缺口见 BACKLOG）。
- `custom_message`（持久 + 进模型 context + extension 归因的第四条消息通道）不做：`prompt`/`followUp`、custom entry、`context` interceptor 三条既有通道覆盖其余组合，唯一缺口组合无 consumer；差异接受，举证缺口见 BACKLOG。

这层能力用于“当前 session 可恢复 extension 状态”，不是 extension 私有数据库。WIDI-owned tools 的可恢复数据走 Pi tool call arguments、tool result `content` 和 typed `details`。

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
- Extension command 通过 `registerCommand()` 注册 UI-neutral 事实（name、trigger、description、argumentHint）与执行形态：line 命令带 `handler(argument, ctx)`，inline 命令带 `expand(argument)`（ME 切片 7 接入，契约见下文 Extension inline expand 节）。所有 command 由 orchestrator `inputAgent` 按统一 trigger 模板解析、门控并执行。契约详见 [Command Experiment](./command-experiment.md)（`inputInvoke` 字段名随收编退役）。
- Orchestrator 已将 `before_agent_start`、`context`、`tool_call`、`tool_result` 四个 harness hook 桥接到 interceptors；`inputAgent` 直接驱动 WIDI 原生 `input` interceptor（契约见 Input 拦截契约节）。
- Orchestrator 已通过 `_emit()` 唯一桥接将 canonical command/human/diagnostic/agent/session 事实送到 own-agent observers；Pi `AgentHarnessEvent` 仍只经 raw `agent_harness_event` 原样透传，observer error 变成 `extension.handler_failed` diagnostic。
- Runner 使用 lazy context：`bindCore()` / `bindCommandContext()` 后，handler 通过 `createContext()` / `createCommandContext()` 获取 own-agent scoped actions 与 session custom entry facade（全量 `dispatch` 已随 M1 移除；own-agent scope 收敛已随 ME 切片 3 落地，契约见下文 Scoped Actions 节）。
- Human request action 回到 orchestrator 主路径；request lifecycle 由 `human-request.ts` 的 `HumanRequestBroker` 管理，extension 不直接选择 client 或持有 pending request。
- `agent.inspect` 已能暴露 loaded extensions、registered hooks、commands、tool contributions、patches、diagnostics 和 stale state。
- Interceptor 按注册顺序串行执行；合成类跳过失败者并保留其余结果，`tool_call` 失败 fail-closed。详细契约见下一节。
- 仓库内真实 consumer `tests/extensions/audit-extension.ts` 只使用 activation API 与 callback context，组合 raw/canonical observers、`tool_call` interceptor、scoped human request 和 session custom-entry 账本；其集成测试是 observer 路由、interceptor 失败语义与 scoped actions 的锚点回归。

这些能力足够验证 ToolRegistry、首批 hook matrix、diagnostics、reload、input command 和 session custom entry 的主路径。仍不足以作为稳定第三方 extension surface：provider/resource registration、可取消 session/provider hooks、product presentation 和完整 RPC adapter 尚未收口。

### Hook matrix 与 Observer 失败语义

Hook point 是 extension 运行时插入点的总称，不是 observer/interceptor 之外的第三套 API。注册执行通道有 `observe()` 与 `intercept()` 两条；语义档位分 observe / intercept / mutate，其中 mutate 当前也经 `intercept()` 注册。`context.actions` 是 callback 内主动调用受控 core 能力的另一条轴，不属于 hook 档位。

`observe(name, handler)` 的 payload 按 event name 自动收窄；handler 返回值被忽略，按 extension 注册顺序串行执行。Canonical Orchestrator 事实直接复用 `OrchestratorEvent`，Pi harness 事实只通过 raw `agent_harness_event` 暴露：

| 插入点 | Canonical source | 档位 | 返回值 / 失败语义 | Scope |
| --- | --- | --- | --- | --- |
| Pi agent/turn/message/tool execution、compact/tree、model/thinking update | raw `agent_harness_event` | observe | 返回值忽略；失败产生 `extension.handler_failed`，后续 observer 继续 | own agent |
| `command_detected/accepted/completed/rejected/failed` | `OrchestratorEvent` | observe | 同上 | `event.agentId` 对应 runner |
| `human_request_pending/resolved/timeout/cancelled` | `HumanRequestBroker` → `OrchestratorEvent` | observe | 同上 | agent-scoped 请求送所属 runner；global 请求不广播 |
| `diagnostic` | `OrchestratorEvent` | observe | 同上；observer 处理中产生的 diagnostic 不回灌 observer | `diagnostic.agentId` 对应 runner；global diagnostic 不广播 |
| `agent_spawned` / `agent_resumed` | `OrchestratorEvent` | observe | 同上；是 WIDI 的 session-start 事实对应物 | 新 runner 自身 |
| `agent_session_info_changed` / `agent_session_forked` | `OrchestratorEvent` | observe | 成功后发布，不具备取消语义 | 源 agent |
| `input_transformed` / `input_blocked` | `OrchestratorEvent` | observe | 拦截结果的成功事实（原文、改写/拒绝、extension 归因） | 源 agent |
| `before_agent_start` / `context` / `tool_result` | Pi typed hook | mutate | 返回值按下节规则合成 | own agent |
| `tool_call` | Pi typed hook | intercept | 可 block；失败 fail-closed | own agent |
| `input` | WIDI orchestrator hook（`inputAgent`） | intercept + mutate | 可改写可 block；失败 fail-closed；规则见下节 | own agent |

Orchestrator `_emit()` 是 canonical observer 的唯一桥接点，顺序为 core listeners → clients → own-agent extension observers。一个 observer 抛错不改变原 runtime 操作结果；diagnostic 仍写 AgentRecord 并发给 core listeners/clients。为避免 `diagnostic → observer failure → extension.handler_failed → diagnostic observer` 无限反馈，observer dispatch 期间产生的 diagnostic 不再次送入 extension observers。Stale runner（agent dispose 后仍留在 record 上）不再接收任何 observer 事件——stale context 的动作面只会失败；reload 场景事件送当前 runner。

Pi 的 `session_before_switch` 在当前 WIDI 中没有对应物：WIDI 的 new/resume 创建另一个 runtime Agent，不原地替换当前 session。`disposeAgent()` 也没有关闭 SessionManager 中的 session，因此当前不发布 `session_shutdown` 伪事实。compact/tree/model/thinking 已在 raw harness event 中完整可达，不增加同义事件轨道。

### Interceptor 合成与失败语义

Observer 与 interceptor 是两条不同路径。四个 Pi harness interceptor 直接接收 Pi 的 typed hook event，并返回对应的 Pi hook result，不经过 orchestrator event 转换；`input` 是首个 WIDI 原生 interceptor，由 orchestrator `inputAgent` 直接调用 runner，event/result 契约归 WIDI（`ExtensionInputEvent` / `ExtensionInputResult`）。Orchestrator 只负责连接 hook 源与 runner、记录 diagnostics，并把 runner 的结果交回调用方。

五个 interceptor 均按 extension 注册顺序串行执行：

- `before_agent_start`：成功 handler 的 `messages` 依次追加；最后一个成功提供的 `systemPrompt` 胜出。
- `context`：管线式改写；后一个 handler 接收最近一次成功 handler 返回的 `messages`。
- `tool_result`：管线式逐字段改写；后一个 handler 接收当前已合成的 result。`content`、`details`、`isError` 由最后一个成功提供该字段的 handler 胜出，`terminate: true` 一旦出现即保留。
- `tool_call`：第一个返回 `block: true` 的 handler 立即终止管线，其 `reason` 原样返回。
- `input`：管线式改写 + 短路阻断的组合。后一个 handler 接收当前已改写的 `text`/`images`（transform 省略 `images` 时保留当前值）；第一个返回 `{ block: true }` 的 handler 立即终止管线。不提供 pi 的 `handled` 语义：消费输入自行处理 = block（留下可观察拒绝事实）+ scoped actions；接管命令语法走 `registerCommand`。

`before_agent_start`、`context`、`tool_result` handler 抛错时，runner 产生 `extension.handler_failed` diagnostic，只丢弃该 handler 的结果并继续执行后续 handler；此前与此后的成功结果都保留。多个失败分别产生 diagnostic。若没有任何成功 handler 返回结果，harness 按无拦截结果继续。

`tool_call` handler 抛错时 fail-closed：runner 产生同一 diagnostic，并立即返回 `{ block: true }`，后续 handler 不再执行。Pi harness 使用默认 blocked tool result 文案，当前 tool call 不会执行；agent/runtime 本身不进入 unavailable，可继续后续交互。异常消息与 extension 身份只进入 diagnostic，不注入 model-facing tool result。

`extension.handler_failed` 当前保持 warning、degraded、recoverable：失败会降低 extension runtime 能力，但合成类仍可继续，`tool_call` 也通过安全阻断收敛在单次调用内。

### Input 拦截契约（ME 切片 6）

`input` 拦截发生在 `inputAgent` 的 command 解析**之前**，包括 `options.commands === false` 与 profile 禁用 command 的短路路径——它是输入 hook 不是 command hook，调用方无法用开关绕过输入策略。拦截只运行一次；改写产物重新进入完整解析/gateway/inline expand 管线，不存在拦截递归。extension 经 scoped actions 发起的 `prompt`/`steer`/`followUp` 不经过该 hook（归因已由 operation source 承担，差异记录见 extension-experiment.md 对照表）。

失败语义 fail-closed：任一 handler 抛错即产生 `extension.handler_failed` diagnostic 并拒绝整条输入，后续 handler 不再执行——输入策略不许因自身崩溃被绕过（与 `tool_call` 同族裁决；代价是 extension 故障对用户输入更具侵入性，用户可见拒绝并可重试）。

拦截结果发布为 canonical 事实：改写发 `input_transformed`（inputId、原文、终文、`transformedBy` 按应用顺序归因），拒绝发 `input_blocked`（inputId、原文、reason、`blockedBy`——主动 block 或 crash fail-closed 的责任 extension，diagnostic 区分两者）。`inputAgent` 对拒绝返回 `InputResult` 的 `blocked` 形态。同一输入的 transform 事实与 inline expansion 事实共享 inputId。模型可见文本与人类原文的差异因此全程可审计，与 inline expand 的 dual-record 属同一纪律；改写事实的 session 持久化已随 ME 切片 7 落地（见下节）。

### Extension inline expand 与 input 持久化（ME 切片 7）

`registerCommand({ placement: "inline", expand })` 注册 inline 展开命令：

- 触发域固定为 built-in inline 语法 `<name:argument>`（`INLINE_COMMAND_TRIGGER` / `INLINE_COMMAND_CLOSE_TRIGGER`），不开自定义 trigger；extension inline 命令与 built-in `<prompt:>` / `<skill:>` 走同一条扫描管线。
- `expand(argument)` 只收参数字符串、返回替换文本——「展开无副作用」靠 API 形状强制（回调拿不到 context/actions 句柄），展开所需数据在激活期闭包携带；与补参回调只收 `argumentPrefix` 是同一 narrowing 先例。
- 与 built-in 或同名命令冲突沿用 rename-with-provenance（built-in 是保留字）；gateway、argumentsCompletion、`core:command_expansion` dual-record、all-or-nothing 失败语义全部沿用 command 管线。extension expand 抛错发 `command_failed`（source: extension），整条输入丢弃，不产生半展开 prompt。
- Stale runner 的 inline 命令不参与扫描与展开，token 保持字面文本进入 prompt。

Input 拦截事实的 session 持久化（切片 6 遗留裁决）：改写落 core-owned `core:input_transform` custom entry（inputId、原文、终文、`transformedBy`），与 `core:command_expansion` 同一 dual-record 纪律——session 只承载模型可见的终文，人类原文必须在 resume 后可复原。拒绝不落 entry：被 block 的输入没有任何东西进入 session，无 session 状态需要解释；要账本的策略 extension 自己写（audit consumer 的 denyInput verdict 已示范）。

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
- Hook event matrix：canonical command/human/diagnostic/agent/session/input facts 与 raw harness observer 已落地，五个 MVP interceptor（四个 Pi harness hook + WIDI 原生 `input`）已标明 intercept/mutate 档位与失败语义；provider hook、可取消 session hook 和更多返回值合成仍需继续设计。
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
