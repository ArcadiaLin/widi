# Extension Experiment

> **状态：ME milestone 十一个切片（0–10）已全部落地（2026-07-13）。**
> 本文档是 extension surface 从 MVP 走向可交付扩展面的总方案：目标公式、与 pi-coding-agent 的逐项对照、裁决原则和 ME milestone 切片。机制边界与当前实现见 [Extensions](./extensions.md)；本文档只记录差距、裁决与推进顺序。每个大切片落地前按 M4 原纪律产出/更新裁决段（并入本文档，不另开散文件）。

## 目标公式（2026-07-07 裁决）

```
WIDI extension 自由度 =
    ≥ pi-coding-agent 对 single agent 的扩展自由度
  + 对 Orchestrator 行为的自由度（multi-agent、command、profile、diagnostics 等 pi 没有的面）
  - UI 层自由度（core 对 UI 的约束只到 client 为止，shortcut/renderer/flag 归 client adapter）
```

三条推论：

1. **"≥ pi" 按能力对照表逐项兑现**，不按 API 形状复刻。pi 的一个 API 在 WIDI 可能对应"原子方法 + scoped action"或"事件 + 事实查询"，形态服从 core 的所有权裁决。
2. **orchestrator 自由度是增量卖点**：command 事实面、事件轨道、profile 门控、multi-agent（M3 后）都是 pi 单 agent app 结构上没有的。
3. **UI 减法不是能力缺失**，而是位置裁决：core 保证事实可达（events、inspect、listCommands、human request），呈现自由（渲染、快捷键、CLI flag）由 client adapter 的 extension host 提供。core 里永远不出现 `ctx.ui`。

## 形状与形态：差异示例

"≥ pi 但不按 API 形状复刻"的实感对照——同一能力，pi 的形状 vs WIDI 的形态：

| pi API（形状） | WIDI 形态 | 差别的实质 |
| --- | --- | --- |
| `sendUserMessage(content, { deliverAs: "steer" })`，作用于隐含的"当前会话" | scoped action → `steerAgent(agentId, text)` 原子方法，agentId 由 context 注入 | pi 的"当前"是 app 全局隐含状态；WIDI 显式 agent 作用域，且动作落在既有方法面，事件/审计轨道免费获得 |
| `setModel(model)` 返回 `false` 表示没 API key | `setAgentModelByReference(agentId, ref)`，失败抛 `model.reference_invalid` / auth diagnostic | pi 用布尔吞掉失败原因；WIDI 的失败是结构化 diagnostic，遥测与 UI 都能解释 |
| `registerProvider(name, config)` 直接改全局模型表 | ModelRegistry contribution：registration-with-provenance + 冲突 diagnostic，auth storage 所有权不动 | pi 是"改状态"；WIDI 是"注册事实"——可追溯、可 inspect、reload 可重放 |
| `getArgumentCompletions(prefix)` 返回 TUI 的 `AutocompleteItem[]` | `arguments.getArgumentsCompletion(prefix)` 返回 `CommandCandidates`，同一份事实喂 client 补全与 argumentsCompletion human request 兜底 | pi 的候选只活在自家 TUI；WIDI 的候选是 UI 中立事实，stdout/RPC client 也走得通（已落地） |
| `ctx.ui.confirm/select/input(...)` 直接驱动 UI 控件 | `requestHuman({ kind, options, allowFreeInput, payload })` 能力中立信封 | 渲染契约归 client（见 command-experiment.md Client 渲染契约）；core 表达的是"需要人类裁决"这个事实，不是控件 |
| `registerMessageRenderer(customType, renderer)` | 无 renderer 通道：extension 写 custom entry / 发事件，client adapter 自行渲染 | 呈现自由从 core 移到 client；core 的义务是事实可达，不是像素 |
| `on("session_before_compact", handler)` 返回值语义靠实现约定 | interceptor 带声明档位 + 返回值合成规则 + 成文失败语义 | pi 的 hook 行为散在实现里；WIDI 每个 hook 的 observe/intercept/mutate 档与失败语义是可引用的裁决 |

规律：pi 把自由度给成**方法**（隐含当前会话、直接改状态、直连 UI），WIDI 把同一自由度给成**事实与受控入口**（显式作用域、注册与事件、能力中立请求）。多付的代价是形态设计，换回的是审计轨道、multi-agent 安全和任意 adapter 的可呈现性。

## 能力对照表

基线：pi `ExtensionAPI`（`pi/packages/coding-agent/src/core/extensions/types.ts`）。归属三类：**core**（WIDI core 落地）、**client**（UI 减法，归 adapter）、**backlog**（无 consumer 举证或依赖未就绪）。

### 事件/hook

