# WIDI Pi 第一版 TUI 详细设计

状态：v1 基础实现已落地；保留本文作为实现规格与人工验收清单。

当前实现入口为 `npm run tui`，代码位于 `src/tui-entry.ts` 与
`src/tui/`。现已包含 application coordinator、纯状态 projector、current
branch hydrator、command autocomplete、human-request FIFO overlay、连续
transcript、extension 六通道投影、footer、响应式 agent strip 与 agent
selector；需要参数的 command 与 agent selector 复用 editor 上方的 inline
completion menu。默认 line CLI 继续保留。

本文定义 `widi-pi` 第一版交互式终端应用的产品范围、架构边界、状态模型、事件归约、组件结构、core 契约补充、实施顺序和验收标准。它是实施规格，不替代 [`DESIGN.md`](DESIGN.md) 与 [`core/`](core/) 下描述长期 core 边界的机制文档。

## 1. 目标

第一版 TUI 要在不修改 Pi 单 agent 语义、不把 UI 放进 core、不预建远程 client facade 的前提下，提供一个可以实际使用的 WIDI 终端 coding harness：

- 基于 `@earendil-works/pi-tui` 构建连续对话式终端界面。
- 参考 Claude Code 的聊天优先布局、消息层级和底部状态呈现。
- 一个 `WidiRuntime` 内同时管理多个彼此隔离的 WIDI Agent。
- 允许后台 agent 继续运行，并用底部 agent strip 展示状态和待处理事项。
- 通过配置化按键进入 agent 选择模式，再用上下键与 Enter 切换 active agent。
- 让 human prompt、human request、diagnostic 与 raw harness event 沿 orchestrator 主路径工作，并由交互层 `CommandEngine` 处理命令。
- 为后续 collaboration capability 和更多交互模式保留清晰扩展点，但不在第一版提前实现。

第一版不是 multi-agent collaboration 产品。多个 agent 共享同一个 runtime dependency layer，但拥有各自的 harness、session、profile、model、extension runtime 和 lifecycle。它们可以同时运行和被同一 TUI 切换查看，却不会自动互相委派、通信或形成父子关系。

## 2. 已确认的关键裁决

### 2.1 Consumer 直接使用 runtime

第一版不增加 `WidiClient` facade。TUI 是可信的同进程 application consumer，直接持有 `WidiRuntime`，并只通过 `AgentOrchestrator` 的公共方法查询和操作 core。

```text
WidiTuiApplication
  -> WidiRuntime
       -> AgentOrchestrator
            -> Agent A / Harness A / Session A
            -> Agent B / Harness B / Session B
            -> Agent C / Harness C / Session C
```

不允许 TUI 读取 orchestrator 私有 agent map、直接持有 harness，或绕过 orchestrator 操作 session、extensions 和 lifecycle。

只有出现真实的远程 RPC、跨进程 transport 或多个复杂 consumer 需要统一协议时，才重新评估 client facade。届时 facade 应从已经验证的 consumer 调用集合中提炼，而不是预先镜像 orchestrator 的全部方法。

### 2.2 一个 runtime 管理多个 agent

默认部署单位是“一个进程、一个 cwd、一个 `WidiRuntime`、多个 Agent”。这些 agent 共享：

- settings、project trust 和 config resolution。
- auth storage 与 model registry。
- profile、resource、tool 与 extension dependency services。
- session manager 和 execution environment。
- orchestrator event、diagnostic 与 human-request 边界。

只有需要不同 cwd、不同 credential boundary 或真正的 execution isolation 时，才创建多个 runtime。多 runtime 不属于第一版 TUI 状态模型。

### 2.3 UI 状态属于 TUI application

以下状态属于具体 TUI，不进入 core，也不进入 Pi session：

- active agent。
- agent selector 当前选中项。
- 每个 agent 的 render timeline projection。
- unread、attention 和 collapsed/expanded UI 状态。
- editor draft、autocomplete snapshot 和 overlay queue。
- global notices 的展示与关闭状态。

Core 继续拥有 Agent、session、runtime lifecycle、diagnostics 和 human request 的真实事实；command definition、执行结果与 completion menu 状态属于交互层。

### 2.4 采用底部 Agent Strip 布局

第一版采用聊天优先的单列布局，agent strip 常驻底部：

```text
header / startup notices
chat transcript
working status / human request overlay
inline completion menu（按需）
editor + autocomplete
footer
agent strip
```

宽终端直接显示多个 agent 的 label、status 和 attention；窄终端只显示 active agent 与聚合计数，完整列表通过 agent selector 查看。agent strip 不应无限换行挤压 chat viewport。

### 2.5 切换只改变视图

切换 active agent 不暂停、不 abort、不 dispose 后台 agent，也不改变其 session。切换动作只更新 TUI application state、刷新该 agent 的 command autocomplete，并将 chat components 绑定到目标 projection。

## 3. 第一版范围

### 3.1 包含

- runtime composition、startup diagnostics 和默认 agent 创建。
- user、assistant、thinking 状态和 tool execution 的终端呈现。
- assistant text streaming。
- `src/tui/commands/` `CommandEngine` 执行 line command 与展开 inline command。
- 由 `CommandEngine.list(status)` 和 command `complete()` 产生的 autocomplete。
- 多个独立 agent 的后台事件归约。
- 底部 agent strip 和 agent selector。
- human request 的 confirm、select、input 与 custom fallback。
- global 与 per-agent diagnostics。
- `/new`、`/fork`、`/resume` 产生新 agent 后的自动切换。
- resume/fork agent 的当前 session branch history hydration。
- graceful shutdown。
- 最小可配置 app keybindings。

### 3.2 不包含

- agent 间委派、消息、等待、join 或 parent/child relationship。
- team、flow、goal 等 product interaction mode。
- `WidiClient`、RPC、socket 或跨进程 transport。
- extension 自定义 widget、header、footer、editor 或快捷键贡献。
- 完整 settings 专用界面。
- 图片粘贴、拖放与 terminal image rendering。
- 多 cwd workspace 或多个 runtime 的统一导航。
- 主题编辑器和用户主题文件。
- 持久化 TUI unread、selection、draft 和折叠状态。
- 为兼容其他 terminal app 而建立第二套 UI protocol。

第一版仍允许尚无专用界面的 built-in command 通过普通 command 输入执行，并以交互层 `CommandResultItem` 呈现。提交未带参数的 line command 时，只要命令声明 `requiresArgument` 或 `complete()`，`CommandEngine` 就返回 `needs-argument`，TUI 在 editor 上方打开通用 inline completion menu；选择候选后以 `/name:value` 重新提交。该补全完全位于交互层，不创建 human request。显式空参数（例如 `/fork:`）不打开菜单，而是直接执行。

## 4. 现有基础与必要补充

### 4.1 已可直接复用

`AgentOrchestrator` 已提供第一版需要的主要能力：

- `spawnAgent()`、`disposeAgent()`、`disposeAll()`。
- `listAgents()`、`inspectAgent()`、`getAgentStatus()`。
- `promptAgent()`、`steerAgent()`、`followUpAgent()`、`abortAgent()`。
- `getAgentSession()`、`getAgentSessionTree()`、session new/fork/resume 操作。
- `subscribe()` 全局事件订阅。
- `registerClient()` 与 human request handler。
- raw `AgentHarnessEvent`、input/session/lifecycle canonical events 和 structured diagnostics。

