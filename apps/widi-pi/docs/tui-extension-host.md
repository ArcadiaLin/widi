# TUI 扩展能力：pi 对照调研与 widi 方案

调研日期：2026-07-27（第 4 节生态对照补充于 2026-07-28；第 8 节实施决议补充于 2026-07-29）。对照的 pi 快照为 in-tree `pi/`，生态样本为 `chat_notes/pi-extensions`（ogulcancelik 的扩展集，20 个包）。文中行号以这两份快照为准，upstream 更新后可能漂移。

文档位置：本文自 2026-07-29 起纳入 git 追踪，落在 `apps/widi-pi/docs/tui-extension-host.md`。同日 `docs/zh-CN/*` 整套说明文档移出 git 追踪（现存于 `chat_notes/zh-CN/`），因此**本轮实施不依赖也不同步那批文档**；这一工作流的唯一权威描述是本文。文中引用 `docs/zh-CN/...` 的地方一律是历史陈述，不是待更新的目标。

**一句话结论**：能做，且 widi 的分层比 pi 更适合做。推荐"双入口扩展 + TUI 扩展宿主"，core 保持零 TUI 依赖；宿主是 TUI 应用自己的装配模块，**不是** core 扩展。生态对照后追加一条：**真正的瓶颈不止在 TUI 半，core 半也缺三块高频能力**（会话读取、上下文用量、侧信道模型查询），详见第 4 节。

---

## 1. 问题

pi 允许扩展直接改 TUI——自绘 footer/header、挂 widget、开 overlay、换编辑器、给自定义消息写渲染器。代价是 core 的扩展类型直接依赖 TUI 包。

widi 的既定路线是 core 与 TUI 解耦：core 只发结构化事实，呈现归 client adapter。好处是同一个 core 能带 TUI、RPC、未来的 GUI；代价是扩展作者失去了"给 TUI 加外观"的能力。

问题：有没有折中，既接受扩展扩展 TUI 外观，又不让 core 沾 TUI。

---

## 2. pi-coding-agent 的做法

### 2.1 能力清单

全部 UI 能力集中在 `ExtensionUIContext`（`pi/packages/coding-agent/src/core/extensions/types.ts:129-280`），通过 `ctx.ui` 暴露。按对前端的依赖程度分成两类——这个划分是后面整个方案的基础：

**A 类：数据型意图**（任何前端都能实现）

| 成员 | 作用 |
| --- | --- |
| `select` / `confirm` / `input` / `editor` | 对话框，返回用户选择 |
| `notify(message, type)` | 瞬时通知 |
| `setStatus(key, text)` | 状态栏键值文本 |
| `setTitle(title)` | 终端窗口标题 |
| `setWorkingMessage` / `setWorkingVisible` / `setWorkingIndicator` | 流式期间的等待指示 |
| `setHiddenThinkingLabel` | 折叠 thinking 块的标签 |
| `setEditorText` / `getEditorText` / `pasteToEditor` | 输入框文本 |
| `getToolsExpanded` / `setToolsExpanded` | 工具输出展开状态 |
| `setTheme` / `getTheme` / `getAllThemes` | 主题切换（`theme` 本身是数据） |

**B 类：组件型**（必须持有 `TUI`、`Component`、`Theme` 实例）

| 成员 | 作用 |
| --- | --- |
| `setWidget(key, factory, { placement })` | 编辑器上/下方挂组件 |
| `setFooter(factory)` / `setHeader(factory)` | 整体替换页脚/页头 |
| `custom(factory, { overlay, overlayOptions, onHandle })` | 带键盘焦点的自定义组件/浮层 |
| `setEditorComponent(factory)` | 替换输入编辑器（vim 模式等） |
| `addAutocompleteProvider(factory)` | 叠加补全逻辑 |
| `onTerminalInput(handler)` | 拦截原始终端输入 |

`ExtensionAPI` 上还有三处与 UI 相关的注册（同文件 :1236-1268）：

- `registerCommand(name, options)`——slash 命令。
- `registerShortcut(KeyId, { handler })`——键盘快捷键。
- `registerFlag(name, options)` / `getFlag(name)`——CLI 参数。
- `registerMessageRenderer(customType, renderer)` / `registerEntryRenderer(customType, renderer)`——给自定义消息/条目写渲染器，返回 `Component`。

第四处，也是最容易被忽略的：**`ToolDefinition` 自带 `renderCall` / `renderResult`**（同文件 :480-489），签名返回 `Component`，还有 `renderShell?: "default" | "self"` 决定是否自绘外框，以及一整个 `ToolRenderContext`（:412-437，含 `invalidate`、`lastComponent`、`state`、`expanded`、`showImages`）。**pi 的工具定义类型本身就耦合了 TUI。**

组件契约本身很轻（`pi/packages/tui/src/tui.ts:64`）：

```ts
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate?(): void;
  wantsKeyRelease?: boolean;
}
```

浮层另有 `OverlayOptions`（同文件 :171）管尺寸/锚点/偏移。

示例扩展里属于 B 类的：`custom-footer.ts`、`custom-header.ts`、`widget-placement.ts`、`modal-editor.ts`、`rainbow-editor.ts`、`doom-overlay/`、`snake.ts`、`space-invaders.ts`、`tic-tac-toe.ts`、`message-renderer.ts`、`entry-renderer.ts`、`built-in-tool-renderer.ts`、`truncated-tool.ts`、`titlebar-spinner.ts`、`working-indicator.ts`。A 类的：`status-line.ts`、`notify.ts`、`question.ts`、`qna.ts`、`questionnaire.ts`、`timed-confirm.ts`。

### 2.2 实现机制

每个 run mode 提供自己的 `ExtensionUIContext` 实现，由 runner 持有：

- interactive：`modes/interactive/interactive-mode.ts:2135 createExtensionUIContext()`，真正接 TUI。
- RPC：`modes/rpc/rpc-mode.ts:135`，把 A 类转成 `extension_ui_request` 协议消息；B 类**全部丢弃**（`onTerminalInput` 直接 `return () => {}`）。
- print / 无 UI：`core/extensions/runner.ts:233 noOpUIContext`，A、B 两类**全部 no-op**。

扩展作者靠 `ctx.mode`（`"tui" | "rpc" | "json" | "print"`）和 `ctx.hasUI` 自己 guard。

### 2.3 耦合代价

`core/extensions/types.ts:38-45` 直接 import `@earendil-works/pi-tui` 的 `TUI`、`Component`、`EditorComponent`、`KeybindingsManager`、`AutocompleteProvider`，:47 又 import `modes/interactive/theme/theme.ts` 的 `Theme`。于是：

- core 的类型面依赖 TUI 包与 interactive mode 的内部模块。
- `ToolDefinition` 这个最核心的类型也带上了 `Component`。
- 非 TUI 前端拿到的是一个"一半是空实现"的接口，能力边界靠文档和 `hasUI` 约定，类型上无法表达。

**关键观察：pi 自己已经画了 A/B 这条线**（no-op 表和 RPC 实现就是证据），只是没在类型上切开，而是用一个大接口加 no-op 兜底。widi 要做的，本质上就是把这条已经存在的线在架构上落实。

---

## 3. widi 现状

### 3.1 A 类已经做完了

`ExtensionActions`（`apps/widi-pi/src/core/extension/types.ts`）已有：

- `notify(text)`——瞬时通知。
- `setStatus(key, status)` / `clearStatus(key)`——键控状态，含 `progress { completed, total }`。
- `publishMessage(message)`——持久化展示内容，落成 `core:extension_message` session custom entry，返回 `entryId`，客户端按 entryId 去重。
- `emitOutput(text)`——append-only 纯文本。
- `requestHuman(draft)`——对话框，走 human request 机制，`source` 由 runner 注入不可伪造。
- `reportDiagnostic(draft)`——进核心诊断管线。

`requestHuman` 的表达力**超过** pi：`HumanRequestKind` 有 `confirm | select | multi-select | questions | input | custom`，`questions` 还支持多问题分页批答（`core/human-request.ts`），pi 只有三个单问题对话框。这一项无需补齐。

payload 形状与体积上限在 `core/extension/presentation.ts`：`ExtensionMessage.kind` 目前只有 `text | markdown | code`，`ExtensionStatus` 只有 `text` + `progress`。

缺的正是 B 类——以及第 4 节揭示的那批 core 侧非 UI 能力。

### 3.2 与 pi 的三处结构差异

这三条决定了不能照搬 pi：