| pi | WIDI 现状 | 归属 |
| --- | --- | --- |
| `before_agent_start` / `context` / `tool_call` / `tool_result` | 四个 interceptor 已有（runner MVP） | core，已落 |
| `agent_start/end`、`turn_start/end`、`message_*` | raw `agent_harness_event` observer 可达 | core，已落（归一化档不做，raw 够用，见裁决 3） |
| `tool_execution_*` | raw `agent_harness_event` observer 可达 | core，已落（与其他 harness events 共用唯一口径） |
| `session_start` | canonical `agent_spawned` / `agent_resumed` observer 可达 | core，已落（切片 5；WIDI 创建新 runtime agent，不复刻“替换当前 session”形态） |
| `session_info_changed` / `session_before_fork` | canonical `agent_session_info_changed` / `agent_session_forked` observer 可达 | core，已落（切片 5；observe 档只发布成功事实，fork 可取消的 intercept 档仍按举证开放） |
| `session_before_compact` / `session_compact` / `session_before_tree` / `session_tree` | raw `agent_harness_event` observer 已可达 | core，已落（不增加同义别名） |
| `session_before_switch` / `session_shutdown` | 当前无真实对应：agent 不原地切换 session，dispose 也不关闭 SessionManager 中的 session | 差异接受；出现 session replacement/close 所有权后再评估，不发布伪事件 |
| `model_select` / `thinking_level_select` | 运行时变化由 raw `model_update` / `thinking_level_update` 可达；初始模型由 `agent_spawned` / `agent_resumed` 可达 | core，已落（切片 5 完成矩阵裁决，不增加归一化副本） |
| `input` | `intercept("input")` 于 `inputAgent` command 解析前拦截，可改写/拒绝，fail-closed | core，已落（切片 6）；pi 对 extension 发起消息（source: extension）的覆盖为差异接受——scoped `prompt`/`steer`/`followUp` 不过 input hook，归因由 operation source 承担 |
| `before_provider_request`、`after_provider_response` | `intercept("before_provider_request")` streamOptions patch 管线（mutate 档，失败跳过）；`after_provider_response` 经 raw `agent_harness_event` 可达 | core，已落（切片 9；pi harness 三 hook 全暴露，评估完成）。`before_provider_payload`（改 wire payload）最锋利且难审计，backlog 等举证 |
| `user_bash` | 无 bash 能力 | backlog（依赖未来 bash tool 能力） |
| `project_trust` | loader trust gate（声明式，非 hook） | core，已落；差异接受，不做 hook 化 |
| `resources_discover` | `contributeResources()` 激活期路径声明 | core，已落（切片 8）；不复刻 hook 形态，reload 重激活即重声明 |

WIDI 独有（pi 无对应）：`command_detected/accepted/completed/rejected/failed`、agent-scoped `human_request_*`、diagnostics 流的 observer 档已随 ME 切片 5 桥接；`input_transformed`/`input_blocked` 拦截事实随切片 6 补入（pi 的 input hook 无可观察轨道）。global human request/diagnostic 不广播给 per-agent runner。command/human/input 事件补齐 `agentId` 路由事实，这也是审计 extension 的主粮。

### 注册面

| pi | WIDI 现状 | 归属 |
| --- | --- | --- |
| `registerTool` | 已有，且多 `patchTool`（pi 无 patch 语义） | core，已超出 |
| `registerCommand` | 已有，且 trigger/placement/arguments 是声明事实、走统一事件轨道与 gateway | core，已超出；extension inline `expand` 已接（切片 7，`expand(argument)` 无副作用靠形状强制） |
| `registerProvider` / `unregisterProvider` | `registerProvider()` 激活期声明，registration-with-provenance，只许新 provider 名；unregister 由 runner 生命周期自动收尾（reload/dispose），不提供手动形态 | core，已落（切片 9）；pi 的 provider override（改内置 baseUrl 的代理场景）不收编，override 通道归 models.json；OAuth login 发起面 backlog |
| `registerShortcut` / `registerFlag` / `getFlag` | 无 | client |
| `registerMessageRenderer` / `registerEntryRenderer` | 无 | client |

### 动作/查询面