第一版 TUI 不使用 `subscribeAgent()`：当前实现只检查顶层 event 的 `agentId`，匹配不到 `diagnostic.diagnostic.agentId`。全局 `subscribe()` 才能完整接收 per-agent diagnostics，并由 projector 统一路由。

`pi-tui` 已提供：

- `TUI`、`ProcessTerminal`、`Container` 与 overlay。
- `Editor`、`Markdown`、`Text`、`Loader`、`SelectList`。
- `CombinedAutocompleteProvider`。
- `KeybindingsManager` 和 TUI keybinding definitions。
- differential rendering、terminal width handling 和 input buffering。

### 4.2 Core 必须补充的两个通用契约

#### HumanRequestEnvelope.agentId

Handler 会在 pending event 发布前开始运行，因此 envelope 自身必须携带请求来源，多 agent consumer 才能稳定判断身份。已落地（presentation 前置批次）：

```ts
export interface HumanRequestEnvelope extends Omit<HumanRequest, "signal"> {
	id: string;
	agentId?: AgentId;
	createdAt: string;
}
```

Broker 在解析出 agent id 后，将同一值同时写入 envelope 与 human-request events；调用方 `signal` 不进入 envelope 对象。CLI、TUI、RPC 和 automation 都可消费该字段；它不是 UI 专用信息。

#### agent_status_changed

Status 是 core-owned state，consumer 不通过 raw harness event 猜测 `running` / `idle`，也能可靠观察 `unavailable` / `disposed`。已落地的 canonical event：

```ts
{
	readonly type: "agent_status_changed";
	agentId: AgentId;
	previousStatus?: AgentLifecycleStatus;
	status: AgentLifecycleStatus;
	changedAt: string;
}
```

Status transition 必须先更新 agent record，再发送 event。首次注册 agent record 时 `previousStatus` 为空、`status` 为 `creating`；相同 status 不重复发送。`creating`、`running`、`idle`、`unavailable`、`disposed` 都使用同一事件，不增加平行的 UI status state machine。

`agent_spawned` / `agent_resumed` 继续只表示 harness 构建成功，不能为了满足 UI 初始化顺序而提前到 extension activation 或 harness build 之前。由此，status、diagnostic 或 human request 可以先于 spawn/resume success event 到达。TUI projector 必须对任何未知 `agentId` 懒建 provisional projection；后续 spawn/resume event 再补全 profile/model/snapshot 并启动 hydration。这个裁决同时覆盖构建失败：没有 spawn/resume success event 的 agent 仍可通过 status 与 diagnostic 进入 `unavailable` projection。

Raw harness events 继续作为消息、tool 和 stream 的事实来源；canonical status event 只表达 WIDI Agent lifecycle。

## 5. TUI Application 架构

### 5.1 顶层职责

`WidiTuiApplication` 是具体交互模式的 coordinator。它负责：

- 组装并启动 pi-tui component tree。
- 创建或接收 `WidiRuntime`。
- 在 agent 创建前订阅 orchestrator events。
- 注册 human request handler。
- 持有 application state 与 event projector。
- 通过 `src/tui/commands/` 的 `CommandEngine` 解析、补全和执行交互命令。
- 将 editor submit、快捷键和 selector selection 转为 orchestrator public method call。
- 捕获 application-level unexpected failure。
- 关闭 overlay、取消订阅、停止 TUI 并 dispose runtime。

它不负责：

- profile/resource/tool/extension 解析。
- agent lifecycle 真相。
- session persistence。
- 直接实现 ANSI rendering。

### 5.2 建议模块

```text
src/
  tui-entry.ts
  tui/
    application.ts
    state.ts
    event-projector.ts
    session-hydrator.ts
    autocomplete.ts
    keybindings.ts
    theme.ts
    format.ts
    components/
      chat-view.ts
      user-message.ts
      assistant-message.ts
      tool-execution.ts
      status-view.ts
      footer.ts
      agent-strip.ts
      agent-selector.ts
      human-request-view.ts
      notice-view.ts
```

文件名是实施建议，不是必须一次性创建的空架构。只有出现真实代码职责时才拆分；单次使用、单行逻辑保持内联。

当前 `src/cli.ts` 作为最小 line consumer 在 TUI 开发期保留。先增加独立 `tui-entry.ts` 和 workspace script，验收通过后再决定是否让 package binary 默认进入 TUI。不得为了切换入口直接删除现有 CLI 行为。

## 6. Application State

### 6.1 顶层状态

```ts
export interface TuiApplicationState {
	activeAgentId?: AgentId;
	agents: Map<AgentId, AgentViewState>;
	globalNotices: NoticeItem[];
	humanRequests: PendingHumanRequestView[];
	mode: "editor" | "completion-menu" | "human-request";
	shuttingDown: boolean;
}
```

`mode` 只描述键盘焦点所属交互模式，不描述 core 状态。`completion-menu`
位于正常 component flow；只有 human request 继续使用 capturing overlay。

### 6.2 Per-agent projection

```ts
export interface AgentViewState {
	agentId: AgentId;
	snapshot?: AgentRecordSnapshot;
	status: AgentLifecycleStatus;
	timeline: TimelineItem[];
	extensionStatuses: Map<string, ExtensionStatusSnapshot>;
	unreadCount: number;
	attention: AgentAttention;
	hydration: "pending" | "ready" | "failed";
	bufferedEvents: OrchestratorEvent[];
	pendingInput?: PendingInput;
}

export type AgentAttention =
	| "none"
	| "completed"
	| "human-request"
	| "warning"
	| "error";

export interface PendingInput {
	originalText: string;
	submittedAt: string;
}
```

`snapshot` 是最近一次 query 的只读事实快照，在 provisional 阶段可以为空；`status` 由 canonical status event 更新。它们不是对 core record 的可写镜像。收到未知 agent 的事件时，projector 先以 `agentId`、事件携带的 status/diagnostic facts 建立 projection，再由 application 在 listener 返回后调度 `inspectAgent()` 补全 snapshot。

`extensionStatuses` 的 map key 由 `(extensionId, key)` 组成，只保存 core snapshot，不进入 timeline。Projection 初始化、切换到晚接入 agent 或 hydration 完成后调用 `listExtensionStatuses(agentId)` 补齐当前值；live `extension_status_changed` 负责 replace/clear。`updatedAt` 可用于显示状态年龄，但 TUI 不自行推断过期或自动 clear。

每个 agent 最多有一个等待 user-message 事实的 `PendingInput`。Idle prompt 不并发；running 状态只允许已被 `CommandEngine` 匹配的 line command 执行，因此这个约束不建立新的 queue。Pending input 不等于乐观消息：它只在真实 `message_start(user)` 到达时提供 human-facing original text；blocked 或 throw 路径会清除或恢复它，交互命令不创建 pending input。

### 6.3 Timeline

```ts
export type TimelineItem =
	| UserMessageItem
	| AssistantMessageItem
	| ToolExecutionItem
	| ThinkingStatusItem
	| DiagnosticItem
	| CommandResultItem
	| ExtensionOutputItem
	| PersistentMessageItem
	| HumanRequestTraceItem
	| SessionMarkerItem;

export interface PersistentMessageItem {
	type: "extension-message";
	entryId: string;
	extensionId: string;
	message: ExtensionMessage;
	durability: "durable";
}

export interface HumanRequestTraceItem {
	type: "human-request-trace";
	requestId: string;
	requestKind: HumanRequestKind;
	title: string;
	answer:
		| { kind: "confirm"; confirmed: boolean }
		| { kind: "selected-option"; value: string }
		| { kind: "answered" };
	durability: "ephemeral";
}
```