1. **runner 是 per-agent，TUI 是 per-runtime。** widi 的 `loadForAgent({ agentId, profileId })` 为每个 agent 建一个 runner；TUI 是单例，同时展示多个 agent。TUI 扩展只能是 runtime 级单例，`agentId` 只能作为回调参数出现。pi 是单 session 单 TUI，没有这个问题。
2. **slash command 引擎已经在 TUI 层。** `apps/widi-pi/src/tui/commands/`，而 pi 的 `registerCommand` 在 core。`docs/zh-CN/core/extensions.md` 已经写明"不提供 registerCommand，交互命令属于 TUI 命令引擎"——这条决定现在正好可以兑现。
3. **工具渲染已经在 TUI 层。** `tui/tool-presenter.ts` 的 `presentToolExecution(item, width, options) → string[]` 是纯函数，按 `toolName` 分发；`ToolDefinition`（`core/tools/types.ts`）完全没有渲染字段。这是 widi 相对 pi 的一个净优势，也意味着"扩展提供的工具无法自绘"是当前的一个真实缺口。

第 4 节的生态对照又暴露出第四条差异，见 4.4。

### 3.3 可直接复用的零件

- `core/extension/module-importer.ts` 的 `JitiExtensionModuleImporter`：只包了 jiti，无内部依赖，TUI 宿主可原样复用。
- `ExtensionDiscoveryResult` / `ExtensionIdentity` / `ExtensionRoot`（`core/extension/loader.ts:89-145`）：纯数据，可作为宿主的发现输入，方向单向。
- `OrchestratorClient`（`core/client.ts`）：TUI 已经作为 client 订阅事件流，宿主可复用同一投影。
- `tui/theme/theme.ts`、`tui/keybindings.ts`（`WIDI_KEYBINDINGS` 可配置表 + `createWidiKeybindings()`）、`tui/components/*`：宿主要暴露给扩展的资源都已存在。

---

## 4. 生态对照：pi-extensions 实测需求

前三节的 A/B 划分是从 pi 的**类型面**推出来的。这一节反过来从**真实扩展**推：把 `chat_notes/pi-extensions` 的 20 个包逐个拆开，看它们实际调用了什么，再对 widi 现有 API 做差集。结论是 A/B 两类之外还得加一类。

### 4.1 三类能力，不是两类

| 类别 | 定义 | widi 归属 |
| --- | --- | --- |
| **A：数据型 UI 意图** | 通知、状态、对话框、结构化消息 | core `ExtensionActions`，**已完成** |
| **B：组件型 UI** | footer/widget/overlay/渲染器/快捷键/主题/编辑器文本 | TUI 宿主，**待建**（第 6 节） |
| **C：非 UI core 能力** | 会话读取、上下文用量、侧信道模型查询、事件总线、会话生命周期 | core `ExtensionActions` / `ExtensionActivationApi`，**待补**（4.3） |

原文档只识别了 A 和 B。C 类被忽略是因为 pi 把这些东西塞在 `ctx.sessionManager`、`ctx.modelRegistry`、`ctx.getContextUsage()` 这些"看起来只是上下文字段"的地方，不在 `ctx.ui` 里，所以从 UI 类型面读不出来。但生态里它们的出现频率**高于**任何一项 B 类能力。

### 4.2 逐包对照

标注沿用 pi-extensions README 的活跃度。"可移植性"列的含义：**✅ 现在就能跑**（只用 widi 已有 core API）／**🅱 差 TUI 宿主**／**🅲 差 core 能力**／**🅱🅲 两者都差**。

| 扩展 | 关键能力 | widi 缺口 | 可移植性 |
| --- | --- | --- | --- |
| pi-minimal-footer 🔥 | `ui.setFooter` + `FooterDataProvider`、`getContextUsage`、`ctx.model`、`sessionManager` | 宿主 footer 槽；上下文用量；会话读取 | 🅱🅲 |
| pi-session-recall 🔥 | `registerCommand`、`registerTool`、`ui.custom` 浮层、`modelRegistry.getApiKeyAndHeaders` 自建 LLM 调用、扫描历史会话文件 | 命令注册；浮层；侧信道查询；跨会话读取 | 🅱🅲 |
| pi-auto-permissions 🟢 | `on(tool_call)` 门禁、`ui.setWidget`、`ui.select`、侧信道 LLM 审查、`events.emit`、`isProjectTrusted` | widget；侧信道查询；事件总线；trust 只读位 | 🅱🅲 |
| pi-codex-subagents 🟢 | `registerTool`、`sendMessage(customType)`、`registerMessageRenderer`、`ui.custom` + `onHandle` 活体浮层、`ui.setWidget` | 结构化消息进上下文；消息渲染器；浮层句柄 | 🅱🅲 |
| pi-codex-compaction 🟢 | `on(session_before_compact)`、`on(before_provider_headers)`、`registerEntryRenderer`、`appendEntry`、`getSystemPrompt` | 压缩前钩子（widi 明确 deferred）；entry 渲染器；系统提示读取 | 🅱🅲 |
| pi-handoff 🟡 | `ctx.newSession({ withSession })`、`sendUserMessage`、`getContextUsage`、`sessionManager.getEntries` | 会话生命周期控制；上下文用量；会话读取 | 🅲 |
| pi-quit-and-delete 🟠 | `registerShortcut`、`sessionManager.getSessionFile()`、`process.exit` | 快捷键注册；会话文件定位；runtime 退出 | 🅱🅲 |
| pi-ssh-tools 🟠 | `registerTool`、`setActiveTools`、`ui.select`、`ui.setStatus`、`on(before_agent_start)` | **仅差 slash 命令注册** | 🅱 |
| pi-herdr 🧪 | `pi.exec`、`registerTool` | 无 | ✅ |
| pi-tmux 🧪 | `pi.exec`、`registerTool` | 无 | ✅ |
| pi-model-agents 🧪 | `on(before_agent_start)`、`registerCommand`、`sendMessage` | 命令注册（其余可用 `appendSystemPrompt` 更直接地实现） | 🅱 |
| pi-model-thinking 🧪 | `get/setThinkingLevel`、`on(model_select)`、`registerCommand` | 命令注册；`model_select` 具名观察 | 🅱🅲 |
| pi-ghost ⚪ | `ui.custom` 全屏浮层、独立侧会话、侧信道 LLM | 浮层；侧信道查询；侧会话 | 🅱🅲 |
| pi-ghostty-theme-sync ⚪ | `ui.setTheme` / `ui.theme` | 宿主主题 API | 🅱 |
| pi-goal ⚪ | `registerTool`、`sendMessage`、`ui.setWidget`、`ui.confirm`、`setStatus`、`getContextUsage`、`hasPendingMessages`、`setSessionName`、`on(agent_settled)` | widget；上下文用量；队列状态位 | 🅱🅲 |
| pi-sketch ⚪ | `ui.custom` 画布、`ui.get/setEditorText` | 浮层；编辑器文本读写 | 🅱 |
| pi-worktree ⚪ | `ctx.switchSession`、`ctx.waitForIdle`、`on(input)`、`events.emit`、`ui.setEditorText`、`ui.setStatus`、`exec` | 会话切换；空闲等待；事件总线；编辑器文本 | 🅱🅲 |
| pi-spar 🧪 | `registerCommand`、`registerTool`、`ui.custom` peek、`sessionManager` | 同 codex-subagents | 🅱🅲 |
| pi-flicker | `ui.setWidget`、`on(agent_start/end)`、`registerCommand` | widget；命令注册 | 🅱 |
| pi-web-browse ⛔ | 已废弃 | — | — |

统计（19 个有效包）：

- **2 个**（herdr、tmux）用当前 widi core API 可原样移植——它们只用 `exec` + `registerTool`。
- **13 个**需要 TUI 宿主。
- **11 个**需要至少一项 C 类 core 新能力。
- 出现频率最高的三个 core 缺口：**会话读取 10 次**、**上下文用量 4 次**、**侧信道模型查询 4 次**（但这 4 个恰好是作者标记为 🔥 Core / 🟢 Active 的旗舰扩展）。
- B 类里频率最高的是 `registerCommand`（12 次）、`ui.setWidget`（5 次）、`ui.custom` 浮层（5 次）。

**判断**：只做 TUI 宿主而不补 C 类，覆盖率停在 3/19 左右（herdr、tmux、ssh-tools、flicker、ghostty-theme-sync、sketch、model-agents 这一档）。C 类里只要补上会话读取 + 上下文用量两项，覆盖率能推到 12/19 以上。**C 类应当先于或至少并行于宿主推进。**

### 4.3 C 类缺口详单

按优先级排。每条给出：需求方、pi 的形态、widi 应有的形态、以及 widi 已有的内部原语。

#### C1. 会话读取（最高频，10 个扩展）

pi 形态：`ctx.sessionManager` 是完整的 `ReadonlySessionManager`。实测用到的成员——`getSessionFile()`（17 处）、`getSessionId()`（7）、`getBranch()`（7）、`getEntries()`（3）、`getLeafId()`（2）、`buildSessionContext()`。

