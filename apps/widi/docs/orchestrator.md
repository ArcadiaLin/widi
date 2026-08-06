# Orchestrator 设计

代码位置：`apps/widi/src/core/agent-orchestrator.ts`、`core/message.ts`、`core/extension/` 及 `core/` 下的协作者模块。

本文说明 orchestrator 的设计：组织判据、多 agent 生命周期管理、消息中枢、extension 支持、客户端与诊断。

## 1. 组织判据

**关于单个 agent 的事实，从那个 agent 的 `AgentHarness` 读；orchestrator 只决定需要多于一个 agent 才能回答的事。** 这些事是：AgentId 的分配、spawn 树的所有权、跨 agent 的消息路由、谁在等谁进入空闲、以及这些事实的持久化。

harness 是单 agent 的执行内核——模型轮次、会话树、资源、工具、流式生命周期。orchestrator 不重新实现其中任何一件，也不在 harness 之外为单 agent 事实维护第二份拷贝。

这条判据同时决定了一个协作者什么时候配拥有自己的类：**只有当它持有的状态，其不变量可以在不查 `_live`（活跃 agent 表）的情况下维护时**。符合的有四个：`BackgroundJobRuntime`（后台任务，见 `background.md`）、`OrchestratorEventBus`（事件广播）、`AgentContextMonitor`（上下文用量）、`AuthRuntimeController`（认证）。其余凡核心判断需要跨 `_live`、harness 相位、spawn 树、后台任务做 join 的，都留在 orchestrator——再拆出去只是把 join 换成回调，不会变简单。

## 2. 多 Agent 生命周期

### LiveAgent

运行时实体 `LiveAgent`（`agent-types.ts`）聚合：`agentId`、`generation`（单调递增，用于句柄失效判定）、`profile` 与 `resolvedProfile`、`sessionRef`（持久化会话地址，ephemeral agent 无）、`harness: WidiAgentHarness`、`backgroundAttachment: OwnerAttachment`（后台任务附着）、`extensionRunner` 与 `extensionBindings`、`toolPolicy`、`settings`，以及释放钩子 `releaseHarnessBindings`。对外投影为 `AgentSnapshot`（附加 model、thinkingLevel、tools、activity、extensions、diagnostics、contextUsage）；已消亡的 agent 没有 snapshot。`AgentId` 的查找结果是四态 `AgentLookup`：`live | gone | creating | unknown`——`creating` 与 `gone` 分开，是为了让"等它建完"和"它没了"走不同的路。

### 生命周期操作

- **spawn**：`spawnAgent(options)` 是唯一创建入口，`SpawnAgentOrigin` 三种——`new`（分配 id，在父会话目录下建子会话目录；目录嵌套是 agent 树的唯一持久记录）、`resume`（从持久化会话恢复，复用 session header 中绑定的 AgentId）、`fork`（复制源会话目录后按 resume 处理，要求源 profile 允许持久化）。同一会话的并发 resume 通过创建预约复用。resume 完成后做两件调和：后台任务分支 reconcile（见 `background.md` §6），以及把"旧 spawn 树已关闭"作为 runtime notice 写入恢复上下文。
- **dispose**：`disposeAgent(agentId, { intent, scope })`。同步摘除（进入 tombstone 表）后异步清理：取消 human request、取消该 agent 的投递队列、detach 后台任务（以 `cause: "dispose"` reconcile 分支）、释放 harness 与 extension 绑定、`harness.shutdown()` 有 10 秒上限。`intent` 区分 `"removed"`（写持久化标记）与 `"runtime_shutdown"`（不写）；`scope` 区分单 agent 与整棵子树。
- **navigate**：`navigateAgentTree(agentId, targetId, ...)` 包装 `harness.navigateTree`（会话树回退/切换分支）；leaf 变化后触发后台任务分支 reconcile 与上下文监控失效。`compactAgent` 与 navigate 都经维护操作通道：相位门 + 活动边事件 + idle 结算。
- **运行控制**：`abortAgent`、`steerQueuedFollowUps`（把排队的 follow-up 提升为 steer）。
- **查询**：`inspectAgent` / `listAgents` / `getAgentActivity` / `getAgentSessionTree` 等快照读；`isAgentIdle` / `waitForAgentIdle` / `agentHasPendingMessages`。

