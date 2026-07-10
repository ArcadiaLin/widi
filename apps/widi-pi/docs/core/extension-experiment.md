# Extension Experiment

> **状态：方案已定，ME milestone 排期中。**
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
| `input` | 无 | core，ME 切片 6（intercept 档，策略 extension 举证） |
| `before_provider_request/headers`、`after_provider_response` | 无（依赖 pi harness 暴露程度） | core，ME 切片 9 随 provider 面评估 |
| `user_bash` | 无 bash 能力 | backlog（依赖未来 bash tool 能力） |
| `project_trust` | loader trust gate（声明式，非 hook） | core，已落；差异接受，不做 hook 化 |
| `resources_discover` | 无 | core，ME 切片 8（resource contribution） |

WIDI 独有（pi 无对应）：`command_detected/accepted/completed/rejected/failed`、agent-scoped `human_request_*`、diagnostics 流的 observer 档已随 ME 切片 5 桥接；global human request/diagnostic 不广播给 per-agent runner。command/human 事件补齐 `agentId` 路由事实，这也是审计 extension 的主粮。

### 注册面

| pi | WIDI 现状 | 归属 |
| --- | --- | --- |
| `registerTool` | 已有，且多 `patchTool`（pi 无 patch 语义） | core，已超出 |
| `registerCommand` | 已有，且 trigger/placement/arguments 是声明事实、走统一事件轨道与 gateway | core，已超出；extension inline `expand` 待接（ME 切片 7 顺带） |
| `registerProvider` / `unregisterProvider` | 无 | core，ME 切片 9（ModelRegistry registration-with-provenance，auth 所有权不移交） |
| `registerShortcut` / `registerFlag` / `getFlag` | 无 | client |
| `registerMessageRenderer` / `registerEntryRenderer` | 无 | client |

### 动作/查询面

| pi | WIDI 现状 | 归属 |
| --- | --- | --- |
| `sendMessage` / `sendUserMessage`（steer/followUp/nextTurn） | scoped `prompt`/`steer`/`followUp` 已暴露 | core，已落（切片 3）；custom message 语义依赖切片 7 policy |
| `appendEntry` / `findEntries` | session custom entry MVP 已有 | core，已落；policy 待切片 7 |
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
6. **`input` interceptor**。已裁决（2026-07-07）：拦截发生在 `inputAgent` 的 command 解析**之前**（与 pi 语义一致，策略 extension 可整段改写/拒绝输入）；改写后的文本重新走完整解析与 gateway，不许绕过。
7. **Extension-owned storage 裁决 + custom entry policy**。fork/compaction/export/`custom_message` 语义定案；extension inline `expand` 契约顺带接入（expand 语义已由 command 管线就绪）。
8. **Resource contribution**。extension 贡献 skills/prompt templates，进 ResourceLoader 所有权边界，registration-with-provenance。
9. **Provider contribution（后段）**。ModelRegistry 的 register/unregister provider（模型集、baseUrl、OAuth 桥接；auth storage 所有权不移交）；provider request/headers/response hook 视 pi harness 暴露程度评估桥接或走 upstream roadmap。
10. **API 面冻结**。公开契约清单、版本兼容策略、`extension.version_incompatible` 语义；第三方视角验收 extension（只依赖公开契约完成 tool + command + observer 组合）。

## 验收标准

- 对照表中每个 pi 能力都有归属落定：core 已落 / client 层（含事实对应物）/ backlog（含举证缺口或依赖）。
- 每条"extension 能/不能做 X"有裁决段 + 代码锚点。
- 审计/策略 extension 作为仓库内真实 consumer 全绿，且在另一 extension 抛错时不失防（切片 1 语义的回归测试）。
- 第三方视角 extension 只依赖公开契约完成 tool + command + observer 组合。

## 依赖面就绪度与落实注意（2026-07-07 评估）

ME 开工前对三个依赖面的就绪裁定，落实各切片时按此执行：

**Orchestrator 原子方法面：齐备，瓶颈在收口与包装。** 切片 3 要暴露的每个动作/查询都已有原子方法背书（input 系、session 系、model/thinking 系、tools 系、`listCommands`、`requestHuman`、resource 事实）。落实注意：

- `exec` 不走 orchestrator 的 agent 方法而走 `ExecutionEnv`；trust 裁决已随切片 3 写入（project trust 未通过时拒绝，全文见切片 3 记录）。
- custom message 形态的 `sendMessage`（`customType`/`display`/`triggerTurn`）载体虽在（`nextTurnAgent` 等），语义依赖切片 7 的 `custom_message` policy，切片 3 已按此只暴露 plain 的 prompt/steer/followUp。
- 公开面曾太宽而非太窄（`agents` map、`getAgentHarness` 曾 public）——收口（切片 2，已完成）先于暴露（切片 3），顺序未倒。

**SessionManager：extension 通道已就绪且形态正确，契约未稳。** extension 从不直接拿 SessionManager——`ExtensionSessionContext` 只给 namespaced `appendEntry`/`findEntries`（current branch、append-only），符合 narrowed context 原则，可继续使用。落实注意：fork/compaction/export/`custom_message` policy 定案（切片 7）之前，不对第三方承诺 custom entry 是稳定 API——这也是切片 10 排最后的原因。

**SettingManager：不暴露给 extension（裁决）。** 三个理由：

1. 键面未稳定是既有裁决（command-experiment.md 拒绝 `/set` 的同一理由）——上百个 pi 继承的平铺 getter/setter 冻结成 extension API 就是把没想清楚的面焊死；
2. 内含提权键：`setProjectTrusted`、`setExtensionPaths`、`setPackages`——extension 可写即等于拆 trust gate / 自我持久化，任何设计下都不给；
3. settings 文件是共享持久 core state，extension 直接写入违反 extensions.md"不能直接拥有已存储 core state"，与 `/model` 不写 settings 文件是同一条纪律。

Extension 的设置类需求三分：自己的状态 → extension-owned storage（切片 7）；读 runtime 事实 → scoped actions / inspect；改共享 settings → 不开，真实场景出现时再评估"白名单键 + human request 确认"的受控入口（届时补裁决段）。

## 非目标

- 不做 `ctx.ui` 或任何 core 内 UI 通道；client adapter 的 extension host 是独立工作（随最小 stdout/CLI adapter 之后评估）。
- 不做 extension 间 EventBus、`setLabel`、`user_bash` hook（backlog，等举证或依赖）。
- 不为想象中的 upstream orchestrator 或 RPC schema 预留抽象（与 command 收编同一纪律）。