widi 现状：`ExtensionSessionContext` 只有 `appendEntry` / `findEntries`，且按 `extensionId` 命名空间隔离（`core/extension/runner.ts:815-840` → `orchestrator._createExtensionActions` 的 `session` 绑定）。扩展读不到会话本体。

已有内部原语（`core/session-manager.ts`）：`getAgentSessionSnapshot`、`getAgentSessionTree`、`getAgentSessionLeafId`、`getAgentSessionDir`、`buildAgentSessionContext`、`listAgentSessionCandidates`。**能力都在，只差暴露。**

建议形态——**给结构化读取，不给文件路径**：

```ts
interface ExtensionSessionContext {
  // 既有
  appendEntry<T>(type: string, data?: T): Promise<string>;
  findEntries<T>(type?: string): Promise<ExtensionCustomEntry<T>[]>;
  // 新增：本 agent 当前会话
  getSnapshot(): Promise<AgentSessionSnapshot>;   // 含 sessionId / entries / 分支信息
  getTree(): Promise<AgentSessionTree>;
  getLeafId(): Promise<string | null>;
  // 新增：跨会话（历史）只读
  listSessions(): Promise<AgentSessionCandidate[]>;
  readSession(sessionId: string): Promise<AgentSessionSnapshot>;
}
```

要求说明：

- **不暴露 `getSessionFile()` 这类路径**。widi 的存储走 storage adapter（`core/session-repo.ts` / `runtime-service.ts`），路径是实现细节；而且多 agent 场景下"the session file"本身就是歧义的。session-recall 那种"自己 glob 目录再解析 jsonl"的写法必须改成 `listSessions()` + `readSession()`。
- `findEntries` 现有的 extensionId 命名空间隔离**保留**；新增的 `getSnapshot` / `readSession` 是另一条读取通道，返回的是完整会话事实，不做扩展隔离——需要在文档里写清"扩展能读到整段对话"，并纳入 trust 论证（第 6.6 节）。
- 跨会话读取的范围见第 9 节未决问题 6（已定：cwd/项目范围）。

#### C2. 上下文用量（4 个扩展，含旗舰 minimal-footer）

pi 形态：`ctx.getContextUsage() → { tokens: number | null, contextWindow: number, percent: number | null }`。`percent` 是 0–100（`agent-session.ts:3191` 算的是 `tokens / contextWindow * 100`），移植过来的扩展会拿它跟 `>= 95` 一类阈值比——widi 必须同刻度，否则那些条件永远不成立。

widi 现状：core 内部已经算了——`agent-orchestrator.ts:3875` 的 `calculateContextTokens(usage)` 与 `record.model.contextWindow` 就是自动压缩的判据——但没有任何对外出口。TUI 自己也需要（footer 上下文条）。

建议形态：

```ts
// ExtensionActions
getContextUsage(): ExtensionContextUsage | undefined;
```

要求说明：**同时补一条 OrchestratorEvent**（如 `agent_context_usage_changed`），否则 footer 类扩展只能轮询。TUI 内置 footer 与扩展 footer 应当消费同一个事实源，这也顺带解决了 6.3 节里 `FooterDataProvider` 等价物的数据来源问题。

#### C3. 侧信道模型查询（4 个扩展，全是旗舰）

pi 形态：`ctx.modelRegistry.getApiKeyAndHeaders(model)` 把**凭据直接交给扩展**，扩展自建 `OpenAI` / `fetch` 客户端。auto-permissions 用它跑守护审查，session-recall 用它做语义检索，codex-compaction 用它调 Codex 远端压缩，ghost 用它开侧会话。

widi 现状：无。而且 widi 的既定原则明确相反——`core/extension/types.ts` 的 `ExtensionProviderConfig` 注释写着"Credential ownership does not move"。

**因此不能照搬。** 建议改成 core 代持凭据的查询接口：

```ts
// ExtensionActions
query(request: {
  model?: string;              // 模型 reference，省略则用 agent 当前模型
  messages: readonly ExtensionQueryMessage[];
  tools?: readonly string[];
  signal?: AbortSignal;
}): Promise<ExtensionQueryResult>;
```

要求说明：

- 凭据、provider 栈、重试、计量、诊断全部留在 core。扩展拿到的是结果，不是 key。
- 这条查询**不进 agent 的会话**，也不占 agent 的上下文——它是旁路，语义上接近"借用 runtime 的模型能力"。
- 需要计入配额/成本统计，并可被 `abort` 一并取消（auto-permissions 的审查就必须能随工具调用一起取消）。
- **备选路径**：widi 原生有多 agent 编排，"起一个一次性子 agent 问一句"本来就是能力。如果 M3 collaboration facade 会提供 `spawnEphemeral`，C3 可以直接落在那上面而不必单开 `query`。二选一，见第 9 节未决问题 7。

#### C4. 结构化消息进入模型上下文（4 个扩展）

pi 形态：`pi.sendMessage({ customType, content, display, details }, { triggerTurn, deliverAs: "steer" | "followUp" | "nextTurn" })`——一条消息同时做三件事：进模型上下文、带 `customType` 供渲染器认领、带 `details` 结构化载荷。

widi 现状：`prompt` / `steer` / `followUp` 只收纯文本 + 图片；`publishMessage` 有 `kind`/`title`/`content` 但**不进模型上下文**。两者中间的那一档缺失。

建议形态——给现有三个投递方法加一个呈现描述：

```ts
prompt(text: string, options?: {
  images?: ImageContent[];
  presentation?: { customType: string; title?: string; details?: JsonValue };
}): Promise<void>;
```

要求说明：这正是双入口方案里 tui 半 `registerMessageRenderer(customType, …)` 的认领对象（6.4 节）。署名规则见第 9 节未决问题 1（已定：core 把 `extensionId` 作为独立字段注入，渲染器按 `(extensionId, customType)` 匹配，不做字符串前缀）。

#### C5. 扩展间事件总线（2 个发送方 + 1 个消费方）

pi 形态：`pi.events.emit(name, payload)` / `pi.events.on(...)`。实测：worktree 和 auto-permissions 都往 `herdr:blocked` 发，herdr 收——这是一个跨扩展协作约定。

widi 现状：无。

要求说明：**必须是 runtime 级，不能是 per-agent。** widi 的 runner 是 per-agent，如果总线跟着 runner 走，两个 agent 加载同一对扩展会得到两条互不相通的总线，herdr 这类"外部窗格协调"用例直接失效。这意味着总线的持有者是 orchestrator 或 runtime service，`ExtensionActivationApi` 上暴露的只是一个绑定了 `extensionId` 的视图（用于溯源与诊断归属）。

实施细则见第 8 节批次 A：订阅端落在 `ExtensionActivationApi.onExtensionEvent`，发送端落在 `ExtensionActions.emitExtensionEvent`，持有者是 orchestrator，runner 本身即订阅者集合。

#### C6. 会话生命周期控制（3 个扩展）

pi 形态：`ctx.newSession({ withSession })`、`ctx.switchSession(path)`、`ctx.fork(entryId)`、`ctx.navigateTree(targetId)`、`ctx.waitForIdle()`、`ctx.reload()`、`ctx.shutdown()`。

widi 现状：观察侧有 `agent_session_forked` 事件；控制侧全无。

要求说明：**语义要先定义，不能直接抄。** pi 是单会话，"switch session"含义唯一；widi 是多 agent，同一动作至少有三种读法：换掉某个 agent 的会话、把当前可见 agent 指向别的会话、起一个新 agent。这构成 3.2 节之外的**第四条结构差异**（见 4.4）。建议先只做语义无歧义的两项：

- `waitForIdle()`——本 agent 空闲等待，零歧义，且 worktree/handoff 都要。
- `requestShutdown()`——runtime 级退出请求，替代 quit-and-delete 的 `process.exit(0)`；必须走 core 的有序关闭（其他 agent 的收尾、会话 flush），不能让扩展直接杀进程。

`newSession` / `switchSession` / `fork` / `navigateTree` 推迟到多 agent 语义确定后再开。

实施细则见第 8 节批次 B：`requestShutdown` 定为"core 发事件、TUI 执行"，另加一条 `disposeRuntime` 直通 `orchestrator.disposeAll` 作无宿主兜底。

#### C7. 小口子（各 1-2 个扩展，成本极低）