| pi | WIDI 现状 | 归属 |
| --- | --- | --- |
| `sendMessage` / `sendUserMessage`（steer/followUp/nextTurn） | scoped `prompt`/`steer`/`followUp` 已暴露 | core，已落（切片 3）；custom message 通道裁决不做（切片 7）——「持久 + 进 context + extension 归因」组合无 consumer，差异接受入 backlog |
| `appendEntry` / `findEntries` | session custom entry 成文契约 | core，已落；fork/compaction/export policy 已定案（切片 7），custom entry 是 core 唯一 storage 通道 |
| `setSessionName` / `getSessionName` | scoped `setSessionName` 已暴露 | core，已落（切片 3） |
| `setLabel` | pi session label，WIDI 无对应 | backlog（upstream 对齐项） |
| `exec` | scoped `exec` 已暴露，project trust 门控 | core，已落（切片 3，trust 裁决见切片记录） |
| `getActiveTools` / `getAllTools` / `setActiveTools` | scoped `getTools`/`setTools`/`setActiveTools` | core，已落（own-agent scope 已随切片 3 收口） |
| `getCommands` | scoped `getCommands` 已暴露 | core，已落（切片 3，与 client 同一门控口径） |
| `setModel` / `get/setThinkingLevel` | scoped `setModel`/`getThinkingLevel`/`setThinkingLevel` 已暴露 | core，已落（切片 3） |
| `events`（extension 间 EventBus） | 无 | backlog（无 consumer 举证） |
| `ctx.ui` / `hasUI` / `mode` | 无 | client；core 的对应物是 `requestHuman` |

## 裁决原则

1. **Scope-by-default**：context 注入 agentId，actions 默认锁定 own agent；跨 agent 操作只经 M3 collaboration facade 并受 `capabilities` 门控。这是 review 问题 3 的机制化，不再靠纪律（切片 3 已落地：action 签名不出现 agentId）。
2. **Narrowed context**：extension 回调永远拿不到 orchestrator 句柄；每项能力以最小事实进出（先例：command 补参回调只收 `argumentPrefix`，`runner.ts` 的 `toCommandArguments`）。
3. **Raw 是唯一口径，归一化按举证**：harness 事件只以 raw `agent_harness_event` observe 暴露，不为想象中的消费者建第二套归一化事件。原 `tool_lifecycle_event` 在 extension 完善前删除：仓库内没有真实 consumer，转换只改名、丢失部分 Pi 字段并造成双轨。只有出现至少两个真实 consumer 重复解析同一 raw 流，且能举证需要新增的共同语义时，才重新评估派生协议。
4. **每个 hook 标档位**：observe / intercept / mutate 三档在对照表与实现中一一对应；开 intercept 档必须同时写失败语义与返回值合成规则。
5. **Registration-with-provenance**：一切贡献面（tool 已有、command 已有、resource/provider 待落）沿用 ToolRegistry 模板——first-registration-wins + diagnostic、来源可追溯、inspect 可见。
6. **UI 减法的补偿义务**：每砍一个 pi 的 UI API，对照表必须写明 core 的事实对应物（renderer → events+custom entry；shortcut/flag → client host；`ctx.ui` → human request），不许出现"砍了但事实不可达"的洞。

## ME Milestone 切片

锚点 consumer：**审计/策略 extension**（观察全事件流、拦截 tool_call/input、按策略 reject；仓库内真实测试 consumer，非示例骨架）。ME 实施所需的 M2 条目已直接迁入本 milestone（切片 0 与切片 2，2026-07-07 裁决）——extension 是当前注意力焦点，不让地基项散在别的 milestone 里等排期。切片按依赖排定，每片独立可验收：