### Idle 判定

`isAgentIdle` 是四源 join：harness 相位为 idle、harness 的两个内部队列均为空、消息投递队列无 pending、没有在飞的 prompt run。`waitForAgentIdle` 在满足时结算并发出 `agent_idle` 事件（原因分 `ready | settled | aborted | maintenance`）；agent 在等待期间消失时 reject 而非永远挂起。

## 3. 消息中枢

`message.ts` 是依赖图的叶子，任何模块都可以依赖它。核心规则：**所有会进入某个 agent 模型上下文的文本，都经过 orchestrator 的同一个投递方法。** 运行时没有私有投递通道。

### 两条正交的轴

- **source（身份轴）**：`MessageSource = { kind: string; label?; details? }`，"这段话是谁写的"。只决定渲染与追溯，不参与任何行为判断，持有者可以随意填写。core 内建 `human` / `agent` / `background_job` / `runtime`。这样安排的理由：消息内容由持有者的 `render` 闭包产出，持有者本来就能渲染出与用户输入逐字相同的文本；既然类型拦不住这件事，就不该为它付约束的代价。
- **投递策略（行为轴）**：`MessageDeliveryPolicy = { humanInterrupt, blockPolicy: "enforce" | "ignore", retryOnFailure, mergeKey? }`。这是真正改变运行时行为的东西，在 orchestrator 发放 sink 时绑定，请求不可覆盖。

模型看到的始终是纯 user 文本；类型标记是给存储和 UI 的，不是给模型的。

### API 形状

- `MessageRequest = { targetAgentId, body, source?, render?, images?, mode }`，`mode: "next_turn" | "interrupt" | "precede"`（next_turn 不打断在飞 turn；interrupt 打断；precede 不唤醒目标，落在分支上等下次输入一起读）。
- `MessageSinkBinding = { source, policy, render?, plainEntry? }`——sink 代持者固定的一切。`plainEntry` 仅 shell 输入为真（落盘为无类型的普通 user 条目，保证既有会话可读回不变）。
- `messageSinkFor(binding): MessageSink` 是 orchestrator 暴露的唯一工厂，返回 `{ send, prompt }`。`send` 不要求目标空闲；`prompt` 要求空闲（忙目标拒绝而非排队）并等待 assistant message 返回。
- `messageBindingFor(producer)` 为五种内置生产者给出预置 binding：human（可打断、enforce、plainEntry）、agent（enforce，渲染加 `[Message from <id>]` 前缀）、background_job（ignore 阻塞、失败重试、按 mergeKey 合并）、runtime notice（ignore）、extension（enforce，加前缀）。

### 投递决策与队列

`decideMessageDelivery({ phase, mode, requiresIdle })` 产出 `deliver | defer | reject`，投递方法为 `prompt | follow_up | steer | append`；compaction 与 branch_summary 相位一律 defer。`MessageDeliveryQueue` 对每目标维持 FIFO 并以接受序串行化；`wake(agentId)` 是相位变化后恢复 defer 的唯一通道；`mergeKey` 相同的相邻消息合并（background 结果靠它把多个任务的回报并成一条）；`cancel(agentId, reason)` 取消全部待发。可重试错误（harness 的 `busy | invalid_state`）与终态错误（`shutdown`）分开判定。

### 拦截管线

extension 的 `input` 拦截器作用于语义 body（`transformMessage` 返回 pass / transform / block），`render` 在拦截**之后**才取一次（优先级 `draft.render ?? binding.render ?? 恒等`）——extension 永远看不到渲染后的文本，阻塞策略为 `ignore` 时 block 降级为放行原文。