| 能力 | 需求方 | widi 现状 |
| --- | --- | --- |
| `isProjectTrusted()` | auto-permissions | `core/project-trust.ts` 已有，未暴露 |
| `getSystemPrompt()` | codex-compaction | `core/system-prompt.ts` 已有；现在只有写侧 `appendSystemPrompt` |
| `hasPendingMessages()` | goal | 队列状态 core 内部已知 |
| `registerFlag` / `getFlag` | （示例扩展）| 无。CLI 入口在 `src/cli.ts`，需要在解析前收集扩展声明——**加载顺序问题**，成本不低，建议最后做 |

#### C8. 已经不是缺口的两项（勘误）

- **`before_provider_headers`**：pi 单独开了这个钩子改请求头。widi 的 `before_provider_request` 拦截器拿到的 `BeforeProviderRequestEvent.streamOptions` 已含 `headers`，返回值走 `AgentHarnessStreamOptionsPatch`（`pi/packages/agent/src/harness/types.ts:120-143`），支持增删改。**无需新增。**
- **对话框**：`select` / `confirm` / `input` 全部被 `requestHuman` 覆盖且更强（3.1 节）。**无需新增。**

### 4.4 第四条结构差异：会话与 agent 的基数关系

3.2 节列了三条。生态对照暴露第四条，且它是 C6 迟迟不能落地的根因：

**pi 里"session"和"运行实例"是 1:1，widi 里是 N:1。** pi 扩展作者写 `ctx.sessionManager.getSessionFile()`、`ctx.switchSession(path)` 时，脑子里有唯一的"当前会话"。widi 有多个 agent，每个有自己的会话，还有一个"当前可见 agent"的 TUI 概念——三者可以不一致。

后果：

- C1 的跨会话读取需要明确列举范围（未决问题 6）。
- C6 的会话切换动作需要先定义主语。
- C5 的事件总线必须提升到 runtime 级。
- B 类里 widget 的归属也是同一问题的另一面（未决问题 2 已记录）。

**要求**：任何涉及"会话"的新 API，签名里要么显式带 agent 主语，要么在文档里写明"本 agent"。不要留给作者猜。

---

## 5. 方案对比

| | A：扩数据协议 | B：TUI 扩展宿主（推荐） | C：pi 式 `ctx.ui` |
| --- | --- | --- | --- |
| core 是否依赖 TUI | 否 | 否 | **是** |
| 表达力 | 受协议枚举限制 | 接近 pi | 与 pi 相同 |
| 扩展作者心智 | 最简单 | 需理解两半 | 单一 API，但要 `hasUI` guard |
| 非 TUI 前端 | 天然可用 | 天然可用（tui 半不加载） | 一半 no-op |
| 成本 | 低 | 中（主要在 TUI 装配重构） | 中低，但架构债 |

A 与 B 不冲突：B 落地后，A 的协议仍然是"没有 tui 半时"的降级路径。C 明确不推荐，理由见第 7 节的同类论证。

第 4 节的 C 类缺口与这张表正交——无论选哪个 UI 方案，C 类都得补。

---

## 6. 推荐方案：双入口扩展 + TUI 扩展宿主

### 6.1 分层

```
core（零 TUI 依赖，不变）
  ExtensionActivationApi: registerTool / patchTool / registerProvider /
                          observe / intercept / appendSystemPrompt / onDispose
                          + onExtensionEvent（runtime 级总线的订阅端，C5）
  ExtensionActions:       notify / setStatus / publishMessage / emitOutput /
                          requestHuman / reportDiagnostic / ...
                          + getContextUsage（C2）/ query（C3，deferred）
                          + emitExtensionEvent（C5）
                          + waitForIdle / requestShutdown / disposeRuntime（C6）
                          + isProjectTrusted 等（C7）
  ExtensionSessionContext: appendEntry / findEntries
                          + getSnapshot / getTree / listSessions / readSession（C1）
        │
        │  OrchestratorEvent（只读投影） + session custom entries
        ▼
tui 宿主（发行版装配，apps/widi-pi/src/tui/extension-host/）
  WidiTuiExtensionApi:    registerCommand / registerShortcut /
                          registerMessageRenderer / registerEntryRenderer /
                          registerToolPresenter / setWidget / setFooter /
                          setHeader / showOverlay / editorText / theme /
                          keybindings / observe
```

### 6.2 双入口

一个扩展包导出两个入口，被两个互不相识的宿主分别加载：

```ts
// widi-ext-foo/index.ts
export default { apiVersion: 1, activate };       // core 半，现状不变
export const tui = { apiVersion: 1, activate };   // tui 半，只有带宿主的发行版加载
```

- core loader 只看 default export，行为完全不变；不认识 `tui` 具名导出。
- tui 宿主只看 `tui` 具名导出；没有它的扩展就是纯 core 扩展。
- 两半通过**同一个 `extensionId`** 关联，没有别的耦合。

### 6.3 `WidiTuiExtensionApi` 草图

相比初版，这里补上了生态对照发现的四处遗漏（`registerShortcut`、编辑器文本、主题、浮层句柄）以及 `registerEntryRenderer`。

```ts
interface WidiTuiExtensionApi {
  readonly extensionId: string;

  // 命令与按键：widi 的 command engine 与 keybindings 本来就在这一层
  registerCommand(definition: CommandDefinition): void;
  registerShortcut(bindingId: string, handler: (ctx: TuiExtensionContext) => void): void;

  // 渲染：认领本扩展 core 半发出的内容
  registerMessageRenderer(                       // 进模型上下文的消息（C4）
    customType: string,
    render: (message: ExtensionMessage, ctx: RenderContext) => Component,
  ): void;
  registerEntryRenderer(                         // 不进上下文的 custom entry
    customType: string,
    render: (entry: ExtensionCustomEntry, ctx: RenderContext) => Component,
  ): void;

  // 工具渲染：填 tool-presenter 的注册表
  registerToolPresenter(
    toolName: string,
    present: (item: ToolExecutionItem, width: number, options) => string[] | Component,
  ): void;

  // 版面
  setWidget(key: string, factory: ComponentFactory | undefined, options: {
    placement: "aboveEditor" | "belowEditor";
    scope: "global" | "agent";                   // 见未决问题 2
  }): void;
  setFooter(factory: FooterFactory | undefined): void;
  setHeader(factory: ComponentFactory | undefined): void;
  showOverlay<T>(factory: OverlayFactory<T>, options?: {
    overlayOptions?: OverlayOptions | (() => OverlayOptions);
    onHandle?: (handle: OverlayHandle) => void;  // 活体浮层需要，codex-subagents peek
  }): Promise<T>;

  // 输入框文本（sketch / worktree）
  getEditorText(): string;
  setEditorText(text: string): void;
  pasteToEditor(text: string): void;

  // 事实来源：只读
  observe(handler: (event: OrchestratorEvent) => void): () => void;
  getAgents(): readonly AgentBrief[];
  getVisibleAgentId(): AgentId | undefined;

  // 资源
  readonly theme: Theme;
  getAllThemes(): readonly ThemeInfo[];          // ghostty-theme-sync
  setTheme(theme: string | Theme): void;
  readonly keybindings: KeybindingsManager;

  onDispose(handler: () => void | Promise<void>): void;
}
```

`ComponentFactory` 就是 `(tui: TUI, theme: Theme) => Component & { dispose?(): void }`，直接用 `@earendil-works/pi-tui` 的 `Component`。宿主不需要发明自己的组件模型。

两点要求：

- **`registerShortcut` 不接受裸键序列。** AGENTS.md 明令"Never hardcode key checks such as `matchesKey(keyData, "ctrl+x")`；add defaults to configurable keybinding maps instead"。扩展注册的是一个**绑定 id**，默认键位并入 `WIDI_KEYBINDINGS`（`tui/keybindings.ts:34`）的可配置表，用户可覆盖。pi 那种 `registerShortcut("ctrl+shift+x", …)` 的形态不采用。
- **`setFooter` 的数据来源是 core 事实，不是宿主私有缓存。** pi 用 `FooterDataProvider` 兜住"git branch + 扩展 status"这些散落信息；widi 应当让内置 footer 和扩展 footer 消费同一份投影（含 C2 的上下文用量事件），否则两者会不一致。

### 6.4 两半怎么协作

**不需要新的跨层通道。** core 半照旧 `publishMessage({ kind, title, content })` 或 `setStatus`，或（补了 C4 之后）`prompt(text, { presentation: { customType, details } })`；tui 半按 `extensionId` + `customType` 认领同源消息，用自己的渲染器画。

这正是 pi 的 `registerMessageRenderer` 想做的事，区别在于 core 完全不知道渲染器存在——它只知道自己发了一条带 `extensionId` 的结构化消息。附带好处：`publishMessage` 已经持久化为 session custom entry，所以**重放与 hydrate 自动成立**，渲染器在会话恢复时同样生效。