0. **tools 布局清理 + tool 契约类型迁 core 层**（零行为变化布局 commit，原 M2 条目合并迁入，已完成 2026-07-09）。占位清理实际清单与原表述略有出入：`coding/` 剩余 4 个空占位（read/write/edit 已实现）+ 重复 re-export 的 `tools/index.ts` + `agent-collaboration/` 5 个零引用占位，连同 `examples/` 遗留代码一并删除。tool 契约 7 类型（`ToolDefinition`/`ToolDefinitionPatch`/`ToolSource`/`ToolExecute`/`ToolExecuteMiddleware`/`ToolExecutionContext`/`ToolExtensionContext`）从 `extension/types.ts` 迁至 `tools/types.ts` 真实定义，extension 层反向消费并兼容 re-export，`tool-registry.ts` 改从 tools 层 import——依赖倒置（review 问题 7）解除。随后无 consumer 的 `ToolLifecycleEvent` 转换轨道在 extension 完善前删除，统一回到 raw Pi event 口径。
1. **Interceptor 失败语义定案 + 实施**（原 M2 条目迁入，已完成 2026-07-10）。合成类 hook（`context`、`before_agent_start`、`tool_result`）按注册顺序合成，跳过失败者并保留其余 extension 结果；`tool_call` 拦截失败 **fail-closed**，立即 block 当前 tool call 并产生 diagnostic。Runner 单元测试覆盖三类合成管线与失败短路，orchestrator 集成测试覆盖 diagnostic/结果透传；完整契约见 [Extensions](./extensions.md)。
2. **Orchestrator 公开面收口**（原 M2 条目迁入，已完成 2026-07-10）。`agents` map 私有化为 `_agents`；`getAgentHarness()` 删除（存在性事实的公开对应物是 `AgentRecordSnapshot.hasHarness`）；`spawnAgentHarness` 改名 `spawnAgent`，只返回 `Promise<AgentId>`（options 类型同步改名 `SpawnAgent*Options`）。顺带收紧：可变 `AgentRecord` 类型不再从 orchestrator re-export，公开面只剩 `AgentRecordSnapshot`；grep 验收成立——公开面不存在返回 `AgentHarness` 或可变 `AgentRecord` 的路径。增补 `getAgentThinkingLevel(agentId)` 原子 getter，使对照表"get/setThinkingLevel 原子方法在"的表述与代码一致（getter 此前缺失），测试是首个 consumer，切片 3 scoped actions 直接复用。测试的白盒需求（phase 模拟、hook handler 抽取、extensionRunner 访问）经测试内 helper 显式 cast 私有 `_agents`，不再构成公开契约。
3. **ExtensionActions scope 化 + 能力面补齐**（已完成 2026-07-10）。agentId 由 context 注入：`ExtensionActions` 全部 action 签名不再出现 agentId（`getTools`/`setTools`/`setActiveTools`，旧 `getAgentTools(agentId)` 形态删除）；orchestrator↔runner 绑定契约为 `ExtensionCoreActions`（agentId 显式，不属于作者 API），收窄单点在 runner `createContext(extensionId)`。补齐 scoped 动作/查询面：`prompt`/`steer`/`followUp`（plain 形态，custom message 等切片 7 policy）、`setSessionName`、`getCommands`、`setModel`/`getThinkingLevel`/`setThinkingLevel`、`exec`。`requestHuman` 收窄为 `HumanRequestDraft`，source 由 runner 注入 `{ kind: "extension", extensionId }` 不可伪造；`capabilities.canRequestUser === false` 时拒绝并抛 `extension.human_request_denied`——该 capability 的首个消费者落地，BACKLOG 对应条目划掉。**exec trust 裁决**：exec 是项目 cwd 内的任意命令执行，正属 project trust 门控的风险类；且 untrusted 项目当前只排除 cwd 来源的 extension discovery root，global/agent-dir extension 仍会加载，不设门则 untrusted 项目内容可经由它们间接执行。故 `settingManager.isProjectTrusted()` 未通过时 exec 一律拒绝并抛 `extension.exec_denied`，命令不执行（代码锚点：orchestrator `_createExtensionActions` 的 exec 分支；deny/allow 均有回归测试）。exec 形状跟 WIDI `ExecutionEnv.exec(command, options)`，不复刻 pi coding-agent 的 `(command, args)` 形状。extension 贡献 tool 的 execute context host actions 复用同一 runner scoped 管线（reload 重建 context，不越 stale 边界）。失败语义沿用 `extension.action_failed` 上报 + rethrow。契约全文见 [Extensions](./extensions.md) Scoped Actions 契约节。
4. **审计锚点 extension 落库**（已完成 2026-07-10）。`tests/extensions/audit-extension.ts` 是完整 factory consumer，不是 inline fixture：订阅唯一 raw `agent_harness_event` 轨道并按 policy 白名单写 `event` custom entry；拦截 `tool_call`，支持默认 allow、显式 deny 和 ask 三种裁决，所有 verdict 写入 namespaced custom-entry 账本。**落库位置裁决**：当前唯一 consumer 是回归测试，故先落 `tests/extensions/`；product preset 有真实引用时再毕业到 `src/`，不以“将来可能内置”为由提前增加产品代码。**ask 失败语义裁决**：ask 通过 scoped `requestHuman` 发起，source 注入与 `canRequestUser` 门控沿用切片 3；人类拒绝、返回非 allow 或 action 抛错（含 capability denial）均 fail-closed 为当前 tool call block，并把 `human` / `human_unavailable` verdict 写账本。六条独立集成测试覆盖 event/default allow、deny、ask allow/deny、capability denial 降级、他人 observer 抛错仍记账、他人 `tool_call` 抛错先阻断且后续审计仍工作，反向检验切片 1/3。测试只通过 `ExtensionFactory` activation API 与 callback context 消费 extension 能力；获取 runner/harness 仅属于测试驱动 hook 和读取账本的白盒设施，不构成 extension 依赖。
5. **Hook matrix 第一批（observe 档）**（已完成 2026-07-10）。`ExtensionObservedEvent` 直接提取 canonical `OrchestratorEvent`，`observe(name, handler)` 按 name 自动收窄 payload；Orchestrator `_emit()` 是唯一桥接点，沿用 core listener → client → own-agent runner 的顺序。五类 `command_*` 补齐 `agentId`；四类 `human_request_*` 由 broker 保存可选 agent route，extension 发起的 request 通过隐藏路由参数关联 runner，operation source 仍是不可伪造的 `{ kind: "extension", extensionId }`；agent-scoped diagnostic 只送所属 runner，global 事实不向每个 runner 复制。observer 失败继续生成 `extension.handler_failed` 并不改变原操作；observer 处理期间产生的 diagnostic 仍记录并发给 core consumer，但不回灌 diagnostic observer，避免反馈递归。session 能力按 WIDI 事实落地：`agent_spawned`/`agent_resumed` 作为 start，新增成功后的 `agent_session_info_changed`/`agent_session_forked`；原地 switch 与真实 session shutdown 当前不存在，明确不造伪事件。compact/tree/model/thinking 已由 raw harness event 可达，只修正文档漂移、不建第二轨。审计 consumer 扩展到 canonical command/human/diagnostic/session 账本，覆盖双 agent 隔离、global 不广播及 diagnostic observer 失败只发布一次。
6. **`input` interceptor**（已完成 2026-07-13）。原裁决（2026-07-07）：拦截发生在 `inputAgent` 的 command 解析**之前**，改写后的文本重新走完整解析与 gateway，不许绕过。落地时补充四项裁决：**(a) 失败语义 fail-closed**——handler 抛错即拒绝整条输入并产生 `extension.handler_failed`，与 `tool_call` 同族（输入策略不许因崩溃被绕过），接受对用户输入更具侵入性的代价；**(b) 触达面为 `inputAgent` 全路径**——含 `commands: false` 与 profile 禁用 command 的短路路径，调用方无法用开关绕过策略；extension 经 scoped actions 发起的消息不拦（pi source: extension 覆盖为差异接受，归因已由 operation source 承担，且避免 extension 互拦递归）；**(c) 不收编 pi 的 `handled`**——结果只有放行/改写/`{ block, reason }`，handled 实质是第二条私有输入通道，与 M1"唯一 command 入口"验收冲突；消费输入自行处理 = block + scoped actions，接管命令语法 = `registerCommand`；**(d) canonical 事实**——`input_transformed`/`input_blocked` 进 `_emit()` 唯一桥接并加入 observe 白名单，携带 inputId（与同一输入的 inline expansion 事实共享）、原文与 extension 归因，`InputResult` 增加 `blocked` 形态；session 级持久化留待切片 7 storage policy。实现注：拦截只运行一次（改写产物进解析管线，无递归）；管线合成 = `context` 式改写 + `tool_call` 式短路；比 pi 更早——pi 的 input hook 实际在 extension command 处理之后才 fire，WIDI 的策略 extension 连他人 command 调用也拦得到。审计 consumer 增补 `denyInput` 策略与 input-verdict 账本，回归覆盖改写重解析、短路禁用路径、fail-closed 与双通道账本。契约全文见 extensions.md Input 拦截契约节。
7. **Extension-owned storage 裁决 + custom entry policy**（已完成 2026-07-13）。四项裁决：**(a) storage 通道形态**——session custom entry 是 core 提供的唯一 extension storage 通道；core 不分配 per-extension 目录/KV API（无 consumer 举证，且带出多进程写入、reload、trust 边界等新裁决面，入 backlog 待举证），大型 artifact 与跨 session 状态由 extension 经 `exec` 与自有文件自理；SettingManager 评估中「自己的状态」三分就此闭合。**(b) custom entry policy 定案**——fork：分支事实，随 fork 点 path-to-root 复制，分叉点之后留在源分支，无 per-extension 迁移 hook（`agent_session_forked` 是补种信号）；compaction：零影响（custom entry 是存储事实非 context 事实，pi compaction 只追加不删除，`findEntries` 可见性不变）；export：core 无 export 面，条目经 `getAgentSessionTree` 可达，渲染归 client。custom entry 自此升格为成文契约，解除「不对第三方承诺稳定」的保留。**(c) `custom_message` 不收编**——pi 第四条消息通道（持久 + 进模型 context + extension 归因）的独有组合无 consumer；`prompt`/`followUp`（持久 + in-context，user 归因）、custom entry（持久 + 非 context）、`context` interceptor（in-context + 每轮重建）覆盖其余格，且 pi 该能力一半价值在 display/renderer——已裁决归 client。差异接受 + backlog 举证缺口。**(d) input 拦截事实持久化（切片 6 遗留）**——改写落 core `core:input_transform` entry（inputId、原文、终文、`transformedBy`；与 `core:command_expansion` 同一 dual-record 纪律，resume 后原文可复原）；block 不落 entry（无物进 session，账本归策略 extension 自身，audit denyInput 已示范）。顺带落地 extension inline `expand`：`registerCommand({ placement: "inline", expand })`，触发域固定 `<name:arg>`，`expand(argument)` 只收参数字符串（无副作用靠形状强制，数据走激活闭包），冲突 rename-with-provenance（built-in 保留字），gateway/补参/dual-record/all-or-nothing 沿用 command 管线，stale runner 不参与扫描与展开。回归覆盖 runner inline 解析与冲突重命名、orchestrator 全管线与失败丢弃、input transform entry 持久化与 block 不落、fork/compaction 分支语义。契约全文见 extensions.md custom entry 契约节与 inline expand 节。
8. **Resource contribution**（已完成 2026-07-13）。六项裁决：**(a) 收编档位**——全量落地 + `tests/extensions/` 锚点 consumer（沿切片 4 先例：贡献 skill/prompt 由 `<skill:>`/`<prompt:>` 管线消费，反向检验贡献面）；真实 product consumer 推迟到 extension 切片结束后由 pi-tui adapter 举证，届时评估锚点毕业。**(b) 贡献形态**——激活期声明路径（activation API 声明 skill/prompt 路径），ResourceLoader 仍是唯一 FS 读取者与解释者，所有权不外移；不复刻 pi 的 `resources_discover` hook——WIDI runner 本就 per-agent 且 reload 重建 runner、重声明自然发生，动态 discovery 的增益当前无场景；不做内存对象注册，避免对象生命周期与序列化裁决提前。**(c) scope**——own-agent overlay：贡献只进本 agent 的 `<skill:>`/`<prompt:>` 候选与 spawn 装载，与 tools scoped overlay、切片 3 的 own-agent 收敛同族；不扩展 global roots。**(d) 冲突语义**——first-registration-wins + diagnostic（裁决原则 5 的 ToolRegistry 模板）：core 侧 profile/cwd 资源先注册故必胜，extension 同名贡献被拒并发 diagnostic；不用 command 的 rename-with-provenance，skill 名不变形。**(e) provenance**——resolved resource source 进 inspect facts（原则 5「inspect 可见」；BACKLOG 对应项随此定案）。**(f) 不建 ResourceRegistry 类**——沿 M1 不建 CommandRegistry 先例，loader 保持轻量路径解析，贡献走既有解析管线（BACKLOG「Resource registry 评估」随此定案：复杂化触发条件已到，裁决为不建）。已落地：`contributeResources()` 激活期声明（loader 归一化去重、空声明忽略）；`ExtensionRunner.getResourceContributions()` 暴露贡献事实并进 inspect snapshot；orchestrator 建 harness 时先建 runner，profile 资源与贡献路径走同一次 load-merge，冲突发 `extension.resource_conflict` diagnostic，resolved provenance（名字 + 来源 root/extension）进 agent snapshot `resources` 事实；运行时 `<skill:>`/`<prompt:>` 候选与展开消费同一合并管线，stale runner 贡献退出。锚点 consumer `tests/extensions/resource-extension.ts` 只声明路径，回归覆盖贡献装载与双管线展开、冲突丢弃（core 必胜）、provenance 事实、stale 退出与 loader 归一化。契约全文见 extensions.md Extension resource contribution 节。
9. **Provider contribution**（已完成 2026-07-13）。六项裁决：**(a) scope**——global + provenance：模型表与 models.json 同级、是进程全局共享资源（所有 harness 共享同一 pi-ai `Models` runtime），own-agent overlay 需要 per-agent Models 包装、侵入远超切片 8 的 resource overlay；与裁决原则 1 scope-by-default 的差异显式接受，生命周期仍绑 runner——注册按 (extension, agent) 记账、引用计数，reload 先撤销 stale runner 注册再重声明，dispose 撤销，最后一个 registrant 退出即移除并 `refresh()` 重建。**(b) 冲突语义**——只许新 provider 名，first-registration-wins（原则 5）：内置 / models.json / runtime 动态 / 他人 extension 的名字一律不可覆盖，drop + `extension.provider_conflict`（含 conflictWith 四分类与 owner 归因）；refresh 重放重查同一规则。pi 的 provider override（`registerProvider("anthropic", { baseUrl })` 企业代理场景）不收编：extension 静默重定向内置流量正是 provenance 纪律要防的事，用户自己的 override 通道是 models.json；受控 override 入口等举证。推论：extension 注册必须带完整 models，override-only 形态校验层拒绝（`extension.provider_invalid`）。**(c) OAuth 收编档位**——收 `oauth` 配置（refreshToken/getApiKey/modifyModels 立即可用，credential 存 AuthStorage、refresh 走 pi-ai locked refresh，所有权不移交）；login(callbacks) 是人类交互流程而 widi 无 /login 命令面，login 发起面入 backlog、对照表记缺口。**(d) provider hook 档位**——pi harness 三 hook 经 `harness.on()` 全暴露，「视暴露程度评估」有了明确答案；收 `intercept("before_provider_request")`（mutate 档：streamOptions patch 管线合成，后一 handler 见当前已合成值，runner 把净变化编码为单个 base-to-final patch；失败跳过——塑形 hook 非门禁，与 context 同族而非 tool_call 同族）；`after_provider_response` 本就经 raw `agent_harness_event` 可达，零实施、只落对照表；`before_provider_payload`（改 wire payload，unknown 类型、API 形状相关、最难审计）backlog 等举证。**(e) trust gate**——provider config 中任何 `!command` config value（apiKey、provider/model headers）经 ConfigValueResolver 走 `ExecutionEnv.exec`，构成绕过切片 3 exec 门控的侧漏；project trust 未通过时整条注册拒绝（`extension.provider_trust_denied`，fail-closed），literal/`$ENV` 不受限。**(f) 注册形态**——激活期声明唯一（同 `contributeResources` 先例），reload 重激活即重注册；不提供手动 `unregisterProvider`（生命周期自动收尾使其无场景），不做运行期动态注册（pi 的 pending-queue 复杂度随之消失）。已落地：`ModelRegistry.registerExtensionProvider`（严格校验路径 + provenance 记账 + refresh 重放）/`unregisterExtensionProviders`（per-agent 撤销）；activation API `registerProvider()`；贡献 facts（secret-free：modelIds + oauth 标志，不含 config value）进 runner inspect，registry 侧 `getExtensionProviderRegistrations()` 暴露 owner/registrants。Spawn 边界：spawn/resume 默认模型解析先于 extension 激活，贡献模型不可作 spawn 默认模型，注册于 harness 创建前完成、首轮即可 setModel 选用。锚点 consumer `tests/extensions/provider-extension.ts`（model-gateway 形态），回归覆盖注册可用、四类冲突、trust gate、per-agent 生命周期、reload 撤销/重注册、patch 合成与失败跳过；registry 单测覆盖 upsert/引用计数/refresh 重放丢弃。契约全文见 extensions.md Extension provider contribution 节。
10. **API 面冻结**（已完成 2026-07-13）。七项裁决：**(a) 冻结载体——文档 + 代码双层**。`extension/api.ts` 是作者 API 唯一 barrel（含 `EXTENSION_API_VERSION`），`index.ts` 降为内部 barrel（loader/runner/snapshot/`ExtensionCoreActions` 等内部绑定面只从这里出）；契约清单成文进 extensions.md「公开契约（API v1）」节。验收 grep 锚点：第三方验收 extension 只 import `extension/api.ts` 与清单列名的上游类型。**(b) 上游类型冻结口径——by-reference 枚举，不包装**。interceptor event/result（Pi typed hook 类型）、raw `AgentHarnessEvent`、`ImageContent`、`ThinkingLevel`、`ShellExecOptions`、`Result`/`ExecutionError`、typebox `TSchema` 显式列入契约清单；包装是一整层无 consumer 的翻译面，违背裁决原则 3（raw 是唯一口径）。代价成文：这些上游类型的破坏性变更即 extension API 破坏性变更，须 bump apiVersion。**(c) 版本形态——单调递增整数，不用 semver**。`EXTENSION_API_VERSION = 1`，只在冻结面破坏性变更时 bump；runtime 维护支持区间（当前 `[1, 1]`）。semver range 给不起：面还年轻，minor/patch 兼容承诺无人背书，且引入 range 求值依赖；整数可 grep、可测试。**(d) 声明位置——定义对象统一三种 source 形态**。默认导出（file/package）与 `registerExtensionFactory` 入参统一为 `ExtensionFactory | { apiVersion, activate }`（`ExtensionDefinition`）；不走 package.json manifest 字段——factory/file 形态没有 manifest，会裂成两套口径。**(e) 未声明默认——宽松**。裸 factory 函数视为当前版本：仓库内 extension 与 runtime 同步演进，强制声明只有噪音，且今天只有 v1、拒绝未声明不提供任何保护；契约文档注明第三方发布应当声明，v2 出现时复议严格化。**(f) `extension.version_incompatible` 语义——独立 diagnostic，不走 missing policy**。missing policy 管「声明解析不到」；版本不兼容是「找到但拒绝启用」，与 `load_failed`/`activation_failed` 同族——一律 error、blocked，factory 不进激活表。检查点在 load/注册期（版本是 extension 的属性，不是 (extension, agent) 的属性）；agent 引用它时 `loadForAgent` 发 per-agent `extension.version_incompatible`（含 declaredVersion 与支持区间），不发 `factory_missing`——归因必须是真实原因。BACKLOG 孤儿 custom entry 条目的语义依赖随此解除。**(g) 第三方视角验收 extension**——`tests/extensions/third-party-extension.ts` 只 import `extension/api.ts` 与清单内上游类型，组合 tool + command（line + inline）+ observer；集成测试驱动器可继续用白盒 helper（读账本、触发 hook），约束对象是 extension 本体而非测试设施（切片 4 先例）。已落地：`extension/api.ts` 作者 barrel（版本常量 + 契约再导出，含复出口的 core 事实类型）与 `index.ts` 内部 barrel 分层；`ExtensionDefinition`/`ExtensionModule` 统一声明形态，module importer 只交回 default export、由 loader 单点解释（函数 = 裸 factory，`{ apiVersion, activate }` = 版本声明，其余 `extension.factory_invalid`）；loader 版本门——load/注册期 diagnostic + incompatible 记账（reload 清理 module 来源条目、disposer 撤销 in-memory 条目），`loadForAgent` 对引用 agent 发 per-agent `extension.version_incompatible`（error、blocked，含 declaredVersion 与支持区间）。实施中固化推论：blocked 档诊断走既有 `_buildAgentHarness` 阻断路径，依赖不兼容 extension 的 agent spawn/resume 直接失败——与 `activation_failed` 同族 fail-closed，profile 依赖不满足时不静默降级。回归覆盖公开契约集成（tool + line/inline command + observer + session 账本）、不兼容拒 spawn 与真实归因（无 `factory_missing` 伪事实）、裸 factory 放行、module/in-memory 双源版本门与 factory_invalid。契约全文见 extensions.md 公开契约节。