## 4. Extension 支持

### 激活模型

`ExtensionDefinition = { apiVersion, divisions?, activate }`，`activate(api: ExtensionActivationApi)` 时扩展拿到自己的能力面（`extensionId`、`agentId`、`profileId` 由 core 注入）：

- `registerTool(definition)` / `patchTool(targetToolName, patch)`：工具贡献，经 `ExtensionRunner.contributeToolsTo(registry)` 安装进工具注册表；patch 可改 `description | parameters | strict | execute | aroundExecute`。
- `registerProvider(providerName, config)`：注册模型 provider，first-registration-wins，不可覆盖内建与他人 provider，随 runner 生命周期注册与撤销。
- `appendSystemPrompt(text)`：增量追加系统提示（整体改写用 `before_agent_start` 拦截器）。
- `observe(eventName, handler)` / `intercept(eventName, handler)` / `onExtensionEvent(name, handler)` / `onDispose(handler)`。
- `division(id, register)` / `isDivisionEnabled(id)`：division 机制按声明分区，被禁用分区的 register 根本不被调用；最近规则胜出、disable 胜 enable、祖先禁用是硬门、未声明 id fail-open。

### 拦截器与观察事件

拦截器名单（`ExtensionInterceptorName`）：`before_agent_start | before_provider_request | context | input | tool_call | tool_result`。除 `input` 外复用 pi harness 的事件与结果类型；`input` 是 WIDI 自有，结果为放行 / 替换 / 阻断三态，阻断短路整条管线。

观察事件名单（`ExtensionObservedEvent`）：`agent_spawned | agent_resumed | agent_idle | agent_session_forked | agent_session_info_changed | agent_harness_event | agent_background_job_changed | agent_background_job_progress | agent_background_job_report_updated | agent_context_usage_changed | human_request_pending | human_request_resolved | human_request_timeout | human_request_cancelled | input_blocked | input_transformed | diagnostic | runtime_shutdown_requested`。诊断与 extension 自产事件不回流 observer（orchestrator 用 AsyncLocalStorage 标记 extension 引起的写入，防止扩展收到自己触发的事件而互答死循环；runtime 级 `emitExtensionEvent` 另有派发深度上限 8）。

### Presentation 能力

extension 面向客户端的呈现全部经 `presentation.ts` 的校验层（core 不渲染，只约束形状与上限）：

- `publishMessage(message)`：发布结构化消息（kind：`text | markdown | code | table | fields | diff | banner`），持久化为会话条目，校验后深拷贝深冻结。
- `setStatus(key, status)` / `clearStatus(key)`：状态区（region：`panel | footer | agent-strip`），带 progress、icon（单字素）、tone（`neutral | info | success | warning | danger`，语义强调而非颜色——core 没有调色板）。
- `notify(text)` / `emitOutput(text)`：瞬时通知与纯文本输出，不进模型上下文。
- `reportDiagnostic(draft)`：诊断，code 被命名空间化为 `extension.<extensionId>.<code>`。

### 会话写入通道

extension 可以把状态交给会话历史管理：`ExtensionSessionContext.appendEntry(type, data)` 经 harness 写入分支，customType 被命名空间化为 `extension:<extensionId>:<type>`——一个扩展读不到另一个扩展的条目；`findEntries(type?)` 读回，resume 后仍在。条目随会话树获得回退、分叉、可追溯三条性质。另有只读会话面：本 agent 的 `getSnapshot / getTree / getLeafId`，跨会话的 `listSessions / readSession`（要求 project trust）。

### 加载与重载

`ExtensionLoader` 负责发现（`ExtensionRoot`：`agent_dir | cwd | settings`）、注册（`registerExtension(extensionId, module)`）、加载与重载。`reloadExtensions({ agentIds? })` 按 agent 报告 `reloaded | skipped | failed`（跳过原因：`creating | running | gone`）；重载时整代注销旧 harness 拦截器再装新。