需要更复杂的载荷时，`ExtensionMessage` 可以加一个 `data?: JsonValue` 字段，tui 半负责解释。core 不解释它。

### 6.5 生命周期

- **runtime 级单例**：宿主在 TUI 启动时激活全部 tui 半，退出时 dispose。回调里凡涉及具体 agent 的，`agentId` 作为参数传入。
- **core reload 不联动**：core 的 `reloadExtensions` 换掉 per-agent runner，与 tui 半无关。tui 半需要单独的 reload 入口（可以先不做）。
- **降级是常态**：tui 半可以不存在（极简版），core 半不得依赖它存在；反之 tui 半只能是纯增强，不能承载唯一关键路径。这条要写进扩展作者文档。
- **失败隔离**：一个 tui 半激活失败或渲染抛错，不能拖垮 TUI。渲染器外层包 try/catch，失败降级到内置渲染并报一条诊断。

### 6.6 Trust 与安全

tui 扩展能画屏、能吃按键（若将来开 `onTerminalInput` 甚至能读原始输入），危险性不低于 core 扩展。复用现有 trust：

- `agentDir` / settings 根：默认可加载。
- `cwd` 根：需项目已信任，与 `createExtensionRoots` 现有逻辑一致。
- `onTerminalInput` 这类原始输入拦截，建议**先不开**；等有真实需求再单独论证。

第 4 节新增两条需要专门论证的：

- **C1 的跨会话读取**是一个新的信息面。扩展从此能读到整段历史对话，包括它从未参与过的那些。这与 `cwd` 根同级要求项目信任，**范围收窄到当前 cwd（项目）**。
- **C3 的侧信道查询**会花用户的钱、走用户的凭据。即便 key 不出 core，也要计入配额、可被 abort、并在诊断里可溯源到 `extensionId`。

### 6.7 装配：发行版 vs 极简版

- **极简版 `widi-harness`**：core + 内置 TUI，不装配宿主模块，代码可 tree-shake。
- **发行版**：同一份代码装配宿主模块，外加预置 `.widi/`（profiles、skills、extensions）。宿主的启用与扩展路径由 settings（如 `tuiExtensions`）声明。

差异是**装配差异**，不是运行时开关差异。

---

## 7. 为什么宿主不应是 core 扩展

把 `tui-extension-engine` 做成由 core loader 加载的扩展，意味着它激活时必须拿到 `TUI` 实例句柄。句柄只能从 core 的 `ExtensionContext` 传进去——那等于在 core API 上开了一个 `ctx.ui`，pi 的耦合原样回来，只是多绕一层。

其次生命周期不对：core 扩展是 per-agent 的，一个 runtime 级的 TUI 宿主挂在 per-agent runner 上，第一个 spawn 的 agent 就会决定宿主归谁，第二个 agent 加载同一扩展时会重复激活。

正确的位置是：**宿主是 TUI 应用自己的一个模块**，与 `CommandEngine`、`EventProjector` 平级，由 `WidiTuiApplication` 装配。

同样的论证适用于 C5 的事件总线：它必须是 runtime 级的，但它**不涉及 TUI**，所以归 orchestrator/runtime service 持有，而不是宿主。

---

## 8. 路线图

三条线可独立推进。**顺序上建议阶段 0 先行**——它成本最低，却解锁了生态里最多的扩展。

### 阶段 0：core C 类能力补齐 —— 已完成（2026-07-28，分支 `extensions-upgrade`）

裁决：本轮交付 **C1 + C2 + C4 + C7**；C3 等 M3 的 `spawnEphemeral`；C5、C6 下一轮；`registerFlag` 砍掉（CLI 解析先于扩展加载，成本与收益不成比例，生态里只有 pi 自己的示例扩展在用）。

已落地：

1. **C1 会话读取** —— `ExtensionSessionContext` 加 `getSnapshot` / `getTree` / `getLeafId` / `listSessions` / `readSession`。范围裁决为 **cwd（项目）+ 完整 entries**，与既有 `listAgentSessionCandidates` 的收窄维度一致（原文档写的"agent dir"是错的）。跨会话读取要求 project trust，与 `exec` 同级；own-agent 读取不设门。扩展面用独立 DTO，以运行时铸造的不透明 `ref` 寻址，不暴露 `path`/`cwd`；ref 只在本进程有效，由 own-session 读取或 session listing 返回，构造不出指向未被展示过的 session 的 ref。引用命中已打开的 session 时走 live handle，避免绕过未 flush 的写入。所有 entry 结果都做防御性复制，扩展不能借读取结果修改 live session。
2. **C2 上下文用量** —— `actions.getContextUsage()` 返回 `{ tokens, contextWindow, percent, model }`，`percent` 用 **0–100**（与 pi 同刻度）。settle 时测量并缓存在 agent record，发布 `agent_context_usage_changed`。**自动压缩改为消费同一次测量**，所以一次 settle 只读一遍分支而不是两遍。四种情况作废缓存：压缩、树导航、换模型、新分支上没有可测量的 usage。
3. **C4 结构化消息** —— `prompt`/`steer`/`followUp` 三条都加 `options.presentation`，user message 落盘后写 `core:extension_input_presentation` 条目并发布 `extension_input_presented`。条目用 `messageEntryId` 显式关联实际 user message，不靠相邻性。**`extensionId` 由 core 注入**，渲染器按 `(extensionId, customType)` 匹配——这就地解决了未决问题 1，不需要宿主做字符串前缀拼接，也堵住了冒用他人 customType 劫持渲染器的口子。Block、直接投递失败或 queue abort 都不会留下 presentation。
4. **C7 小口子** —— `isProjectTrusted` / `getSystemPrompt` / `hasPendingMessages`。`getSystemPrompt` 顺带把 harness 的 systemPrompt 回调抽成 `_buildAgentSystemPrompt`，读写两条路不再各写一份。

实际改动：`core/types.ts`、`core/agent-record.ts`、`core/session-manager.ts`、`core/message.ts`、`core/extension/{types,presentation,runner}.ts`、`core/agent-orchestrator.ts`，新增 `tests/core/extension-core-capabilities.test.ts`（29 个用例），文档同步 `docs/zh-CN/core/{extensions,runtime,sessions-and-runtime}.md` 与 `docs/zh-CN/extension-authoring.md`。

**勘误（实现中发现，与 4.3 的描述不符）**：`ExtensionActions.steer` / `followUp` 直连 harness，不走 `_sendMessage`，因此不跑 `input` 拦截器也不写会话条目——这是既有的"低层逃生口"设计。presentation 因此走两条路：`prompt` 的在 `_sendMessage` 管线内，`steer`/`followUp` 的在外层包一层。三条都能带 presentation，但它们的拦截行为保持原样未动（未决问题 9）。

### 阶段 0 的审查修订（同日）

首版实现通过了 check 与全部测试，但审查发现四个阻断级行为错误与四个接口质量问题，全部成立并已修复：

1. **presentation 与消息不是原子的** —— 事件在投递之前就发了（收不回），且 `promptAgent` 的 block 是**返回值不是抛出**，外层 catch 接不到，被拦截的 prompt 会留下一条描述着从未存在的消息的 presentation。最终修法比首轮审查方案更强：prompt 的 presentation 改走 `_sendMessage`，block 在任何 session 写入之前就返回；steer/followUp 按 harness queue 中的具体 message 对象跟踪，abort 时直接丢弃；只有 harness 把 user message 写入 session 后才追加 presentation entry，entry 携带实际 `messageEntryId`，随后才发 event。因此不需要预写与回退，也不会产生“有 presentation、无消息”的孤儿记录。
2. **扩展根本收不到 `agent_context_usage_changed`** —— 类型声明了可观察，但 `_isExtensionObservedEvent` 是手写 switch，漏了分支。根因是那个 switch 返回类型谓词却没有穷尽性保护。修法：改成 `EXTENSION_OBSERVED_EVENT_NAMES` 这张 `Record<ExtensionObservedEventName, true>` 表，漏一个名字就是类型错误。
3. **`hasPendingMessages()` 查错了队列** —— 只看 orchestrator 的 `_messages`，但扩展的 steer/followUp 直接进 harness 私有队列。修法：从 `queue_update` 事件镜像 harness 队列长度到 agent record，两个队列一起算。
4. **`percent` 刻度与 pi 生态不兼容** —— 我写的 0–1，pi 是 0–100，移植扩展的 `>= 95` 永不触发。修法：改 0–100。
5. **仍在向扩展暴露文件路径** —— `AgentSessionCandidate` 带 `path`/`cwd`/`parentSessionPath`，与"不给文件路径"的裁决自相矛盾。修法：引入扩展面 DTO（`ExtensionSessionCandidate` / `ExtensionSessionSnapshot` / `ExtensionSessionTree`），用运行时铸造的不透明 `ref` 寻址，fork 谱系用 `parentRef`。
6. **上下文用量缓存会返回过期状态** —— 换模型、树导航、以及新分支上没有可测量 usage 时都不失效。修法：这三处全部作废缓存；tree navigation 只在 leaf 实际改变时作废，cancel/no-op 不制造虚假变更。
7. **新公共类型没进扩展 API barrel** —— 已补齐。
8. **`details` 并非真正 JSON-safe** —— 只做了大小检查却返回原引用，函数/`undefined`/`NaN` 会让 live event 与 JSONL 恢复结果不一致，且 core 握着扩展还能改的引用。修法：类型收紧为 `JsonValue`，存储与发布的都是 round-trip 规范化后的 detached clone。Session DTO、context usage getter 与 agent snapshot 同样改为防御性副本。