Timeline 保存 domain-oriented render facts，不保存 pi-tui `Component` instance。Component 根据 item identity 创建或更新，避免 application state 与 pi-tui object lifecycle 互相污染。

Timeline item 同时标记其 durability：session message、tool、persistent extension message 与 session marker 是可由 hydration 重建的 durable item；line-command result、`extension_output` 和 human-request trace 是只存在于当前 application 生命周期的 ephemeral item。Ephemeral 不等于临时 component：只要 application 仍在运行，切换 agent 后仍从 projection 恢复显示；但重新启动、resume 或重新 hydration 时不会从 session 补回。Application-local notice 与 `extension_notification` 位于 `globalNotices`，不属于 timeline。

每个 streaming message 与 tool execution 必须有稳定 key：

- message 使用 session entry id（hydration）或当前 stream-local id（live event）。
- tool 使用 `toolCallId`。
- command 使用 `commandId`。
- `extension_output` 使用 core 生成的 `presentationId` 作为 view key（presentation 前置批次已落地）；projector 不再本地分配 key，也不得使用 `createdAt`。
- `extension_notification` 不进入 timeline；进入 `globalNotices` 时使用 core 生成的 `presentationId` 作为 transient notice key，并保留 agent/extension attribution。
- persistent extension message 使用 session `entryId`；live event 的 `presentationId` 只标识本次 runtime 发布，不参与 hydration 去重。
- human-request trace 使用 `requestId`。
- diagnostic 优先使用 `diagnostic.id`，否则使用现有 diagnostic dedupe facts 生成 view key。

## 7. Component Tree 与布局

### 7.1 Root tree

```text
TUI
  HeaderContainer
  StartupNoticeContainer
  ChatContainer
  StatusContainer
  CompletionMenu
  EditorContainer
  Footer
  AgentStrip
  Overlay: HumanRequestView
```

`ChatContainer` 只承载当前 active agent 的 timeline components。后台 agent event 只更新 projection；切换时重新绑定可见 components。每个 timeline item 的渲染结果按 item identity 与 render-relevant facts 缓存：历史 Markdown 不随 streaming 重复解析，只有当前 streaming assistant 或正在运行的 tool 会重渲染。

Header 只显示 `WIDI · <agent label> · <model id>`；footer 显示缩写 cwd（如 `~/p/widi-pi`）、queue/unread 计数、`← agents` 提示与 thinking level。agent label 与 status 只出现在 agent strip，footer 不重复它们；完整 cwd 与 model 不再同时出现在 header 与 footer。

`Editor` 始终是默认 focus target。Completion menu 或 capturing overlay
关闭后必须显式恢复 editor focus。

### 7.2 Chat rendering

- User message 以 `❯` 引导，保留原始换行。
- Assistant text 使用 `Markdown`；同一 message 的多个 text block 以空行连接，保持块边界。空文本的 streaming assistant 只在没有对应 thinking-status item 时显示 `✻ Thinking…`，避免出现两条指示行。
- Thinking 默认只显示状态行，例如 `✻ Thinking…` 与完成后的耗时；第一版不显示 raw thinking content。
- Tool 呈现通过 TUI 内建 tool presentation registry 完成，core 不携带 UI。内建 coding tools 有语义摘要（`List <path>`、`Read <path> <range>`、`Bash <command>`、`Grep <pattern>` 等）；未知 tool 显示紧凑 `key: value` 参数摘要，不显示原始 JSON。
- Tool 状态 glyph 不依赖颜色即可区分：running `●`（cyan）、success `✓`（green）、error `✕`（red）。
- Tool update 只替换同一个 tool item 的 partial status，不追加无限日志项。
- Tool end 默认收敛：`ls` / `read` / `find` 的成功结果折叠为条数摘要（如 `· 6 entries`）；`write` 折叠为 `· N lines`；其余 tool 显示最多 4 行 dim 预览加 `… +N lines`；error 保留更多行（8 行）。完整 result 保留在 projection。
- `edit` 的成功结果按彩色 diff 呈现（`diff.ts`，消费 core edit tool 的 `details.diff`）：删除行红色、新增行绿色、上下文 dim；单行修改附加 word-level inverse 高亮。折叠态显示前 8 行 diff。
- `app.tools.expand`（默认 ctrl+o）全局切换展开态：展开后 tool 输出上限提高到 400 行 / 40k 字符，`ls` / `read` / `find` / `write` 也显示完整内容。切换只重渲染 tool item（expand 标记参与 per-item render cache 的 deps）。
- Diagnostic 使用稳定 severity glyph 和 fallback message，不在 TUI 重写 diagnostic decision。
- Command result 只在确有用户可见 value 时显示；`undefined` 不产生空白行。其 `unknown` value 必须经过有最大深度、行数和字符数限制的 formatter，不能直接交给 component。
- `extension_output` 每个 event 追加一个独立的 plain-text item，显示 extension id 与 text；不按 Markdown 解释、不合并、不 replace，也不等待后续 completed event。多行与长文本按 component width、最大行数和最大字符数截断。
- `extension_notification` 不创建 timeline item。Application 将它加入 `globalNotices`，`NoticeView` 显示 agent/extension attribution 与折叠为单行的 text，并按 consumer policy 自动移除。它只使用 neutral/info 样式，不增加 unread 或 attention；warning/error 必须来自 diagnostic。
- `extension_status_changed` 不创建 timeline item。Active agent 的状态在 `StatusContainer` 中按 key replace-in-place；有 `total` 时显示 determinate progress，无 `total` 时显示 spinner/计数。非 active agent 只保留 projection，agent strip 最多显示 neutral 摘要或 `+N`，不得把 status 当成 warning/error attention。
- `extension_message_published` 追加一个 durable `PersistentMessageItem`，以 `entryId` 为 view key：hydration 重建与 live event 命中同一 entryId 时替换而不重复。`title` 作为条目标题；第一版 `markdown`/`code` 内容均按 plain text 渲染（保留 `kind` 供后续增强），同样受最大行数与字符数截断。
- Assistant streaming 已建立的 item 不因中途出现 `extension_output` 而拆分；后续 delta 继续更新原 assistant item，output 保持独立 timeline item。

Chat 渲染输出经过 WIDI 侧有限 CJK 行首禁则修正（`cjk-wrap.ts`）：全角标点（`，。！？；：、）》】」』…` 等）不出现在行首，能容纳时上提，否则把前一行末尾的 CJK 字符下推；无法在不级联重排的情况下修正时保持原样。该修正不修改 pi-tui vendor 代码。

Tool arguments/result 与 command result 必须通过 typed formatter 处理，不能把任意对象直接插入 terminal。Formatter 负责 JSON fallback、最大深度、最大行数、最大字符数和敏感字段最小暴露；安全策略仍由 core/tool contract 决定，formatter 只负责展示边界。

### 7.3 Responsive Agent Strip

宽度充足时：

```text
● main  idle    ● reviewer  running 8s    ! researcher  needs input
```

宽度不足时：

```text
● main idle · 1 running · 1 attention · ← agents
```

Agent strip 规则：