## 验收标准

- 对照表中每个 pi 能力都有归属落定：core 已落 / client 层（含事实对应物）/ backlog（含举证缺口或依赖）。
- 每条"extension 能/不能做 X"有裁决段 + 代码锚点。
- 审计/策略 extension 作为仓库内真实 consumer 全绿，且在另一 extension 抛错时不失防（切片 1 语义的回归测试）。
- 第三方视角 extension 只依赖公开契约完成 tool + command + observer 组合。

## 依赖面就绪度与落实注意（2026-07-07 评估）

ME 开工前对三个依赖面的就绪裁定，落实各切片时按此执行：

**Orchestrator 原子方法面：齐备，瓶颈在收口与包装。** 切片 3 要暴露的每个动作/查询都已有原子方法背书（input 系、session 系、model/thinking 系、tools 系、`listCommands`、`requestHuman`、resource 事实）。落实注意：

- `exec` 不走 orchestrator 的 agent 方法而走 `ExecutionEnv`；trust 裁决已随切片 3 写入（project trust 未通过时拒绝，全文见切片 3 记录）。
- custom message 形态的 `sendMessage`（`customType`/`display`/`triggerTurn`）载体虽在（`nextTurnAgent` 等），语义依赖切片 7 的 `custom_message` policy，切片 3 已按此只暴露 plain 的 prompt/steer/followUp。（切片 7 裁决：不收编，差异接受。）
- 公开面曾太宽而非太窄（`agents` map、`getAgentHarness` 曾 public）——收口（切片 2，已完成）先于暴露（切片 3），顺序未倒。