测试相应补到 29 个用例（全套 963），其中覆盖此前只测了适配层的真实路径：成功与 blocked prompt、harness 队列及 abort、observer 投递、显式 message entry 关联、tree navigation 与 refresh failure 的缓存失效，以及所有新增读取结果的对象隔离。

### 阶段 0 剩余 + 阶段 1：实施决议（2026-07-29 定，进入实施阶段）

本节是**待执行的施工说明**，不是备选方案讨论。四个批次：A、B 属于阶段 0 剩余（纯 core），C、D 属于阶段 1（协议 + TUI 内置渲染）。A 与 B 互不相干，可合并为一次 `npm run check`；C 必须先于 D 冻结协议。粗估 A 半天、B 半天、C 半天、D 一天。

C3 侧信道查询继续 deferred，等 M3 collaboration facade 的 `spawnEphemeral`（未决问题 7）。在那之前 auto-permissions / session-recall / codex-compaction / ghost 这四个旗舰扩展仍跑不了，这是已接受的代价。

#### 批次 A：C5 扩展间事件总线

API 形状——扁平方法名，不套 `events` 对象，与既有 `observe` / `intercept` 同风格：

```ts
// ExtensionActivationApi（激活期注册，落在 loader 的 scope 里）
onExtensionEvent(name: string, handler: ExtensionEventHandler): void;
// ExtensionActions（运行期发送）
emitExtensionEvent(name: string, payload?: JsonValue): Promise<void>;

interface ExtensionEventEnvelope {
  readonly name: string;
  readonly payload?: JsonValue;
  readonly sourceExtensionId: string;
  readonly sourceAgentId: AgentId;
  readonly emittedAt: string;
}
```

裁决：

1. **总线不需要独立的订阅表。** runner 本身就是订阅者集合：orchestrator 遍历 `_agents` 的 `record.extensionRunner`，调 `runner.emitExtensionEvent(envelope)`。reload 换 runner 即换订阅，`ExtensionRunner.dispose` 已经清空 `_loadedScope` 的 handler map，退订是免费的。C5 因此不引入第二套生命周期。
2. **runtime 级由此自动成立**：持有者是 orchestrator，per-agent runner 只是投递目标，4.4 的基数问题不复现。
3. **自投递开着**：源 runner 也收自己发的事件。生态里 herdr 模式是"任意谁发、任意谁收"，排除自己会让"同一扩展在两个 agent 实例间协调"变得无法解释。
4. **不作为 `OrchestratorEvent` 发布。** payload 是扩展间的私有约定，客户端解释不了；发出去等于把任意 JSON 灌进 TUI 投影。诊断仍然可见。
5. **payload 走 C4 的同一套纪律**：类型收紧为 `JsonValue`，经 `utils/json.ts` 的 `normalizeJsonValue` round-trip 规范化为 detached clone，上限 64 KB；分发前递归冻结 payload 并冻结 envelope，所有订阅者共享同一个运行时不可变副本。name 复用 `EXTENSION_PRESENTATION_TYPE_PATTERN` 的字符约束（允许 `herdr:blocked` 这类冒号形式），上限 128 字节。
6. **递归熔断**：用 `AsyncLocalStorage` 记录当前异步因果链的分发深度；handler 内嵌套 emit 会继承深度，彼此独立的并发 emit 各自从 0 开始。超过 8 层丢弃并报 `extension.event_recursion_dropped`。handler 抛错走既有 `_createHandlerDiagnostic`，不影响其余订阅者。

落点：`core/extension/types.ts`（新类型 + `ExtensionActionFailure["action"]` 增 `emitExtensionEvent`）、`loader.ts`（scope 增 `extensionEventHandlers`、`createActivationApi` 增注册、dispose 清空）、`runner.ts`（分发方法 + `inspect()` 的 hooks 增 `kind: "event"` + `createUnboundActions` 补桩）、`agent-orchestrator.ts`（`_createExtensionActions` 实现）、`extension/api.ts` 与 `extension/index.ts` barrel。

测试（新增 `tests/core/extension-events.test.ts`）：跨 agent 投递、reload 后旧 runner 不再收、dispose 退订、handler 抛错只产诊断且不中断其余订阅者、payload detached（发送方事后 mutate 不影响接收方）、非法 name 与超限 payload 抛出、递归熔断。

#### 批次 B：C6 `waitForIdle` + `requestShutdown` + `disposeRuntime`

`waitForIdle(options?: { signal?: AbortSignal }): Promise<void>`

- 语义定死为"本 agent 空闲且两条队列都空"，即 `status !== "running" && !agentHasPendingMessages(agentId)`——复用 `hasPendingMessages` 已有的双队列判据，不制造第二种"空闲"。
- 实现：orchestrator 新增 `_agentIdleWaiters`，照抄 `_agentRunStartWaiters` 的 waiter-set 模式；唤醒点是既有的状态转换与 `queue_update`（harness 队列镜像就在那里）。
- 终止条件必须显式：agent dispose 时 reject，否则扩展会把 dispose 流程永久挂住。`signal` 支持取消。
- 文档警告：在 `tool_call` / `context` 拦截器里 await 它必然死等（那一刻 agent 就是 running）。

`requestShutdown(reason?: string): Promise<void>`

- **core 只发请求，不自己关。** 新增 `OrchestratorEvent`：`runtime_shutdown_requested { requestedBy, agentId, reason?, createdAt }`。进程与终端归宿主：core 偷偷 `disposeAll` 会绕过 TUI 的终端恢复路径。
- orchestrator 侧记幂等标志，重复请求只发一次事件。
- TUI 侧：`tui/application.ts` 的 `handleEvent` 增一个 case——先推一条 notice（谁请求的、原因），再 `void this.shutdown(...)`，走既有 `performShutdown`（`disposeAll` + 终端恢复）。
- 无人处理时不做超时兜底。headless 嵌入者自行订阅该事件。
- 把 `runtime_shutdown_requested` 加进 `EXTENSION_OBSERVED_EVENT_NAMES`：成本近零，且"要关了赶紧落盘"是真实需求。该事件先广播并 await 全部活着的 extension runner，再发布给宿主；因此 TUI 即刻开始 `disposeAll` 也不会抢先使尚未收到通知的 runner stale。

`disposeRuntime(reason?: string): Promise<void>`

- core 的 `orchestrator.disposeAll` 直接暴露给扩展，作为**无宿主时的兜底通道**：有 TUI 在跑时应当用 `requestShutdown`，否则会留下一个"没有任何 agent 的 TUI"这种半死状态。
- 重入必须写清楚：这条调用会 dispose 调用者自己的 runner。`_runReportedAction` 的 `_assertActive` 在调用前完成，因此调用本身能正常返回，但**扩展的 `onDispose` 会在这条 promise resolve 之前跑完**，resolve 之后 context 已 stale，任何后续 action 都会抛。文档里按"最后一条语句"来写。

测试：idle 快路径与挂起路径、dispose 中断 reject、signal 取消、shutdown 事件只发一次且 `requestedBy` 由 core 注入、`disposeRuntime` 后 context stale、`tests/tui/application.test.ts` 补一条"收到事件即走 shutdown"。

#### 批次 A、B 实施记录（2026-07-29 完成）

已落地并经复审修订，`npm run check` 通过，全套 990 个用例通过。批次 A、B 的回归覆盖现为 `tests/core/extension-events.test.ts` 12 个、`tests/core/extension-runtime-control.test.ts` 11 个，另在 `tests/tui/application.test.ts` 补了 1 个关机请求用例；随后 shared utilities 重构为共享 JSON 规范化补了 3 个用例。

实际改动（含随后 shared utilities 重构）：新增 `core/extension/events.ts` 与 `utils/json.ts`；改 `core/extension/{types,presentation,loader,runner,api,index}.ts`、`core/types.ts`、`core/agent-orchestrator.ts`、`tui/application.ts`。