- active agent 排第一并使用强调色。
- attention 高于普通 running/idle；error 高于 warning，human request 高于 completed。
- 构建失败或 resume 失败的 `unavailable` agent 显示在 strip 和 selector 中，使用 error attention；它不可接收输入，但用户仍可查看 diagnostics。
- disposed agent 不显示在主 strip，但仍可由 debug/inspect command 查询。
- 超出可用宽度的 agent 归入 `+N` 聚合，不换成多行。
- 所有输出使用 `visibleWidth()` / `truncateToWidth()`，任何 component 行不得超过 render width。

### 7.4 Agent Selector

Agent selector 使用共享的 inline completion menu，在正常 component flow
中显示于 status 与 editor 之间，不覆盖 transcript：

- label：session name；没有 name 时使用 profile label 或 agent id。
- description：status、model、elapsed/unread 与 attention reason。
- up/down：使用 `tui.select.up` / `tui.select.down`。
- Enter：使用 `tui.select.confirm`。
- Esc：使用 `tui.select.cancel`。
- 选择 active agent 后关闭 menu、清除该 agent unread/completed attention、恢复 editor focus。
- 输入可对 label 与 agent id 做 fuzzy filter。

Selector 不直接 dispose、spawn 或 mutate agent。第一版创建新 agent 通过 `/new` 或 application 明确 action 完成，而不是把 `SelectList` 变成 lifecycle owner。

## 8. 启动与关闭生命周期

### 8.1 启动顺序

```text
parse application options
  -> createWidiRuntime()
  -> create merged KeybindingsManager and call setKeybindings()
  -> create TuiApplicationState and components
  -> subscribe orchestrator events
  -> register human-request client
  -> tui.start()
  -> publish/display startup diagnostics
  -> spawn initial agent
  -> hydrate current session branch
  -> inspectAgent()
  -> set active agent
  -> requestRender()
```

必须在 `spawnAgent()` 前订阅事件，避免丢失 `agent_spawned`、status 与 dependency diagnostics。

Pi-tui 必须在 extension 或 core 行为可能发起 human request 前完成初始化，否则 handler 没有可用的 overlay host。

初始 agent spawn 失败时，application 保留 provisional/unavailable projection，将其设为当前诊断视图并禁用 editor submit。用户可以查看错误并退出或修复配置后重启；第一版不伪造一个可运行 fallback agent。其他 agent 的 spawn/resume 失败不抢占当前 active agent，只在 strip 中增加 unavailable/error 项。

### 8.2 Lazy model run

启动创建 agent 和 harness，但不发送 model request。第一个有效用户 prompt 才开始模型 run。这样 autocomplete、agent strip 与 diagnostics 在首次输入前已经可用，同时不会仅因打开应用产生模型费用。

### 8.3 关闭顺序

```text
set shuttingDown
  -> reject new editor submissions
  -> close/cancel local overlays
  -> unregister human-request client
  -> unsubscribe events
  -> disposeAll("tui exit")
  -> tui.stop()
  -> restore terminal state
```

如果 `disposeAll()` 产生 diagnostic，应用应尽可能通过现有 TUI notice 或最终 stderr fallback 报告，但必须保证 `tui.stop()` 在 `finally` 中执行。退出过程幂等；重复 Ctrl+D、signal 或 fatal error 不执行两次 cleanup。

## 9. Event → State → Render

### 9.1 单向流

```text
OrchestratorEvent
  -> EventProjector.apply(event)
  -> mutate deterministic application projection
  -> invalidate affected visible components
  -> tui.requestRender()
```

Orchestrator 会等待 event listener。Listener 必须同步且轻量：不得在 listener 内读取文件、hydrate session、等待 completion query 或执行昂贵 Markdown render。需要异步工作的事件只标记 dirty state，并由 application task queue 在 listener 返回后处理。任何携带未知 `agentId` 的 event 都先通过 `ensureAgentProjection(agentId)` 建立 provisional state，不因尚未收到 spawn/resume success event 而丢弃。

### 9.2 事件归约表

Projector 的输入始终是顶层 `OrchestratorEvent`。遇到 `{ type: "agent_harness_event", agentId, event }` 时，先保留外层 `agentId`，再按内层 `event.type` 归约。下表使用 `harness.*` 标记这些内层 raw events；没有此前缀的条目才是顶层 canonical orchestrator events。

| Event | Projection 行为 | 可见行为 |
| --- | --- | --- |
| `agent_spawned` / `agent_resumed` | 创建或补全 `AgentViewState`，标记 hydration pending | strip 增加或补全 agent |
| `agent_status_changed` | 更新 status | strip/footer 与 command availability 更新 |
| `harness.message_start(user)` | 消费该 agent 的 pending original text（存在时），否则使用 event message；追加 user item | active chat 显示输入 |
| `harness.message_start(assistant)` | 建立 streaming assistant item | active chat 建立响应区 |
| `harness.message_update` | 按 stream id 合并 delta | 只更新当前 assistant component |
| `harness.message_end` | 完成 message，冻结最终 content | active chat 完成 Markdown |
| `harness.tool_execution_start` | 以 toolCallId 创建 item | 显示 tool start |
| `harness.tool_execution_update` | 替换 partial result | 更新原 item |
| `harness.tool_execution_end` | 写入 result/isError，标记完成 | 显示摘要或错误 |
| `harness.queue_update` | 更新 steer/follow-up/nextTurn 数量 | footer/status 提示 |
| `extension_output` | 按 `agentId` 追加一个 ephemeral `ExtensionOutputItem`，以 `presentationId` 为 view key | active chat 显示带 extension id 的 plain text；background agent 只增加 unread |
| `extension_notification` | 以 `presentationId` 向 `globalNotices` 追加带 agent/extension attribution 的 transient notice | `NoticeView` 显示 neutral/info 单行提示；不进 timeline、不增加 unread/attention |
| `extension_status_changed` | 按 `(extensionId, key)` replace 或 clear `extensionStatuses`；event 到达时 registry 已是新值 | active status slot / neutral chips 更新；不进 timeline、不增加 unread/attention |
| `extension_message_published` | 按 `agentId` 追加 durable `PersistentMessageItem`，以 `entryId` 为 view key 与 hydration 去重 | active chat 显示带 extension id 的 message；background agent 只增加 unread |
| `diagnostic` | 路由到 agent 或 global notices；有 id 时按 id 去重 | severity 对应 attention；extension-reported diagnostic 与其他 diagnostic 使用相同组件 |
| `human_request_pending` | 建立/更新 request queue 与 attention | capturing overlay 或 strip 提示 |
| `human_request_resolved` | 移除 pending request，按隐私规则追加 ephemeral `HumanRequestTraceItem` | overlay 关闭；timeline 显示 Yes/No、允许显示的 option 或 `Answered` |
| `human_request_timeout` / `human_request_cancelled` | 移除 pending request，不创建回答留痕 | 关闭对应 overlay/attention |
| `harness.model_update` / `harness.thinking_level_update` | 更新 snapshot display facts | footer 更新 |
| `harness.session_tree` / `harness.session_compact` | 标记 timeline rehydrate | 异步重建当前 branch |

Tool result message 与 `tool_execution_end` 表达同一执行结果时，projector 不重复渲染第二份 tool result。Session hydration 则从 persisted message/tool-call/tool-result 重建同一种 `ToolExecutionItem`。

### 9.3 后台 agent

所有 agent event 都进入各自 projection。只有 active agent 的 components 被 invalidate 和 rebind；后台 event 更新：