## 5. 客户端、事件与诊断

**OrchestratorClient**（`client.ts`）是 TUI 实现的被动接收端，经 `registerClient` 注册：

```ts
interface OrchestratorClient<TEvent = unknown> {
	id: string;
	receive?: (event: TEvent) => void | Promise<void>;
	requestHuman?: (request: HumanRequestEnvelope, signal?: AbortSignal) => Promise<HumanResponse>;
}
```

client 收全部 `OrchestratorEvent`；human request 路由给第一个带 `requestHuman` 的 client（事件流：`human_request_pending | resolved | timeout | cancelled`；无 handler 时抛 `orchestrator.human_request_unhandled`）。主动操作面就是 orchestrator 的公开方法本身。

**OrchestratorEventBus** 只管 listeners 与 clients，不知道 extension observer——那是 orchestrator 在发布外层的组合。listener/client 失败降级为诊断（`orchestrator.listener_failed` / `orchestrator.client_failed`，交叉投递避免二次失败循环）。

**诊断**模型刻意小：`CoreDiagnostic = { severity: "warning" | "error", code, message, agentId?, extensionId? }`。severity 与策略决定执行是继续、降级、标记 agent 不可用、还是失败。凡能降级的不抛异常，凡降级必留诊断。per-agent 诊断历史随 `AgentSnapshot.diagnostics` 读出。

## 6. 公开方法总表

按用途分组（准确签名以源码为准）：

- **生命周期**：`spawnAgent`、`disposeAgent`、`disposeAll`、`navigateAgentTree`、`compactAgent`、`abortAgent`、`steerQueuedFollowUps`。
- **消息**：`messageSinkFor`、`sendMessage`、`promptAgent`、`isAgentIdle`、`waitForAgentIdle`、`agentHasPendingMessages`。
- **查询**：`inspectAgent`、`listAgents`、`getAgentActivity`、`getAgentSession`、`getAgentSessionTree`、`listAgentSessions`、`getAgentSessionName`、`setAgentSessionName`（唯一会话名写路径）。
- **工具/模型/资源**：`getAgentTools`、`setAgentTools`、`setAgentActiveTools`、`getAgentSystemPrompt`、`getAgentModel`、`setAgentModel`、`setAgentModelByReference`、`listAvailableModelCandidates`、`listAgentThinkingLevelCandidates`、`get/setAgentThinkingLevel`、`listAgentPromptTemplateCandidates`、`listAgentSkillCandidates`。
- **认证**：`listAuthProviderCandidates`、`listAuthCredentialCandidates`、`loginAuthProvider`、`logoutAuthProvider`。
- **Extension**：`registerExtension`、`listExtensionStatuses`、`reloadExtensions`。
- **后台任务**：`listAgentBackgroundJobs`、`readAgentBackgroundJobOutput`、`abortAgentBackgroundJob`、`agentBackgroundJobHistory`。
- **Human request**：`requestHuman`、`cancelHumanRequest`。
- **客户端/事件**：`registerClient`、`subscribe`、`subscribeAgent`、`emitStartupDiagnostics`、`requestShutdown`。
- **默认值**：`get/setDefaultModel`、`get/setDefaultThinkingLevel`、`get/setDefaultProfileId`、`get/setEnabledProfileIds`。

## 延伸阅读

领域词汇表在仓库根的 `CONTEXT.md`（Core / Agent / Orchestrator / Diagnostic 等术语的定义与反义词）。实现期设计与排期文档在 `notes/develop/`（scratch）：`agent-harness-ownership-plan.md`（orchestrator 与 harness 的所有权划分及例外清单）、`ZH/orchestrator-message.md`（消息管线全文）、`ZH/orchestrator-refactor.md`、`ZH/orchestrator-wiring-plan.md`。