与批次说明有出入或需要记下的七点：

1. **JSON 规范化抽成了共享 utility**而不是留在 `presentation.ts`：`normalizeJsonValue` 现在住在 `utils/json.ts`，presentation details 与事件 payload 共用同一份 round-trip + detached clone 纪律。
2. **事件名在注册期校验，非法名字会让整个扩展激活失败**（进而阻断该 agent 的 spawn），与 `registerProvider` 的空名字、`appendSystemPrompt` 的空文本同级。理由：没人 emit 的名字和还没人发过的名字在运行期无法区分，拼错会永远沉默。
3. **`runtime_shutdown_requested` 是 runtime 级事实，字段用 `requestedBy` + `requestedByAgentId`，刻意不叫 `agentId`**。为此 `_emitToExtensionObservers` 增加了一条广播路径：没有 agent 主语的被观察事件发给全部活着的 runner，否则"要关了赶紧收尾"只会通知发起请求的那一个 agent。
4. **`waitForIdle` 的 abort 监听在 finally 里显式摘除**。调用方的 signal 通常比一次等待活得久（run signal 覆盖整个 turn），留着监听会把这次 promise 的闭包钉在 signal 的生命周期上。
5. **事件的 readonly 契约现在也在运行时成立**。规范化只解决了发送方事后 mutate；若把同一个可变 envelope 依次交给订阅者，前一个仍能伪造 attribution 或改写后一个看到的 payload。分发入口现在递归冻结 detached payload，并冻结 envelope 本身。
6. **事件递归深度是因果链局部状态，不是全局并发计数**。原标量计数器会把 9 个互不嵌套、但同时在途的 emit 误判成超过 8 层。现在用 `AsyncLocalStorage<number>` 让嵌套 emit 继承深度，同时隔离独立并发。
7. **shutdown 的扩展观察者必须先于宿主监听者完成**。TUI 收到请求会立即异步执行 `disposeAll`；若沿用普通事件的"宿主先、扩展后"顺序，runner 可在广播途中变 stale。`requestShutdown` 现在先 await 扩展广播，再以 `observeExtensions: false` 发布同一请求给宿主，避免重复投递。

#### 批次 C：阶段 1 core 协议扩展

`ExtensionMessage` 从"扁平 kind + content"改为判别联合。不保留向后兼容（AGENTS.md 的既定立场）；已持久化的旧条目全部落在 text / markdown / code 三支上，重放不受影响。

```ts
type ExtensionMessage =
  | { kind: "text" | "markdown"; title?: string; content: string }
  | { kind: "code"; title?: string; content: string; language?: string }
  | { kind: "table"; title?: string; columns: readonly ExtensionTableColumn[];
      rows: readonly (readonly string[])[] }
  | { kind: "fields"; title?: string;
      fields: readonly { label: string; value: string; tone?: ExtensionTone }[] }
  | { kind: "diff"; title?: string; path?: string; patch: string }
  | { kind: "banner"; title?: string; severity: ExtensionTone; content: string };
```

- 上限：列 ≤ 12、行 ≤ 200、单元格 ≤ 1 KB、fields ≤ 64 项，整体仍受 64 KB 约束。
- `validateExtensionMessage` 目前靠"重建对象"实现 detach，联合形态带数组，**必须改成深拷贝并递归冻结规范副本**，否则复现阶段 0 复审第 8 条那个"core 握着扩展还能改的引用"，或让事件消费者改写 session 持有的同一个对象。

`ExtensionStatus` 增三个字段：

```ts
region?: "panel" | "footer" | "agent-strip";  // 默认 panel，即现在的 StatusView
icon?: string;                                 // 单字符，显示宽度 ≤ 2
tone?: ExtensionTone;                          // 语义 token，不给颜色
```

`header` 这一轮不开：现在的 `HeaderView` 只有一行 `WIDI · agent · model`，塞扩展状态会立刻挤爆；等阶段 2 宿主的 `setHeader` 一并处理。

#### 批次 C 实施记录（2026-07-29 完成）

已落地并经复审修订，`npm run check` 通过，全套 1005 个用例通过（新增 `tests/core/extension-presentation.test.ts` 14 个、`tests/tui/session-hydrator.test.ts` 补 1 个）。改动：`core/extension/{presentation,api,types}.ts`、`core/agent-orchestrator.ts`、`tui/{session-hydrator,components/timeline-item}.ts`。

与批次说明有出入或需要记下的七点：

1. **判别联合按具名 interface 拆开**（`ExtensionTextMessage` / `ExtensionCodeMessage` / …），并从 `extension/api.ts` 一并导出。扩展作者要为某一支写函数签名时，没有具名类型只能自己 `Extract<...>`。
2. **`tone` 的取值定为 `neutral | info | success | warning | danger`**，与诊断的 `warning | error` 是两套：诊断说的是"出没出事"，tone 说的是"客户端给多少强调"，core 不给颜色。
3. **表格拒绝参差行**：行的单元格数必须等于列数。少一格时渲染器只能猜这格属于哪一列，而消除这种猜测正是 table 这一支存在的理由。
4. **图标按字素簇校验，core 不量显示宽度**。"显示宽度 ≤ 2"需要 wcwidth 表，那张表在 `pi-tui` 里，core 不依赖 TUI。改判据为 `Intl.Segmenter` 下恰好一个字素簇（旗帜、带肤色的 emoji 都算一个）+ 32 字节上限 + 拒绝控制字符，显示预算由客户端自己截断。
5. **hydrator 的易漏点提前在本批解决，并且是结构上解决的**（原属批次 D 第 4 条）：`session-hydrator.ts` 不再手写 kind 列表，而是直接调 `validateExtensionMessage` 解析持久条目，非法条目丢弃。协议再改也不可能漏掉这里。`timeline-item.ts` 本批只做了保证可读的降级扁平化（`extensionMessageText`），分 kind 的真渲染仍在批次 D。
6. **结构化数组必须是稠密数组**。`Array.prototype.map` 会跳过空洞，原实现会接受 sparse columns / rows / cells / fields，写进 JSON 后空洞变成 `null`，hydrator 重校验时又将其丢弃。validator 现在显式遍历每个索引并拒绝空洞，保证"接受即可持久化往返"。
7. **规范 message 与发布事件都在运行时不可变**。validator 对深拷贝结果递归 `Object.freeze`，session entry data 与 `extension_message_published` envelope 也冻结；宿主 listener 不能改写后续消费者或内存 session 看到的内容。

#### 批次 D：阶段 1 TUI 内置渲染

1. `tui/components/timeline-item.ts` 的 `extension-message` 分支按 kind 分派：table 算列宽加截断、fields 对齐、diff 走既有 `tui/diff.ts` 的 `renderDiffText`、banner 走 `theme.severityPaint`。
2. `tui/components/status.ts` 按 region 过滤，渲染 icon 与 tone。
3. `tui/components/footer.ts` 与 `agent-strip.ts` 接线（footer 单行压缩，strip 在 agent 项上挂标记）。这两处现在完全没有扩展状态代码，是本批的主要新增。
4. ~~**易漏点**：`tui/session-hydrator.ts` 的 `isExtensionMessageData` 硬编码了三种 kind。~~ —— 已在批次 C 解决：hydrator 改调 `validateExtensionMessage`，不再自己枚举 kind。
5. 测试：`tests/tui/` 补每种 kind 的渲染断言，外加一条"持久化 → hydrate → 渲染"的往返用例。

覆盖场景：状态栏、进度、结构化报告、审计输出。它同时是阶段 2 的降级路径，不会白做。

### 阶段 2：TUI 扩展宿主

实际工作量大头不在扩展 API，而在**把 `tui/application.ts` 里硬编码的装配抽成可注入的插槽**——这活儿对 TUI 代码本身也是净收益：

1. 版面插槽化：footer / header / widget 位从直接 `new FooterView()` 改为可替换的槽（`application.ts` 的应用类现在直接持有全部视图实例）。
2. overlay 栈：现在 `HumanRequestMenu`、`AgentSelectorController`、`CompletionMenu` 各自管自己的焦点，需要统一成一个可被扩展复用的浮层栈，并支持 `OverlayHandle`（活体浮层）。
3. `tool-presenter` 注册表化：`presentToolExecution` 内部的 `describeToolCall` 分发改为查表，表由内置项 + 宿主注册项组成。
4. 命令注册：`CommandEngine` 已经接受 `CommandDefinition[]`，加一个运行期注册入口即可。**这一项单独就能解锁 ssh-tools / model-agents / flicker 三个扩展。**
5. 快捷键注册：扩展声明绑定 id，默认键位并入 `WIDI_KEYBINDINGS` 可配置表。
6. 编辑器文本与主题：`getEditorText` / `setEditorText` / `pasteToEditor` / `getAllThemes` / `setTheme`。
7. 宿主本体：发现（复用 `ExtensionDiscoveryResult`）→ 导入（复用 `JitiExtensionModuleImporter`）→ 激活 → dispose。