- status。
- timeline。
- unread count。
- attention。

后台完成不抢占 focus。后台 human request 打开全局 overlay，但标题必须显示 agent identity；关闭后回到原 active agent 和 editor draft。

后台 `extension_output` 必须进入对应 agent timeline 并增加 unread count，但它本身不提升 `attention`：运行态仍由 status 表达。切换到该 agent 后清除 unread；不得把 output 渲染到当前 active agent，也不得抢占 focus。

后台 `extension_notification` 仍进入全局 notice 区，但必须显示 agent 与 extension attribution；它不切换 active agent、不抢占 focus，也不修改该 agent 的 unread 或 attention。Consumer 可以按队列长度和显示时长淘汰旧 notice，不建立 core 侧 clear/dedupe 协议。

如果 human request 在 spawn/resume success event 前到达，handler 使用 envelope 的 `agentId` 尝试 `inspectAgent()` 获取 profile/session label；查询失败时回退显示 agent id，不能等待 `human_request_pending` event 才决定标题。

## 10. Session History Hydration

### 10.1 来源

恢复历史使用 orchestrator 公共方法返回的 `AgentSessionSnapshot.pathToRoot`。需要完整 tree selector 时才调用 `getAgentSessionTree()`；第一版 chat hydration 不扫描非当前 branch。

### 10.2 Hydrator 职责

`SessionHydrator` 将当前 branch entries 转为与 live projector 相同的 `TimelineItem`：

- message entries 转为 user/assistant items。
- assistant tool call 与后续 tool result 组合为 tool item。
- compaction/branch summary 转为 session marker。
- model/thinking/tools change 更新 display facts，不伪装成普通 chat message。
- WIDI input-transform custom entry 在可关联时用于显示 human original text；model-facing transformed text仍保留为可解释 metadata。
- 未知 custom entry 默认跳过，不把 extension 私有数据随意打印到终端。

交互层 `CommandResultItem`、`extension_output` 与 `extension_notification` 都不写入 session，因此 hydrator 不伪造或恢复这些 live-only facts。重新启动或 resume 后它们消失是第一版明确语义，不属于 hydration failure。若 output 在一次正在进行的 hydration 期间实时到达，仍按 §10.3 进入 `bufferedEvents` 并在基础 history 后重放，不能因为它不可持久化而丢弃。Notification 不与 history 竞争，event listener 可以立即加入 `globalNotices`，不等待该 agent hydration 完成。

Human-facing user message 统一显示人类原始输入，而不是 inline expansion 或 extension transform 后的 model-facing text。Hydration 通过 `core:command_expansion` / `core:input_transform` custom entry 还原 original text；live path 则在 application 调用 `promptAgent()` 前保存 `PendingInput.originalText`，等真实 `message_start(user)` 到达后才消费并创建 timeline item。非本 TUI 发起、没有 pending input 可关联的 user message 回退显示 harness event 携带的 model-facing text。

Expansion/transform custom entry 的 `inputId` 可以关联同一输入中的输入事实，但 `message_start(user)` 不携带 `inputId`，所以第一版不使用它作为 live user-message join key。Per-agent idle prompt 的单 in-flight 约束才是 pending original text 与下一条 user message 的关联保证。

### 10.3 Hydration 与 live event 竞争

Agent projection 创建后进入 `pending`：

1. event listener 将该 agent 的 render-relevant live events放入 `bufferedEvents`。
2. hydrator 读取 `pathToRoot` 并生成基础 timeline。
3. 按接收顺序重放 buffered events。
4. 状态切换为 `ready`，清空 buffer。

Hydration failure 不让 agent 变成 unavailable。它产生 application notice，projection 标记 `failed`，随后仍可显示 live events。

Extension status 不从 session hydration 恢复。基础 timeline 完成后，application 调用 `listExtensionStatuses(agentId)` 获取 runtime current snapshot，再重放 hydration 期间 buffered 的 `extension_status_changed`。Snapshot 与 event 竞争时以 event 接收顺序和 core mutation-first 契约为准；不得通过回放旧 status events 猜测当前值。

Extension persistent message 从 session hydration 恢复：hydrator 将当前分支的 `core:extension_message` custom entry 重建为 `PersistentMessageItem`，以 entryId 为 view key。Hydration 期间 buffered 的 `extension_message_published` 命中同一 entryId 时不产生第二个 item；core 保证 action 返回值、live event 与持久 entry 携带同一 entryId。

## 11. 输入与 Command

### 11.1 普通提交

Editor submit 时必须捕获当时的 `activeAgentId`。异步完成回调不能重新读取当前 active agent，因为用户可能已切换。

```text
editor submit
  -> capture agentId and text
  -> validate local interaction state
  -> CommandEngine.handleInput(text, context)
       -> pass/expanded: record PendingInput, call promptAgent()
       -> executed/failed: update local CommandResultItem
       -> needs-argument: open inline completion menu
  -> prompt UI updates from core/harness events
```

TUI 不乐观追加 user 或 assistant message；两者均以 harness events为事实来源，避免 error、transform 或 blocked input 造成重复和假消息。`message_start(user)` 到达后消费 pending input；blocked/throw 在没有 user message 时恢复原始 editor text。Command result 是交互层本地的 ephemeral timeline item，不依赖 core event。

### 11.2 Running agent 的输入规则

Pi `AgentHarness.prompt()` 在 busy 时会失败，而 steer、follow-up 和 next-turn 是不同语义。第一版不隐式重解释普通输入：

- Agent `idle`：所有输入先经过 `CommandEngine`；pass/expanded 再调用 `promptAgent()`。
- Agent `running`：普通文本保留在 editor，并提示使用 `/steer:<text>` 或 `/follow-up:<text>`。
- Agent `running` 且 `CommandEngine.match()` 命中已知 line command：仍交给引擎，由 command 自己的 `checkStatus` 决定是否可执行。
- Inline command 是 prompt expansion，不是独立运行操作；包含 inline command 的普通文本在 Agent `running` 时与其他普通文本一样保留在 editor。
- Human request overlay 打开时：editor 不提交到任何 agent。

未知 `/typo` 不会命中引擎，在 running agent 上按普通文本保留并显示 local notice。Application 必须捕获 command completion、execution 与 prompt 的异常，恢复尚未产生 user message 的原始 editor text，并提供可见反馈。

后续只有在真实使用反馈证明需要时，才增加“running 时 Enter 默认 steer”之类的 product policy。

### 11.3 Command autocomplete

`CommandEngine` 由 built-in orchestrator commands 与 application commands 构造。Application commands 操作应用自身而非 orchestrator：`/quit` 与 `/exit` 经 `ApplicationCommandHost` 绑定应用动作，与其他 line command 走同一条引擎路径（match、checkStatus、executed outcome、本地 command result）。`host.quit()` 必须是 fire-and-forget——shutdown 会等待 in-flight submit task，在 execute 内 await shutdown 会让命令自己的 submit 死锁。TUI 根据 `engine.list(status)` 和各命令的 `complete()` 生成 pi-tui autocomplete item：

- line command 显示 trigger、name、description、argument hint 与 availability。
- `available: false` 的命令可以显示但置灰，并展示 `unavailableReason`。
- `LineCommand.complete()` 在用户进入参数位置后提供 autocomplete。
- 提交未提供参数的 bare line command 时，只要命令声明 `requiresArgument` 或
  `complete()`，引擎就返回 `needs-argument`；TUI 使用返回的 `CandidateItem[]`
  在 editor 上方打开 completion menu。