**SessionManager：extension 通道已就绪且形态正确，契约未稳。** extension 从不直接拿 SessionManager——`ExtensionSessionContext` 只给 namespaced `appendEntry`/`findEntries`（current branch、append-only），符合 narrowed context 原则，可继续使用。落实注意：fork/compaction/export/`custom_message` policy 定案（切片 7）之前，不对第三方承诺 custom entry 是稳定 API——这也是切片 10 排最后的原因。（已随切片 7 定案，保留升格为成文契约。）

**SettingManager：不暴露给 extension（裁决）。** 三个理由：

1. 键面未稳定是既有裁决（command-experiment.md 拒绝 `/set` 的同一理由）——上百个 pi 继承的平铺 getter/setter 冻结成 extension API 就是把没想清楚的面焊死；
2. 内含提权键：`setProjectTrusted`、`setExtensionPaths`、`setPackages`——extension 可写即等于拆 trust gate / 自我持久化，任何设计下都不给；
3. settings 文件是共享持久 core state，extension 直接写入违反 extensions.md"不能直接拥有已存储 core state"，与 `/model` 不写 settings 文件是同一条纪律。

Extension 的设置类需求三分：自己的状态 → extension-owned storage（切片 7）；读 runtime 事实 → scoped actions / inspect；改共享 settings → 不开，真实场景出现时再评估"白名单键 + human request 确认"的受控入口（届时补裁决段）。

## 非目标

- 不做 `ctx.ui` 或任何 core 内 UI 通道；client adapter 的 extension host 是独立工作（随最小 stdout/CLI adapter 之后评估）。
- 不做 extension 间 EventBus、`setLabel`、`user_bash` hook（backlog，等举证或依赖）。
- 不为想象中的 upstream orchestrator 或 RPC schema 预留抽象（与 command 收编同一纪律）。