新增目录：`apps/widi-pi/src/tui/extension-host/`。

### 阶段 3（可选，按需）

- tui 半的 reload。
- `setEditorComponent` 等深度替换。
- `onTerminalInput`（需单独的安全论证）。
- C6 的完整会话生命周期控制（需先定多 agent 语义）。
- `registerFlag` / `getFlag`（需解决"CLI 解析先于扩展加载"的顺序问题）。

---

## 9. 未决问题

1. ~~**kind / customType 命名空间**~~ —— **已定（阶段 0 实现）**：不做字符串前缀。core 把 `extensionId` 作为独立字段注入持久条目与事件，渲染器按 `(extensionId, customType)` 这一对匹配。两个扩展可以各用各的同名 `customType`，且没法冒用别人的类型名。宿主的 `registerMessageRenderer` 沿用同一规则。
2. **多 agent 版面归属**：一个 widget 是全局的，还是跟随当前可见 agent？倾向：注册时声明 `scope: "global" | "agent"`，agent 级的只在该 agent 可见时渲染（已并入 6.3 草图）。
3. ~~**`ExtensionMessage.data`**~~ —— **已定（2026-07-29）：推迟到阶段 2**。阶段 1 的结构化 kind（table / fields / diff / banner）已经覆盖生态里 message renderer 的多数场景，而 `data` 的真正消费者是阶段 2 的 tui 半渲染器。现在加等于让 core 先背一个自己不解释的字段，却还没有人读；等宿主落地、有确定的解释方再加，届时仍按"core 永不解释它"写进文档。
4. **版本协商**：core 半与 tui 半各有 `apiVersion`，两个宿主各自校验；同一包两半版本不一致时如何处理（拒绝整包，还是只拒绝不兼容的那半）。倾向：只拒绝那半，另一半照常，并报诊断。
5. **测试策略**：tui 半的渲染怎么测？现有 `tests/tui/*` 已有组件级快照式断言，宿主可复用；需要一个 headless 的宿主 fixture。
6. ~~**跨会话读取的范围**~~ —— **已定（阶段 0 实现）**：cwd（项目）范围 + 完整 entries，要求 project trust。收窄维度取 `SessionDirectoryRepo` 已有的 `list({ cwd })`，不是原先设想的 agent dir。没有通往其他 project 的通道。
7. ~~**侧信道查询的形态**~~ —— **已定**：等 M3 collaboration facade 的 `spawnEphemeral`，不单开 `actions.query()`。代价是四个旗舰扩展在 M3 之前跑不了，这是接受的。
8. **`registerCommand` 是否需要 core 侧影子声明**（新增）：命令引擎在 TUI 层，但纯 core 扩展（无 tui 半）如果也想提供命令怎么办？倾向：不办——命令是交互概念，没有 TUI 就没有命令，这与 `docs/zh-CN/core/extensions.md` 的既定立场一致。但要在文档里写明，避免作者把关键路径放进命令里。
9. **presentation 与 steer/followUp 的拦截不对称**（阶段 0 实现中发现）：`prompt` 走 `sendMessage`（跑 `input` 拦截、写会话条目），`steer`/`followUp` 直连 harness（都不做）。presentation 现在三条都支持——但走的是两条不同的实现路径（prompt 在管线内，另两条在外层包一层），拦截行为的不对称仍在。这是既有的"低层逃生口"设计，不是 bug——问题是扩展作者是否会被这条不对称绊到，要不要在下一轮统一。
10. ~~**presentation 与 user message 之间没有显式 id 关联**~~ —— **已解决（阶段 0 复审）**：不改 upstream。Harness 的 `message_end` 在 session append 之后发出，core 用同一个 live `AgentMessage` 对象反查实际 message entry，并把其 id 写入 presentation entry 与 event。Hydrator 直接按 `messageEntryId` join，不再依赖相邻性；分叉、压缩和后续追加不会让它错配。
11. ~~**关机由谁执行**~~ —— **已定（2026-07-29）**：core 只发 `runtime_shutdown_requested`，由 TUI 走既有 `performShutdown` 执行，进程与终端始终归宿主；同时把 `orchestrator.disposeAll` 以 `actions.disposeRuntime()` 暴露给扩展，作为无宿主时的兜底通道。细则见第 8 节批次 B。

---

## 附：参考位置索引

pi（in-tree 快照）：

- `pi/packages/coding-agent/src/core/extensions/types.ts:38-45` — core 对 TUI 的 import
- 同上 `:129-280` — `ExtensionUIContext` 全量
- 同上 `:305-340` — `ExtensionContext`（`sessionManager` / `modelRegistry` / `getContextUsage` 等 C 类能力所在）
- 同上 `:346-380` — `ExtensionCommandContext`（`newSession` / `fork` / `switchSession` / `waitForIdle`）
- 同上 `:412-437` — `ToolRenderContext`
- 同上 `:480-489` — `ToolDefinition.renderCall/renderResult`
- 同上 `:1174-1409` — `ExtensionAPI` 全量（`registerCommand` / `registerShortcut` / `registerFlag` / `registerMessageRenderer` / `registerEntryRenderer` / `events`）
- `pi/packages/coding-agent/src/core/extensions/runner.ts:233` — `noOpUIContext`
- `pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:135` — RPC 的 UI context
- `pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts:2135` — interactive 的 UI context
- `pi/packages/tui/src/tui.ts:64` — `Component`；`:171` — `OverlayOptions`
- `pi/packages/agent/src/harness/types.ts:120-143` — `AgentHarnessStreamOptions` / `...Patch`（headers 可改，见 C8）
- `pi/packages/coding-agent/examples/extensions/` — 全部示例
- `pi/packages/coding-agent/docs/extensions.md`、`docs/tui.md`

pi-extensions 生态样本（`chat_notes/pi-extensions/packages/`）：

- `pi-minimal-footer/index.ts` — `setFooter` + 上下文用量 + 订阅额度（B 类与 C2 的样板）
- `pi-session-recall/session-recall.ts:97,579,992` — `modelRegistry.getApiKeyAndHeaders` 侧信道调用（C3）
- `pi-auto-permissions/index.ts:246,320,377` — 侧信道审查 + `events.emit`（C3、C5）
- `pi-codex-subagents/peek.ts` — `ui.custom` + `onHandle` 活体浮层（6.3 的 `OverlayHandle` 需求来源）
- `pi-codex-compaction/index.ts:101` — `before_provider_headers` + 侧信道（C8 勘误、C3）
- `pi-quit-and-delete/index.ts` — `registerShortcut` + `getSessionFile` + `process.exit`（C6 的 `requestShutdown` 需求来源）
- `pi-herdr/index.ts`、`pi-tmux/index.ts` — 仅用 `exec` + `registerTool`，widi 现状即可移植
- `pi-worktree/index.ts:14,23` — `events.emit("herdr:blocked")` 跨扩展协作约定（C5）

widi：

- `apps/widi-pi/src/core/extension/types.ts` — `ExtensionActivationApi` / `ExtensionActions` / `ExtensionSessionContext`
- `apps/widi-pi/src/core/extension/presentation.ts` — 呈现协议与上限
- `apps/widi-pi/src/core/extension/loader.ts:89-145` — 发现与 identity 类型
- `apps/widi-pi/src/core/extension/module-importer.ts` — 可复用的导入器
- `apps/widi-pi/src/core/extension/runner.ts:815-840` — 现有 session context 绑定（C1 的改动点）
- `apps/widi-pi/src/core/human-request.ts` — `HumanRequestKind` / `HumanQuestion`（已覆盖 pi 的对话框）
- `apps/widi-pi/src/core/session-manager.ts:174-402` — C1 所需原语已就位
- `apps/widi-pi/src/core/agent-orchestrator.ts:3875` — `calculateContextTokens`（C2 的数据源）
- `apps/widi-pi/src/core/client.ts` — `OrchestratorClient`
- `apps/widi-pi/src/tui/application.ts` — 当前装配点
- `apps/widi-pi/src/tui/tool-presenter.ts` — 工具渲染分发
- `apps/widi-pi/src/tui/keybindings.ts:34` — `WIDI_KEYBINDINGS` 可配置表（`registerShortcut` 的落点）
- `apps/widi-pi/src/tui/commands/` — 命令引擎
- `apps/widi-pi/src/tui/theme/theme.ts` — 主题
- `apps/widi-pi/docs/zh-CN/core/extensions.md` — 现行扩展契约