- `/model`、`/thinking`、`/resume`、`/tree` 与 `/fork` 的 bare form
  使用该 menu；选择结果重新提交为 `<trigger><name>:<value>`，仍由正常
  `CommandEngine` 路径执行。
- `/fork` 在候选首位额外提供当前 session position；取消 menu 时恢复原始
  bare command 到 editor；选择该项会提交 `/fork:`，显式空参数绕过
  `needs-argument` 并在当前位置执行。
- inline command 由 WIDI command provider 使用固定的 `<` / `>` trigger 产生候选。
- file completion 委托 `CombinedAutocompleteProvider`；WIDI provider 不重写路径扫描。

命令定义不随 agent 或 extension 动态变化；切换 active agent 时重建 provider 以绑定新的 agent context，availability 每次按当前 status 计算。Completion 的异步结果受取消 signal 约束，command execution 不依赖 autocomplete 缓存。

### 11.4 Navigation result

`/new`、`/fork`、`/resume` 的 `EngineOutcome.executed.value` 可以包含新 `agentId`。共享 `switchedAgentId()` 提取该值；Application 同步 projection 后将其设为 active agent并触发 hydration。旧 agent 保留在 runtime 和 strip 中。

## 12. Human Request

### 12.1 Queue

TUI 注册一个 human request handler，内部维护 FIFO queue。同一时刻只显示一个 capturing overlay；其他 request 的 promise 保持 pending。

Core 当前按 client 注册顺序选择第一个提供 `requestHuman` 的 handler，不广播请求。第一版只注册一个 TUI human-request client，并保存 unregister handle；不得假设多个 client 会同时收到同一请求。

每个 queue item 保存：

- envelope 与 `agentId`。
- response resolve/reject。
- abort signal listener。
- enqueue time。

### 12.2 呈现

- `confirm`：明确 yes/no，Esc 返回 `confirmed: false`。
- `select`：`SelectList`，Esc 返回 `value: undefined`。
- `input`：独立 input/editor，空值按 contract 返回 `undefined`。
- `custom`：第一版只支持可安全 fallback 为文本或 option 的 payload；无法解释时显示 diagnostic-friendly notice，并返回 `{ kind: "custom", value: undefined }`。

Overlay 标题始终包含 requesting agent label。后台请求不改变 active agent；answer 完成后清除其 human-request attention，如果还有 unread/diagnostic 则按更低优先级状态继续显示。

Resolved request 在所属 agent timeline 追加一个 ephemeral `HumanRequestTraceItem`，但只保留隐私安全摘要：

- `confirm` 显示 `Yes` / `No`。
- `select` 仅当返回值属于原始 `options` 时显示该 option。
- `select` free input、`input`、`custom` 一律显示 `Answered`，不回显 response value。
- timeout/cancel 不伪造回答；是否显示 application notice 由错误展示规则决定。

Trace 使用 `requestId` 去重，只存在于当前 TUI application 生命周期，不写 session。它补足“用户已经回应了什么类型的请求”的阅读连续性，但不能成为审计或 secret storage。

### 12.3 Abort、timeout 与 dispose

- Signal abort：立即从 queue 移除，关闭当前 overlay，并处理下一项。
- Core timeout/cancel event：清除对应 request UI，不再提交迟到 response。
- Agent dispose：core 取消该 agent pending request，TUI 只消费结果 event。
- Application shutdown：先关闭 local queue，再 unregister client，避免 cleanup 过程中打开新 overlay。

## 13. Diagnostics 与错误

### 13.1 展示来源

- `runtime.diagnostics`：startup notice 区。info 级 resolution facts 合并为一行启动摘要（`<profile> · <provider>/<model> · thinking <level>`），只有 warning/error 才逐条常驻顶部。
- `diagnostic` event with agentId：对应 agent timeline 与 attention。
- `diagnostic` event without agentId：global notices。
- `EngineOutcome.failed`：交互层 `CommandError`，更新本地 command result，不生成 core diagnostic item。
- `promptAgent()` 或其他 orchestrator operation throw `OrchestratorError`：使用其 diagnostic 参与同一 dedupe，不重复显示已经到达的 diagnostic event。
- Harness busy/invalid-state 等未进入 structured diagnostic event 的已知 operation error：以 ephemeral `application-notice` timeline item 进入对应 agent transcript（保持时间顺序），并恢复仍未被 `message_start(user)` 消费的提交文本。
- 未结构化 unexpected application error：无 agent 归属时进入 global notice 区并自动过期，不长期占据顶部；只有 TUI 已停止或无法渲染时才写 stderr fallback。

TUI active 期间禁止使用普通 `console.log()` / `console.error()` 输出业务信息，否则会破坏 pi-tui differential rendering。

所有 application→orchestrator 异步调用都通过同一个 operation wrapper 完成 cleanup、pending input 处理和 error normalization。这个 wrapper 不把 harness error 重新定义成 core diagnostic；它只保证 consumer 有可见反馈且不会留下 disabled editor、未关闭 loader 或未处理 rejection。

### 13.2 Dedupe

Diagnostic 优先用 `id` 去重；没有 id 时使用 core 已定义的 code/source/agent/operation correlation facts生成 view key。相同 diagnostic 被 throw、return 和 event 同时观察时只展示一次。

`reportDiagnostic` 产生的每次上报都有 fresh core id，因此即使 code 相同也表示多个独立事实，TUI 不按 code 合并。它与 load/runtime diagnostic 走同一 `DiagnosticItem` 与 attention 规则。

### 13.3 Attention 优先级

```text
error > human-request > warning > completed > none
```

切换到 agent 清除 unread/completed 与 transient attention；diagnostic-backed warning/error、pending human request 与 unavailable 状态保留。Diagnostic 是否消失必须由后续事实、reload 或明确 UI dismiss 决定，不能因“看过”而假装问题已解决。

Active agent 的普通 tool failure 只以内联 tool error 呈现，不提升 agent-level attention；后台 agent 的 tool failure 产生 transient `warning` attention，用户查看该 agent 后清除。strip attention 主要表达：后台新发生的 error/warning、human request、unavailable agent 与后台完成未查看。warning 在 strip 中使用黄色 `!`，不与普通 `●` 混淆。

## 14. Keybindings

App keybinding 通过 declaration merging 和 `KeybindingDefinitions` 注册，使用一个包含 TUI defaults 与 WIDI defaults 的 `KeybindingsManager`。

Pi-tui 的 `SelectList`、`Editor` 等组件通过全局 `getKeybindings()` 读取 manager。Application 必须在创建任何 pi-tui component 之前构造合并后的 manager，并调用 `setKeybindings(manager)`；只把 manager 保存在 `WidiTuiApplication` 字段上不足以影响组件内部按键匹配。

第一版 app actions：

```ts
export interface WidiAppKeybindings {
	"app.agents.open": true;
	"app.interrupt": true;
	"app.exit": true;
}
```

建议 defaults：

- `app.agents.open`：`left`，仅在 editor empty、没有 autocomplete、没有其他交互界面时触发。
- `app.interrupt`：`escape`，优先级为关闭 autocomplete/completion menu/overlay，再 abort active running agent。
- `app.exit`：`ctrl+d`，仅 editor empty 时退出。

Agent selector 内部使用 `tui.select.*`，不重新声明上下键与 Enter。组件不得出现 `matchesKey(data, "left")` 等硬编码业务按键检查；只匹配 action id。

如果 `left` 与 editor 光标移动冲突，`app.agents.open` 的 local condition 必须先确认 editor 为空且光标没有可移动内容。用户后续可以通过 keybinding config 修改 default，而不改 component code。

## 15. 实施阶段

### 阶段 1：Core 可观察性补充

1. 给 `HumanRequestEnvelope` 增加 `agentId`，更新 broker、tests 与现有 CLI consumer types。（已完成）
2. 增加 `agent_status_changed` event。（已完成）
3. 将所有 status mutation 收敛到一个会去重、更新 record、按顺序 emit 的 transition path。（已完成）
4. 覆盖 create、run、idle、unavailable、dispose 与 failure tests。（已完成）
5. 锁定 append-only `extension_output`；output 发送给 listeners/clients，但不进入 observer 或 session。（已完成）

完成标准：headless test consumer 不解析 raw harness event，也能准确追踪所有 agent status 和 human request 来源。

### 阶段 1A：Extension Status presentation（已完成）

1. 增加 `setStatus()` / `clearStatus()` scoped actions 与作者公开类型。
2. 增加 `(agentId, extensionId, key)` registry、`listExtensionStatuses(agentId)` 与 `extension_status_changed`。
3. 锁定 mutation-first、missing clear no-op 与 observer no-feedback。
4. 成功 reload / dispose 清空并发 clear event；skipped/failed reload 保留状态。
5. 增加 UTF-8 payload bounds、progress validation、listener/client failure isolation 与 CLI 纯文本降级。

完成标准：headless、CLI 与后续 TUI consumer 都能通过同一 event/query 契约获得实时 status；status 不进入 session、model context 或 timeline。

### 阶段 1B：Extension Persistent Message（core 已完成）

1. 增加 `publishMessage()` scoped action 与作者公开类型，返回 `{ entryId }`。
2. 增加 core-owned `core:extension_message` custom entry：先写 session 拿到 entryId，再发布携带同一 entryId 的 `extension_message_published`。
3. 锁定 kind/title/content validation、UTF-8 payload bounds 与 observer no-feedback。
4. CLI 纯文本降级：attribution header 加有界截断内容；markdown/code 按 plain text 输出。
5. TUI 侧 `PersistentMessageItem` 与 hydrator 的 entryId 去重随阶段 2 落地。

完成标准：action 返回值、canonical event 与持久 entry 携带同一 entryId；message 写 session 但永不进入 model context。

### 阶段 1C：Extension Diagnostic 作者入口（core 已完成）

1. 增加 `reportDiagnostic()` scoped action 与作者公开 draft/disposition 类型。
2. 校验 severity、disposition、local code、message 与 JSON details bounds。
3. Core 注入 fresh id、extension/agent/profile attribution 与规范化 code。
4. 复用标准 diagnostic event 和 agent extension diagnostics，不建立平行 presentation event。
5. 锁定每次上报是独立事实、observer no-feedback 与 invalid draft 的 `extension.action_failed` 路径。

完成标准：TUI/CLI/RPC 继续只消费标准 diagnostic；extension 无法伪造 attribution 或 blocked disposition。

### 阶段 1D：Extension Notification（core 已完成）

1. 增加 `notify(text)` scoped action 与 `extension_notification` canonical event。
2. Core 注入 `presentationId` 与 agent/extension attribution。
3. 锁定 info-only、fire-once、ephemeral、observer no-feedback，以及无 severity/code/dedupe/clear/attention 的边界。
4. Text 必须非空白且不超过 4 KiB（UTF-8 字节）；listener/client failure 继续沿用隔离语义。
5. CLI 降级为 `[extension:<id>] notice: <text>`，折叠为空格并有界截断。

完成标准：TUI 可以把 notify 投影为 transient notice，不借用 timeline output 或 diagnostic 语义。

### 阶段 2：Projection 与 Hydration

1. 定义 TUI-only state 与 timeline item。
2. 实现 deterministic event projector。
3. 实现 current-branch session hydrator。
4. 实现 hydration buffer/replay 和 diagnostic dedupe。

完成标准：不启动真实 terminal，即可用 fixtures 重建多个 agent 的 live/resumed view state。

### 阶段 3：最小单 agent TUI

1. 创建 pi-tui root、theme、editor、chat、status 和 footer。
2. 连接默认 agent startup、input 与 assistant streaming。
3. 渲染 tool lifecycle、thinking status 和 diagnostics。
4. 实现 graceful shutdown。

完成标准：单 agent 场景替代当前 line CLI 的主要人工 smoke test，但尚不切换默认 binary。

### 阶段 4：Commands 与 Human Request

1. 将交互层 `CommandEngine.list()` 适配到 autocomplete。
2. 实现 `needs-argument` completion menu 与 inline command provider。
3. 实现 human request FIFO overlay。
4. 处理本地 command result、`extension_output`、blocked/transformed input 和运行状态规则。

完成标准：built-in commands 由共享交互层执行，core 不含 command 语义；TUI submit 只按 `EngineOutcome` 分支，不包含命令名 switch statement。

### 阶段 5：多 Agent 导航

1. 实现 responsive agent strip。
2. 实现 agent selector 与 app keybindings。
3. 实现 background unread/attention。
4. 处理 new/fork/resume 自动切换和 hydration。

完成标准：验收场景中两个 agent 可以并行运行、切换和处理 human request，不丢 event。

### 阶段 6：入口与稳定化

1. 增加 workspace TUI script。
2. 在不同 terminal width、CJK、长 Markdown 和大 tool output 下验证。
3. 运行 package tests 与 root `npm run check`。
4. 人工验收后再决定 package binary 默认入口以及 line CLI 的保留方式。

完成标准：没有未处理 rejection、terminal raw-mode 泄漏或 shutdown hang。

## 16. 测试设计

### 16.1 EventProjector 单元测试

- user/assistant message start-update-end。
- 多个 text/thinking block 的 streaming 合并。
- tool start-update-end 与 toolResult 去重。
- 交互层 command result 不由 projector 事件创建。
- `extension_output` 逐 event 追加、以 `presentationId` 为稳定 view key、不会回灌 observer。
- `extension_notification` 以 `presentationId` 进入 global notice，不创建 timeline item/unread/attention，且保留 agent/extension attribution。
- input transformed/blocked。
- live inline expansion / input transform 使用 pending original text，resume hydration 后显示一致。
- per-agent 与 global diagnostics。
- background unread 与 attention priority。
- background `extension_output` 只更新所属 agent timeline/unread，不串入 active agent、不抢 focus。
- `extension_status_changed` replace/clear 同一 key，不创建 timeline/unread/attention；active agent status slot 与 neutral chips 更新。
- 初次接入和 hydration 后使用 `listExtensionStatuses()` 补齐快照，并正确处理 snapshot/live event 竞争。
- hydration 重建的 `PersistentMessageItem` 与 buffered `extension_message_published` 以 entryId 去重，不产生重复条目。
- extension-reported diagnostic 使用 fresh id 展示为独立事实，不按相同 code 合并，也不回灌 observer。
- resolved human request 按 requestId 生成隐私安全 trace；敏感或 free-input response 只显示 `Answered`。
- status transition。
- status/diagnostic/human request 先于 spawn/resume success event 时懒建 provisional projection，后续正确补全。
- spawn/resume failure 只留下 unavailable projection 时仍可见且不可输入。
- event 到达 hydration pending agent 时的 buffer/replay。

### 16.2 SessionHydrator 单元测试

- fresh empty session。
- user/assistant branch history。
- tool call/result pairing。
- compaction 与 branch summary markers。
- model/thinking/tools changes。
- input transform original text。
- `core:extension_message` 重建为 `PersistentMessageItem`。
- hydration 与 buffered `extension_message_published` 按 entryId 去重。
- unknown custom entry。
- malformed/unsupported entry 的 degraded notice。
- resume/hydration 不恢复 ephemeral command result、`extension_output` 或 `extension_notification`；hydration pending 期间收到的 live output 会 buffer/replay，notification 可立即进入 global notice。

### 16.3 Application 测试

- startup 在 spawn 前订阅。
- initial spawn failure 保留 unavailable 诊断视图并禁用 editor；后台 spawn/resume failure 不抢占 active agent。
- submit 捕获原 active agent id，切换后 completion 不串台。
- running agent 普通输入不调用 prompt。
- running agent 的已知 line command 仍进入 `CommandEngine`，普通/inline prompt 不调用 core。
- running agent 的未知 `/typo` 按普通输入保留，并只显示一次 notice。
- command availability 按当前 agent status 计算。
- `needs-argument` 打开 inline completion menu，选择后走正常 submit，
  cancel 恢复原命令，completion 异常产生可见 notice。
- new/fork/resume result 自动切换。
- unexpected error 不重复 diagnostic。
- shutdown 幂等并恢复 terminal。

### 16.4 Human request 测试

- background agent envelope identity。
- FIFO concurrency。
- confirm/select/input/custom。
- signal abort、timeout、agent dispose 与 application shutdown。
- overlay 关闭后 focus 恢复。
- resolved trace 的 confirm/select 安全摘要与 input/custom 隐私隐藏。

### 16.5 Component 与 terminal 测试

优先复用 pi-tui 的 virtual terminal/test patterns：

- 40、80、120 column render。
- CJK label 与 description width。
- agent strip `+N` 聚合。
- selector up/down/Enter/Esc。
- completion menu 位于 editor 上方并推动 transcript，不使用 overlay；输入
  filter、backspace、confirm 与 cancel 均恢复正确 focus。
- autocomplete disabled/enabled commands。
- merged keybindings 在 component 创建前通过 `setKeybindings()` 安装。
- streaming update 不产生全量重复 component。
- 每一行 visible width 不超过 component render width。

### 16.6 Core contract 测试

- envelope 与 pending/resolved/cancelled/timeout event 使用相同 agentId。
- 首次 `creating` status event 的 `previousStatus` 为空，并可先于 spawn/resume success event。
- 每个实际 status transition 只发一个 event。
- status event 在 record mutation 之后可被 listener 查询。
- unavailable/disposed 可观察。
- `extension_output` 发送给 event listeners/clients，但显式不进入 extension observers。Core output action 本身 reject 时走 `extension.action_failed`；单个 registered client 的 `receive` failure 仍按 orchestrator 既有语义产生 `orchestrator.client_failed`，不把整个 output action判为失败。
- `notify()` 产生带 presentationId/agentId/extensionId 的 `extension_notification`；event 不进 observer/session/model context。
- notification text 非空白且不超过 4 KiB；无效 payload 不发 event并走 `extension.action_failed`。Event 无 severity/code/dedupe/clear/attention 字段。
- `setStatus` 先改 registry 再 emit，`clearStatus` 先删除再 emit；missing clear 不发 event，query 返回防御性快照。
- status key/text/progress validation 与 UTF-8 size limits。
- 成功 reload/dispose 清空 status，skipped/failed reload 保留；其他操作不隐式清空。
- `publishMessage` 先写 `core:extension_message` entry 再 emit；action 返回值、event 与持久 entry 共享同一 entryId。
- message kind/title/content validation 与 UTF-8 size limits；失败不落 entry、不发 event。
- `reportDiagnostic` 注入 fresh id、规范化 code 与 agent/profile/extension attribution；重复 code 的多次调用保持为独立事实。
- diagnostic severity/disposition/code/message/details validation；无效 draft 不发布作者 diagnostic，并走 `extension.action_failed`。
- extension-reported diagnostic 发送给 listeners/clients、写入 agent extension diagnostics，但不进入 extension observers。
- client/event listener failure 仍产生结构化 diagnostic，且不阻断其他 listener/client。

## 17. 验收场景

必须通过以下人工 smoke flow：

```text
启动 WIDI TUI
  -> 看到 startup facts 与默认 agent
  -> 输入 prompt
  -> 看到 user message、assistant streaming 与 tool execution
  -> 使用 /new 创建第二个 agent
  -> 第二个 agent 开始运行
  -> 切回第一个 agent并继续查看/输入
  -> 底部显示第二个 agent 完成或需要 human request
  -> 打开 agent selector
  -> 上下移动并 Enter 切换
  -> 提交 /model，inline completion menu 选择后切换模型
  -> 提交 /fork，确认可选择当前 position 或历史 user message
  -> 看到第二个 agent 的完整 current-branch 对话与 diagnostics
  -> 执行 built-in command，看到本地 command result
  -> extension 更新 status，看到 working-status 原位更新并在 clear 后消失
  -> extension 发布 notify，看到带 agent/extension attribution 的短暂 neutral notice
  -> extension 发布 persistent summary，resume 后只恢复一次
  -> extension 上报 diagnostic，看到对应 severity 与 agent attention
  -> 回答其 human request
  -> 正常退出
```

验收期间必须确认：

- 后台 agent 未因切换而停止。
- event 没有进入错误 agent timeline。
- human request 标题显示正确 agent。
- command autocomplete 随 agent/status 更新。
- terminal 退出后 echo、cursor 和 raw mode 恢复。
- session resume 后历史与后续 live event 连续且不重复。
- extension output 是 append-only plain text；切换 agent 后仍在当前 projection，重启/resume 后不恢复。
- extension notification 只出现在 transient notice 区，不进入 timeline/unread/attention，重启/resume 后不恢复。
- extension status 不进入 timeline；切换 agent 后由 projection/query 恢复当前值，成功 reload/dispose 后清空。
- persistent extension message resume 后按 entryId 去重，不与 buffered live event 重复。
- human request 回答留痕不泄露 input、custom 或 free-input 内容。

## 18. 演进触发条件

只有出现以下真实需求时才扩展边界：

- RPC/远程 consumer：提炼 transport-neutral client contract。
- Agent collaboration：在 core collaboration facade 和 canonical events 上增加 relation/coordination projection。
- Extension UI：定义 client-side extension host，不让 extension 直接持有 TUI application。
- Extension output 更新/合并：只有真实需求要求覆盖同一进度项时，才为 canonical event 增加 `outputId` 与 delta/replace/completed 协议。
- 多 runtime workspace：新增更高层 application owner，不修改单 runtime orchestrator 语义。
- Running input 默认 steer：由用户行为与 queue UX 验证后成为 product policy。
- settings 或更复杂的专用 UI：复用现有 core query/action，不建立平行状态源。

第一版实现应持续遵守一个约束：core 提供事实与操作，TUI consumer 保存展示投影并决定交互；任何一侧都不复制另一侧的权威状态机。
