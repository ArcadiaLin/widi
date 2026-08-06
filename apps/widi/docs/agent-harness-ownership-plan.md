# AgentOrchestrator 状态所有权重构

状态：计划中
日期：2026-07-30

## 结论

这次重构删除的是**状态镜像**，不是对外边界。

判据只有一条，本文所有决定都从它推出来：

> **单个 agent 的事实一律从 `AgentHarness` 取；orchestrator 只负责 multi-agent 才
> 需要的判断。**

"multi-agent 才需要的判断"是有边界的一小类：AgentId 的分配与不复用、spawn tree 的
归属与遍历、跨 agent 的消息路由与来源合成、谁在等谁 idle、以及这些东西的持久化。
除此之外，任何一个"这个 agent 现在怎么样"的问题都不该在 orchestrator 里有答案，
它只该有一个转发。

这条判据的实用价值在于它能**证伪**：只要某个字段回答的是单 agent 的问题，而
harness 也能回答，那它就是镜像，必须删。下面"必须留在我们这边的例外"逐条给出反
证——那些是 harness 确实答不了的，且每一条都有记录在案的理由。

`AgentHarness` 已经封装了 `run_agent_loop`，并拥有当前 model、thinking level、
installed/active tools、agent-loop phase、内部消息队列、prompt、steer、
follow-up、abort 和 wait 等执行语义。Orchestrator 不复制这些状态，也不为了代理它们
而维护一个平行的 agent 状态对象——`AgentRecord` 因此整体消失。

**对外边界本轮不动**：TUI、RPC、tools、extensions 继续直接持有 `AgentOrchestrator`，
`AgentHost` / `ToolAgentHost` / `ExtensionCoreActions` 三个现有 facade 原样保留。
统一对外面（`createOrchestratorHost`）与随之而来的能力收窄留到重构之后，见"待办 3"。

需要注意的是：**调用者身份绑定不属于被推迟的那部分**。agent tool 的 `agentId` 必须
来自 `_createToolAgentHost(agentId)` 的闭包而不是模型参数，否则模型可以伪造消息来源
——这是正确性问题，今天的代码已经做对了，本次重构必须原样保住。被推迟的只是能力面
收窄（extension 贡献的 tool 目前仍能通过 `ToolExecutionContext` 摸到
`executionEnv` / `sessionManager`）。

## 决议记录

| 议题 | 决议 |
| --- | --- |
| 判据 | 单 agent 的事实一律从 `AgentHarness` 取，orchestrator 只做 multi-agent 才需要的判断；例外必须逐条写理由 |
| 对外边界 | 本轮不做。orchestrator 原样对外，现有 facade 保留；`createOrchestratorHost` 见"待办 3" |
| runtime 拆分 | 只有"拥有一份靠自己就能维持的不变量、且不需要查 `_live`"的才独立成类：`BackgroundJobRuntime` / `OrchestratorEventBus` / `AgentContextMonitor` / `AuthRuntimeController`。**不建** `AgentMessageRuntime`、`AgentExtensionRuntimeSupport`、`AgentDiagnosticLedger` |
| Agent registry | `AgentRecord` 整体删除，构建事实并入 `LiveAgent`；只留 `_tombstones` 与 `_spawnParent` 两个索引 |
| `waitForIdle` / `isIdle` | harness phase 为 idle **且** harness 两个队列与 core 投递队列都空 |
| `LiveAgent` 形状 | `generation` + 构建事实 + `harness` + `settings` + `extensionRunner` + `extensionBindings` + `toolPolicy` |
| Tool policy 归属 | 放 `LiveAgent.toolPolicy`；`ToolRegistry` 保持无 per-agent 状态 |
| Model | 不再单独记录 model；`/new` 与 fork 一律取 default model，删除 `inheritModelFromAgentId` |
| Activity status | 保留 `agent_status_changed`，但只作为事件存在，事实来源是 harness phase |
| `AgentIdleReason` | 保留 `ready` / `settled` / `aborted` / `maintenance` 四值不变 |
| spawn 入口 | 只有 `spawnAgent`：`origin`（new/resume/fork）管上下文，`parent` 管树归属；不再有 `spawnChildAgent` 这类具名方法 |
| per-agent settings | `LiveAgent.settings` 只留 harness 答不了的四项；steering/followUp 模式改读 harness |
| spawn tree 持久化 | 写进 root 的 session 目录（`agents/tree.jsonl`）+ child 目录的反向指针，不动 session metadata |
| 树恢复 | eager 恢复整棵树；background 工作不恢复 |
| harness phase | 已在 fork 中导出 `getPhase()` / `getQueuedMessageCounts()`，见"两层门控" |

## 一张表，两个索引

`AgentRecord` 整体消失。它原本是"目录项 + 生命周期载体"，而两半都已经搬走：运行态
那半归 harness phase，跨进程那半归 session 目录里的 spawn tree。剩下的构建事实只在
agent 活着时有意义，直接并进 `LiveAgent`。

```ts
interface LiveAgent {
	readonly agentId: AgentId;
	/** 同一 AgentId 的第 N 代；跨 runtime 的 stale 判定只认它。 */
	readonly generation: number;

	// 构建事实（原 AgentRecord）
	readonly profile: AgentProfileRecordReference;
	readonly resolvedProfile: AgentProfile;
	readonly sessionMetadata?: AgentSessionMetadata;
	readonly resources: AgentResourcesSnapshot;
	readonly systemPrompt: AgentSystemPromptFacts;

	// 运行时协作者
	readonly harness: WidiAgentHarness;
	/** 构建期快照，见"per-agent settings"。 */
	readonly settings: AgentSettings;
	extensionRunner: ExtensionRunner;
	extensionBindings: ExtensionRunnerBindings;
	/** 这一代的声明式工具意图，reload 时随 runner 一起重解析。 */
	toolPolicy: AgentToolPolicy;
	readonly releaseHarnessBindings: () => Promise<void>;
}
```

orchestrator 上只剩三个结构，各管一件事：

```ts
private _live = new Map<AgentId, LiveAgent>();     // 唯一可路由集合
private _tombstones = new Set<AgentId>();          // 曾经存在过、已经消失的 id
private _spawnParent = new Map<AgentId, AgentId>();// 树边，跨 dispose 存活
```

查表结果就是完整的门控答案：

| 查询 | 含义 |
| --- | --- |
| `_live` 命中 | 可路由；harness 必然存在 |
| `_live` 未命中，`_tombstones` 命中 | gone（曾经存在，已消失） |
| 两个都未命中，`_agentCreations` 命中 | creating（构建中，reservation 持有） |
| 三个都未命中 | unknown AgentId |

`creating` / `unavailable` / `running` / `idle` 不落在任何一张表里。构建中的请求只
存在于 creation reservation 与局部 build，构建失败什么都不发布，也**不写 tombstone**
——tombstone 只在真正 dispose 时写。

### 为什么 tombstone 不能省

它不是为了"能查到历史 agent"，而是为了让一个已死的 AgentId **永远不被复用**。一条
还在飞的旧消息如果打在一个被重新分配出去的同名 id 上，会投递到另一个 agent；tombstone
让它失败。这也是 `spawnAgent` 派生新 id 时必须避开的集合。

一个 `Set<AgentId>` 就够：dispose 的意图、时间、原因都由 `agent_disposed` 事件与
`agents/tree.jsonl` 的 `removed` 记录承载，没有第二个读者。顺带彻底消掉 tombstone
内存泄漏这一类问题——`6c67742` 修的是 tombstone 上残留 skills 全文与 project context，
现在 tombstone 里除了字符串 id 什么都没有，这类 bug 不再可能出现。

### 为什么树边要单独一张表

`spawnedBy` 是唯一一个必须比 `LiveAgent` 活得久的字段。今天 `agent-orchestrator.ts:1952`
的注释已经写明理由：单个 dispose 不会带走子树，一个中间节点被 dispose 之后，它的
存活后代仍要能被祖先的 subtree dispose 扫到（`_collectAgentSubtreePostOrder:2492`
就是遍历所有 record 建 children 索引）。

与其把这条边塞回一个复活的 record，不如让它自己成为一张表。`_spawnParent` 同时也是
`agents/tree.jsonl` 在内存里的镜像，职责因此是自洽的：orchestrator 拥有 AgentId 与
spawn tree，树边归它，不归任何一个 agent 的状态对象。

**它需要一条剪枝规则**，否则就是我们刚消掉的那类慢泄漏换了个位置。规则：dispose 一
个节点时，如果它没有存活后代，删掉它的边；然后沿祖先链向上，逐个删掉同样已经没有
存活后代的 tombstone 边。留下来的只有"死了但还挡着路"的中间节点，数量以同时存活的
分叉数为上界，不随会话时长增长。

`_tombstones` 本身不剪枝，这是有意的：它必须记住每一个曾经用过的 id，否则 id 复用
就会让在飞的旧消息投递到别的 agent。代价是一个只增的短字符串集合——AgentId 由
profile label 加计数派生，长度有界，一次会话里 spawn 上千个 sub-agent 也只是几十
KB。这个交换必须显式写下来，因为它看起来像泄漏，实际上是正确性的价格。

## 尚未归位的 per-agent 状态

除了 `AgentRecord`，orchestrator 上还挂着几张按 AgentId 键的表。它们没在前面的章节
里出现过，但重构必须逐个决定去向，否则就是把一个平行结构换成另一个。

### `_agentToolSets`：整表删除

`AgentToolSet`（`agent-orchestrator.ts:344`）有六个字段，没有一个需要它自己的表：

| 字段 | 去向 |
| --- | --- |
| `tools` / `toolNames` / `activeToolNames` | 已经是 harness 的镜像。`harness.getTools()` 返回的就是 `ResolvedAgentHarnessTool[]`，`getActiveTools()` 同理，直接读 |
| `requestedToolNames` / `activeToolSelection` | 就是 `AgentToolPolicy`，归 `LiveAgent.toolPolicy` |
| `profileId` | 已经在 `LiveAgent.profile` 里 |

所以 `_agentToolSets`、`_requireAgentToolSet`、`_setAgentToolSet` 一起删掉。前面只说
了 `toolPolicy` 落在 `LiveAgent` 上，没说 `AgentToolSet` 的另一半是 harness 镜像——
不写清楚的话，重构很可能把整个 `AgentToolSet` 原样搬到 `LiveAgent` 上，等于什么都
没删。

### `_agentStatusRevisions`：删除，用 run reservation 身份代替

它只有一个用途：`_startAgentPrompt` 在几个 await 之后确认"状态没有在我背后变过"
（`:4577` / `:4605` / `:4812`）。`AgentLifecycleStatus` 删掉之后它没有可计数的对象。

替代物已经在同一段代码里：`_agentPromptRuns.get(agentId) === runReservation` 这个
对象身份比较（`:4595` / `:4805`）。它比 revision 计数更准——计数会被任何一次无关的
状态变化推进，而身份只回答"还是我这一次 run 吗"。**不要把 revision 计数换个地方原样
留下**；`LiveAgent.generation` 也不是它的替代品，generation 只在换代时变，不在一次
run 结束时变。

### `_progressSequence`：随 background 一起搬走

`Map<AgentId, Map<jobId, number>>`，是 background job progress 事件的单调序号。它是
background 的发射状态，不是 agent 状态，随 `BackgroundJobRuntime` 走。前面"删除与
保留"里写的"background progress/report/emission tail"就包括它，这里点名以免遗漏。

### `_autoCompactingAgents`：保留，但要改失败处理

phase 看似能取代它（第二次 compact 会被 harness 拒成 `busy`），但不行：自动压缩的
判定跨了一个 await（`_refreshAgentContextUsage`），拒绝会落进 `catch` 变成一条
`compaction.auto_failed` 警告诊断——把一次正常的去重变成用户可见的噪音。两个选择：
保留这个集合，或者让 `_maybeAutoCompactAgent` 显式吞掉 `busy`。**推荐保留集合**：它
表达的是"这一轮已经决定要压缩了"，是调度意图，本来就不是 harness 能回答的问题。

### `resolvedProfile` 变成必填，两处代码随之消失

今天 `AgentRecord.resolvedProfile` 是可选的，但两个正常创建路径（`:2718` / `:2814`）
都必填。唯一的可选来源是失败路径：`createAgentRecordFromProfileReference`
（`:3785`）从 session metadata 里尽力解析出一个 profile 引用，造一条 `unavailable`
记录，让 TUI 还能把这个打不开的会话显示出来。

`unavailable` 删掉之后，这条路径连同 `orchestrator.system_prompt_unavailable`
（`:2285` 的抛出）一起变成死代码，`LiveAgent.resolvedProfile` 可以是必填。

代价要说清楚，因为这是反对删 `unavailable` 的最强论据：**resume 失败的会话会从 agent
列表里彻底消失**，用户只看到一个错误提示，不再有一个可以点开看的坏条目。可以接受的
理由是这条记录本来也做不了任何事（没有 harness），而失败原因在 diagnostic 里更完整。

## 一次查表的门控

所有按 AgentId 发起的操作先查 `_live`。命中即可路由，同一个对象上就有 harness、
profile、settings、runner，不需要第二次跨表 join；未命中按上表分辨 gone / creating /
unknown。

然后读 `harness.getPhase()` 决定操作是否合法，竞态由 `AgentHarnessError` 兜底重试。
这一步**不能只靠抛错**，因为 harness 的错误在两处覆盖不到，必须先读 phase：

- `harness.steer()` / `followUp()` 只在 phase 为 `idle` 时抛 `invalid_state`。
  phase 为 `compaction` / `branch_summary` 时它们会被静默接受、压进没人读的队列，
  直到下一个真 turn 才被读到。
- 投递方式的选择（prompt / steer / follow_up）需要知道当前 phase。对 idle 目标先
  调 `followUp` 会拿到可重试的 `invalid_state`，消息将无限期 defer。

### phase 与队列计数已导出

`getPhase()` / `getQueuedMessageCounts()` 已经加进 `packages/agent`，divergence 记在
`docs/pi-fork.md` 的"The observation getters"。两个纯读方法，不加状态、不发事件、
不会失败。

它成立的前提是 harness 的相位切换全部**同步**发生在操作的第一个 await 之前
（`prompt()` 第二行置 `turn`，`compact()` 置 `compaction`，`navigateTree()` 置
`branch_summary`，各自在 `finally` 复位）。所以读到的 phase 对"刚才那次调用"永远
不是过期答案，只可能被**别的**调用者抢跑——这正是第二层仍需 `AgentHarnessError`
兜底的原因。

一个上游遗留项：`AgentHarnessPhase` 联合里有 `"retry"`，v0.83.0 从不写入它。我们的
switch 仍要处理，因为类型说它可能出现。

具体删掉的判断：

| 现有代码 | 变化 |
| --- | --- |
| `_maintenanceOperations` 整表（字段、dispose 清理、同步预留、`=== reservation` 身份比较） | 删除。它是 phase 的手写副本，连"在第一个 await 前同步预留"这个技巧都在复刻 `compact()` 的第二行 |
| `_runMaintenanceOperation` 的 `record.status !== "idle"` 前置检查 | 删除或改为只为错误消息读一次 phase；并发交给 harness 的 `busy` |
| `_requireAgentOutsideMaintenance` 的四个调用点 | 保留守卫，改读 phase，四处合成一个返回 harness 的 helper，见下 |
| `record.harnessQueuedMessageCount` 镜像及其三个读者 | 删除。`?? 0` 把"没观测过"和"队列为空"编码成同一个值的二义性一并消失 |
| `_resolveDeliveryPhase` 的四个事实来源 | 降为两个：`gone`/`creating` 是 orchestrator 自己的事实，其余读 phase |
| `_agentPromptRuns` 作为相位证据的四处 | 删除。它继续持有 run promise 与 `idleReason`，但不再回答"忙不忙" |
| `_transitionAgentStatus` / `_commitAgentStatus` 的 `maintenance` 参数 | 删除。它穿三层只为装饰一个事件字段 |
| `getAgentMaintenance` / `maintenanceDescription` | 由 phase 映射取代 |

顺带修掉一个真实缺陷：`_runMaintenanceOperation` 读的 `record.status` 落后于
harness。`agent_end` 里 harness 先把 phase 置 `idle` 再 emit `settled`，而我们的 idle
提交要等事件走到 `_updateAgentStatusFromHarnessEvent` 且广播完所有 client。这个窗口
里 harness 已经能接受 compact，我们却报 "cannot start compaction while running"。
用户手动 `/compact` 撞上 settled 就会踩到；自动压缩因为排在同一个 handler 内的状态
提交之后而侥幸躲过。

反方向不必改：`_startAgentPrompt` 先把自己置忙再调 `harness.prompt()`，比 harness
更早变忙，是保守的，那里的前置检查没有同类问题。

### 四个输入入口合成一个 helper

`steerAgent` / `steerQueuedFollowUps` / `followUpAgent` / `abortAgent` 现在各写两行
（取 harness、查维护表）。改成一个返回 harness 的 helper：

```ts
private _requireHarnessOutsideMaintenance(
	agentId: AgentId,
	action: string,
): WidiAgentHarness;
```

它**只拒绝** `compaction` 与 `branch_summary`。这一点我先前说反了，纠正一下：

- `idle` 不在这里拒。harness 的 `steer()` / `followUp()` /
  `promoteFollowUpsToSteer()` 已经对 idle 抛 `invalid_state`，我们再判一次是把同一个
  条件写两遍，不是"合并成一处"。真正的分工是：**harness 覆盖 idle，我们覆盖它覆盖
  不到的两个 maintenance phase**，每个条件只有一个产生者。
- `abort` 在 idle 必须放行。`harness.abort()` 对 idle harness 是一次有意义的队列
  清空（清 steer/followUp 并发 `abort` 事件），不是错误。正因为 helper 只拦
  maintenance，四个入口才能共用同一个它。

phase 到我们词汇的映射就是一个纯函数，`getAgentActivity` 复用同一个：

```ts
function maintenanceKindFromPhase(
	phase: AgentHarnessPhase,
): AgentMaintenanceKind | undefined;   // compaction → "compaction"
                                       // branch_summary → "tree-navigation"
                                       // 其余（含永不写入的 retry）→ undefined
```

### `_runMaintenanceOperation` 必须先起操作、再发事件

这条是删掉维护表的**前置条件**，不是可选优化。今天的顺序是：预留 → `await
_transitionAgentStatus(...)` → `await operation(harness)`。phase 要到最后一步才翻，
所以在预留和翻转之间存在一个窗口：表说 maintenance，phase 说 idle。表还在时无所谓
（守卫读表），表删掉之后，这个窗口里的 steer 会穿过 phase 守卫、落到 harness 的
idle 检查上，得到一个语义正确但措辞误导的 `invalid_state`。

修法是让 harness 操作先启动——`compact()` / `navigateTree()` 在第一行同步翻 phase：

```ts
const running = operation(harness);   // phase 在这里同步变成 compaction
await this._publishMaintenanceStarted(agentId, kind);
return await running;
```

注意中间那个 `await` 抛出时 `running` 会变成 unhandled rejection，必须显式接住再
重抛。这是这次重构里少数几个"顺序本身就是正确性"的地方之一。

它替代不了的四件事，别指望：prompt acceptance（见"prompt acceptance 必须保留"）、
`AgentIdleReason`（phase 回到 `idle` 不解释原因，abort 与 settled 仍靠事件区分）、
`LiveAgent.generation`（phase 是单个 harness 实例的属性，跨代失效判定还得靠它）、
以及投递队列本身（harness 有队列，但只有 turn 期间才有人 drain，maintenance 与
creating 期间的延迟投递是我们的策略）。

Orchestrator 保留这些方法（签名不变，仍在 orchestrator 上）：

- `getAgentModel` / `setAgentModel` / `setAgentModelByReference`；
- `getAgentThinkingLevel` / `setAgentThinkingLevel` / `setAgentThinkingLevelByName`；
- `getAgentTools` / `setAgentTools` / `getAgentActiveTools` / `setAgentActiveTools`；
- `promptAgent` / `steerAgent` / `followUpAgent` / `steerQueuedFollowUps` /
  `abortAgent`；
- `getAgentActivity` / `agentHasPendingMessages` / `isAgentIdle` /
  `waitForAgentIdle`。

getter 直接读 harness。setter 在完成 registry 解析、profile/model 验证、context
invalidation、extension contribution 等 WIDI policy 后直接写 harness。

## 统一 spawnAgent

只有一个公开创建入口。两个维度分开：`origin` 决定上下文从哪来，`parent` 决定树
归属。

```ts
type SpawnAgentOrigin =
	| {
			readonly kind: "new";
			readonly profileId?: string;
			readonly profileOverride?: AgentProfileOverride;
	  }
	| { readonly kind: "resume"; readonly reference: string | JsonlSessionMetadata }
	| {
			readonly kind: "fork";
			readonly sourceAgentId: AgentId;
			readonly entryId?: string;
	  };

interface SpawnAgentOptions {
	readonly origin: SpawnAgentOrigin;
	/** 缺省即 root；给了就是该 agent 的 child，并写入 spawnedBy 与树持久化。 */
	readonly parent?: AgentId;
	readonly model?: RuntimeModel;
	readonly thinkingLevel?: ThinkingLevel;
}
```

`newAgentSessionFromAgent` / `forkAgentSessionFromAgent` /
`resumeAgentSessionByReference` 全部变成 `spawnAgent` 的薄包装或直接删除；
`ToolAgentHost.spawn(profileId)` 内部就是
`spawnAgent({ origin: { kind: "new", profileId }, parent: callerAgentId })`，
`callerAgentId` 来自 `_createToolAgentHost` 的闭包。

必须校验的组合：

- `parent` 存在、未 disposed、不是自己、不形成环；
- `origin.kind` 为 `resume` / `fork` 时目标 profile 必须 `persist`（ephemeral 没有
  session）；`fork` 还要求 source 当前 live（要读它的 session）；
- `profileOverride` 改到 recoverable 字段时不能创建持久 session
  （`changesRecoverableProfileFields`）。

AgentId 的来源随 origin 变化：`new` 从 profile label 派生并避开 tombstone 与树里
已记录的 id；`resume` 复用被恢复 session 记录的 id（冲突时重映射，见"树恢复"）；
`fork` 用 fork 出来的新 session id。

model 只有两个来源：`options.model ?? defaultModel`。parent 不改变这条规则——child
继承的是 settings 视图，不是第二套 model 继承规则。

## per-agent settings

`LiveAgent.settings` 是一个构建期取好的小对象，不是第二个 `SettingManager` 实例。
后者带磁盘 IO、写队列、global/project 双 scope 与 `modifiedFields` 记账，N 份实例
会对同两个文件各自记账并互相覆盖。

按判据过一遍，它只剩下 harness 答不了的那几项：

```ts
interface AgentSettings {
	/** 只是构造 harness 时的入参留档；harness 吃进去后不再暴露。 */
	readonly retry: RetrySettings;
	/** provider 层重试，harness 不参与。 */
	readonly providerRetry: ProviderRetrySettings;
	/** WIDI 的自动压缩阈值，harness 只有被动的 compact()。 */
	readonly compaction: CompactionSettings;
	/** 消息流水线策略，在文本进入 harness 之前生效。 */
	readonly blockImages: boolean;
}
```

`steeringMode` / `followUpMode` **从这里删掉**：harness 有
`getSteeringMode()` / `setSteeringMode()` / `getFollowUpMode()` / `setFollowUpMode()`
（`agent-harness.ts:963-977`），把它们放进快照就是本次重构要消灭的那种镜像。构建时
仍然从 `SettingManager` 取值传给 harness 构造函数，之后一律读 harness。

- root：从 `SettingManager` 取；child：直接拷父的这一份。
- 这是快照，`SettingManager.reload()` **不会**传播到已存在的 agent；其中 retry 还被
  harness 在构造时吃进去了。当前决议是接受"改设置只影响新 agent"，不做遍历重推。
- 项目信任（`isProjectTrusted`）、启用的 extensions 与 division 选择不在这里：前者
  是项目级安全事实，per-agent 覆盖等于给扩展开提权后门；后两者在 build 时已经固化
  成 runner，改它必须走 reload。

## 必须留在我们这边的例外

判据说"单 agent 的事实从 harness 取"。以下几项是单 agent 的事实，却确实取不到，
每一条都要有理由，否则就是给镜像开后门。

| 事实 | 为什么 harness 答不了 |
| --- | --- |
| `toolPolicy`（`requestedToolNames`、`default_all` vs `explicit`） | 这是**声明式意图**，harness 只保存解析后的结果。它不是 harness 丢失的信息，是 harness 从未拥有的信息 |
| `systemPrompt` 的 facts、`resources` | 我们自己从 harness 上删掉的（`docs/pi-fork.md` "The resource removal"）。harness 现在只持有一个 system prompt source，skills 与 project context 由应用每 turn 组装。按判据它"应该"回去，但那条 divergence 有独立理由，不在本次翻案 |
| `AgentSettings` 剩下的四项 | 见上表，全部是 harness 之外的策略 |
| per-run abort signal（`_agentRunSignals`） | harness 的 `runAbortController` 是 private，且没有导出它的正当理由——阻塞型 tool 需要的是"这一次 run 被打断了吗"，我们自己发的 signal 更贴合 |
| `sessionMetadata`、agentId ↔ session 目录映射 | 本来就是 multi-agent 的事实：一个 runtime 里多个 agent 各自一个 session 目录，harness 只认自己那一个 |

反过来，凡是不在这张表里、又能从 harness 读到的，都不许在 orchestrator 上留副本。
`model`、`thinkingLevel`、`tools` / `activeTools`、`phase`、三条队列的深度、
steering/follow-up 模式，全部直接读。

## 活动状态：事件，不是字段

事实来源是 `harness.getPhase()` 与 `harness.getQueuedMessageCounts()`，加上
`MessageDeliveryQueue`（`core/message.ts`，已存在）的 per-target 队列。没有任何一份
running/idle 副本。

**不新建 `AgentMessageRuntime`。** harness 接管 phase、队列计数与 session 写入之后，
消息域剩下的东西不构成一个能自持不变量的类：投递队列已经是 `MessageDeliveryQueue`；
自定义条目的组装塌成 `appendCustomEntry` 的入参构造；input interception 的依赖是
`LiveAgent.extensionRunner`；presentation 关联在拿到 `session_write` 的 entry id 之后
是一张 Map。而它的核心判断——"这条消息投到哪、这个 agent 算不算 idle"——是一次跨
`_live`、harness phase 与 `BackgroundJobRuntime` 的 join，只能在 orchestrator 里做。
切出去的结果是每条消息穿四次边界，还把唯一真正 multi-agent 的判断挪离持有 `_live`
的地方。判据与逐条清点见 `orchestrator.pseudo.ts` 文件头与 `_messages` 注释。

因此下面这些留在 orchestrator 的字段上，它们各是一个字段而不是一个域：

- `_messages`：`MessageDeliveryQueue` 实例，`resolvePhase` 改吃 `AgentHarnessPhase`，
  平行的五值 `MessageDeliveryPhase` 删除；
- input interception 与 input presentation 到真实 user message 的关联（按 entry id
  键控；provisional session entries 整体消失）；
- 由 orchestrator 发起的 prompt run 记录（run promise + `idleReason`）与 run-start
  等待；
- per-run abort signal；
- `agent_status_changed` / `agent_idle` 的发布与 idle 等待者。

事件词汇表：

```ts
type AgentActivity = "idle" | "running";

// 活动边沿；maintenance 直接来自 phase（compaction / branch_summary）
{ type: "agent_status_changed", agentId, previousActivity?, activity,
  maintenance?: AgentMaintenanceKind, changedAt }

// 生命周期事实，由 orchestrator 发出
{ type: "agent_spawned",  agentId, profile, model, spawnedBy? }
{ type: "agent_resumed",  agentId, profile, model, spawnedBy? }
{ type: "agent_disposed", agentId, intent, reason?, disposedAt }

// idle 边沿，语义不变
{ type: "agent_idle", agentId, reason: AgentIdleReason, liveJobCount, idleAt }
```

`AgentLifecycleStatus` 的 `creating` / `unavailable` / `disposed` 从事件词汇里
消失：`creating` 不再是可观察状态，`disposed` 由 `agent_disposed` 表达，
`unavailable` 见"已知行为变更"。

`AgentIdleReason` 四值保留：

- `ready`：harness 刚建好的第一次 idle，没有任何消息可读；
- `settled`：一个 turn 正常结束，有新的 assistant 消息可读；
- `aborted`：被打断，最后一条消息可能是残片；
- `maintenance`：compaction / tree navigation 释放后的 idle。期间没有跑 agent
  loop，**没有新的 assistant 消息**，但"忙 → 空闲"这个边沿真实发生，必须发布，
  否则 `waitForAgentIdle` 的等待者会漏掉它。

`agent_idle.liveJobCount` 读 `BackgroundJobRuntime.liveJobCount(agentId)`：一次窄
查询，不是把 job 计入 idle 判断——job 未结算不会让 owner 变忙。

一个已知的微差：`agent_end` 处理里先把 phase 置 `idle`、再 emit `settled`，而
`prompt()` 的 promise 还要走完 finally 的第二次 flush 才 resolve。所以"phase idle"
比"run promise settled"早极短一段。对投递无影响（harness 此刻本来就接受新 prompt），
对 `agent_idle` 只是提前几毫秒，写进注释即可。

### prompt acceptance 必须保留

`_startPrompt` 不能在调用 `harness.prompt()` 后立刻算作"已投递"。harness 在自己的
`agent_start` 之前做的所有异步工作（turn context、session metadata、tool context、
`before_agent_start` hook）都可能失败，失败意味着 user message 从未落盘。过早
resolve 会让 delivery queue 丢掉一条 background job t1——那是模型正在等、没有任何
人会重发的消息。所以"等 harness 自己的 `agent_start`，与 run promise 的 rejection
赛跑"这套逻辑原样保留在 `_startPrompt` 里，phase 导出也替代不了它。

## Tool policy 归属

`requestedToolNames` 和 `activeToolSelection`（`default_all` 还是 `explicit`）既不
在 harness 里（harness 只知道解析后的结果），也不是创建期固定事实
（`setAgentTools` 会在运行期改它）。放 `LiveAgent.toolPolicy`：

- 它是"这一代 generation 的声明式意图"，与 harness 同生共死，dispose 时随
  `LiveAgent` 一起消失，天然不会污染 tombstone；
- extension reload 要用它重解析工具，而 reload 正是替换同一 `LiveAgent` 内的
  runner，两者生命周期一致；
- `ToolRegistry` 必须保持无 per-agent 状态：解析时会 `clone()` 出 scoped registry，
  给它加 per-agent 字段会让"共享定义 + 每次克隆"这条规则失效。

丢掉它的后果是具体的：reload 会用 profile 声明覆盖运行期 `setAgentTools` 的收窄；
把 `harness.getActiveTools()` 当成 explicit 选择，则原本 `default_all` 的 agent 在
reload 后**不会激活新扩展贡献的工具**。

## 消息投递

`sendMessage` 仍是所有输入的唯一仲裁点。身份不可伪造靠入口分层，不靠
`MessageSource` 这个可填字段：

- `AgentOrchestrator.sendMessage(draft)`：给 TUI/RPC 等可信外壳，可以构造
  `human` / `system` 来源；
- `ToolAgentHost.sendMessage(targetAgentId, body)`：给 agent tools，来源固定为
  `{ kind: "agent", agentId }`，`agentId` 来自 `_createToolAgentHost` 的闭包，
  **不来自模型参数**。这条与对外边界是否统一无关，任何时候都必须成立；
- extension 的 prompt/steer/followUp 走 `ExtensionCoreActions`，`agentId` 与
  `extensionId` 都是显式参数，由 runner 绑定。

`steerAgent` / `followUpAgent` 仍是"已经决定好投递方式"的低层入口：执行 AgentId
门控、phase 门控和 human-interrupt 协调，但不重跑 interception 与 session
accounting。

## Spawn / resume / dispose / shutdown

Spawn/resume 在局部变量中完成 profile、settings、resources、runner、tools、harness、
background attachment 的构建。全部成功后，在一个无 `await` 的同步片段中：

1. 写入或**替换** `_live` 中该 AgentId 的 `LiveAgent`（generation = 上一代 + 1）；
2. 从 `_tombstones` 移除该 id（resume 复用旧 id 时才会命中）；
3. 有 parent 就写 `_spawnParent`；
4. 返回 `agentId`。

第 1 步是唯一的发布动作：`_live` 里出现即可路由，没有"先建目录项、再补 harness"这
个中间态。

树持久化的写入（见下一节）在 install 之后、事件发布之前进行；写失败只记
diagnostic，不回滚 install——一个能用但不可恢复的 agent 好过一个不存在的 agent。

构建失败只清理局部资源并记录 diagnostic，不发布半成品。

### creation reservation 有真实职责

`_agentCreations` 不是"合并并发创建请求"（fresh spawn 的 id 是内部分配的，不存在
并发同 id 请求）。它解决两个真问题：

- **同一 session 被 resume 两次**：第二次必须等第一次结束并复用其结果，否则两个
  harness 会写同一个 jsonl。恢复整棵树时这条尤其重要：用户可能先手动 resume 了一个
  child，随后又 resume 它的 root。
- **构建中的 agent 遇到 `disposeAll` / shutdown**：reservation 带一个 `cancelled`
  标记。`disposeAll` 先置 `_shutdownRequested`，再 await 所有在飞 reservation，然后
  才做全量 sweep；构建方在每个 await 之后检查 `cancelled`，命中就走失败清理路径而
  不是 install。

resume 还必须处理两件事：

- **tombstone 覆盖**：resume 复用 session 记录的 id 作为 AgentId，install 时要把该 id
  从 `_tombstones` 移除，并清掉该 id 上属于上一代的 disposal reservation 与投影；
  正在 dispose 的同一 id 要先等它的 disposal reservation 完成。
- **background 对账**：`BackgroundJobRuntime.carriedOverJobs(agentId)` 里未答复的 t0
  handle，要在 harness 建好之后、agent 变为可路由之前，用 `harness.appendMessage`
  直接补进 session 分支。晚于可路由就变成"模型读到一条过期结果并可能起一个没人要的
  run"。

### dispose 带意图

```ts
type AgentDisposeIntent = "removed" | "runtime_shutdown";
```

`removed`（用户 `/dispose`、agent 的 `dispose_agent` 工具）是"这个 agent 不该再回
来"，写持久 tombstone；`runtime_shutdown`（`disposeAll`、shutdown 后的清理）不写
任何东西。没有这一位，正常退出会把整棵树标记为已移除，树恢复功能等于不存在。

在第一次 `await` 前同步完成：

1. 保存 `LiveAgent` 局部引用；
2. 从 `_live` 删除；
3. 写 `_tombstones`；
4. `BackgroundJobRuntime.detachAgent(agentId)`。

`_spawnParent` **不删**：这条边要留给存活的后代，见"为什么树边要单独一张表"。

第 4 步的位置是 background runtime 的硬性契约（"host must call this after it has
marked the agent as disposing and before any other teardown"）：detach 会同步作废
attachment、释放 watcher，再取消它拥有的和它欠别人的 job。

随后才写持久 tombstone（仅 `removed`）、abort/wait harness、dispose ExtensionRunner、
撤销 bindings、取消 human request、取消 delivery queue。Teardown 失败只记
diagnostic，不恢复 routing。整个 teardown 只操作那个局部引用，orchestrator 的表里
已经没有它——`resources` / `systemPrompt` 随 `LiveAgent` 一起被丢弃，不需要单独
`delete`。

subtree dispose 先 snapshot leaf-to-root 顺序，再同步完成所有目标的 `_live` 删除与
tombstone 写入。这个边界直接替代 `_disposingAgents`：cutover 与调用在同一 tick，
"是否可路由"退化为 `_live.has(agentId)`。

### 跨 generation 的 stale 判定

状态分散到 `AgentContextMonitor` / `BackgroundJobRuntime` / `MessageDeliveryQueue`
以及 orchestrator 自己那几张按 AgentId 键控的表之后，没有共享对象身份可比。所以
`LiveAgent.generation` 是必需的：所有跨 runtime 的回调、waiter、settle 都带上
generation，与当前 `LiveAgent` 不符就丢弃。`BackgroundJobRuntime` 已经这么做
（`AttachmentState.generation`），其余对齐它。

留在 orchestrator 内部的那几张表（`_agentPromptRuns`、`_agentRunSignals`、
`_agentIdleWaiters` 等）不靠 generation，靠对象身份：run reservation、signal、
waiter 本身就是唯一的比较对象，比 generation 更准（见上面 `_agentStatusRevisions`
那一节）。

## Spawn tree 持久化

`SessionDirectoryRepo` 已经给每个 session 一个目录，其文件头注释就写着这个目录该
容纳"conversation history 之外"的东西，`background/journal.ts` 是第一个先例。树持久
化用同一套落法，**不动 session metadata**。

```
<sessionsRoot>/<encoded-cwd>/<ts>_<sessionId>/
├── session.jsonl
├── jobs/jobs.jsonl
└── agents/
    ├── tree.jsonl      ← 仅 root 有：这棵树的成员表
    └── parent.json     ← 仅 child 有：指回 root 的反向指针
```

### 记录形状

append-only JSONL + 读时归约，和 `SessionJobJournal` 一致。整体重写的 JSON 在写中间
崩溃会丢整棵树。

```jsonl
{"v":1,"type":"spawned","agentId":"coder-2","sessionDir":"2026-07-30T08-12-03-441Z_coder-2","profileId":"coder","spawnedBy":"main","at":"..."}
{"v":1,"type":"removed","agentId":"coder-2","at":"..."}
```

```json
{"v":1,"rootSessionDir":"2026-07-30T08-01-55-102Z_main","parentAgentId":"main","agentId":"coder-2"}
```

`sessionDir` 存**相对于 `<encoded-cwd>` 的目录名**，不存绝对路径，也不存裸
sessionId。原因写在 `session-manager.ts:565`：session id 等于创建时的 agentId，
**跨进程会重复**；真正唯一的是 `<timestamp>_<sessionId>` 这个目录名。所谓 "agentId
与 sessionId 的映射"，准确形式是 **agentId → session 目录名**，这样 sessionsRoot
整体搬家也不会失效。

### 职责切分

- `SessionManager` 只负责目录布局、append、replay、按目录名打开 session。它不知道
  什么是 spawn tree，只提供 `appendAgentTreeRecord` / `readAgentTreeRecords` /
  `writeAgentParentPointer` / `readAgentParentPointer` 这类原语。
- `AgentOrchestrator` 负责归约成树、恢复顺序、id 重映射、dispose intent 判定。

### 写入时机

- `spawnAgent` 带 `parent` 且 root 的 session 可持久化：install 之后向 root 的
  `agents/tree.jsonl` 追加 `spawned`，并向 child 目录写 `agents/parent.json`；
- `disposeAgent` 且 `intent === "removed"`：向 root 追加 `removed`；
- `intent === "runtime_shutdown"`：什么都不写。

反向指针必须写：树索引是单向的，而 session picker 会把 child 的 session 也列出来。
没有它，用户直接打开一个 child session 会得到一个孤立的 top-level agent；之后再
resume 它的 root，同一个 session 会被打开两次（两个 harness 写同一个 jsonl）。有了
它，"resume child" 直接改写成"找到 root、恢复整棵树、把视图切到这个 child"。

### 恢复

eager：读 root 的 `tree.jsonl`，归约出仍为 live 的成员，root 先、然后按记录顺序逐个
resume。规则：

- **id 重映射**：树记录的是当时的 AgentId，而 AgentId 跨进程会重复。恢复时若该 id
  在本 runtime 已被占用，就分配一个新的（`coder-2` → `coder-3`），并在恢复期对账
  消息里告诉父 agent。不做重映射的话，父的历史里写着 `coder-2`，而 `send_message
  ("coder-2")` 会打到别的 agent 上。
- **恢复期对账消息**：与 `carriedOverJobs` 的对账合并成一条系统消息注入父的分支，
  内容包括：哪些 child 恢复了、哪些没有（ephemeral 或恢复失败）、哪些 id 被重映射。
- **部分恢复是常态**：`persist: false` 的 child 永远回不来。
- **单个 child 恢复失败**：按"构建失败什么都不发布"处理——记 diagnostic、在对账消息
  里说明，不影响 root 与其他成员。
- **ephemeral root**：没有 session 目录就没有 `tree.jsonl`，此时整棵树不做持久化，
  spawn 时发一条 diagnostic 说明。

**不恢复的东西**：background 的委派任务。settler 关系只存在于进程内，重启后
`carriedOverJobs` 只会给父一条 cancelled 结论，恢复出来的 child 完全不知道自己曾经
欠着一个任务。树回来了，工作不会回来。

### session picker

默认只列 root（即没有 `agents/parent.json` 的 session），另给一个"显示子 agent 会话"
的开关。用户心智里可恢复的单位是"那次对话"，不是"那次对话里的第 3 个子 agent"。

## harness 事件扇出

harness 的订阅回调是 detached 的（`void this._handle...`），harness 并不等它。消息
投影、context monitor、extension observer、event bus 都挂在同一条事件流上，所以：

- 订阅回调内**同步**完成必须立即生效的捕获：per-run abort signal、run-start waiter
  的 resolve；
- 其余异步扇出（orchestrator 事件、extension observers、context 测量）排到
  **per-agent 串行 tail** 上，保证 listener 看到的顺序等于 harness 产生的顺序。

`BackgroundJobRuntime` 的 per-owner tail 是同一个模式。

## ToolRegistry 与 ExtensionRunner

`ToolRegistry` 保存共享的 tool definitions，且不持有 per-agent 状态。为 agent 解析
tools 时浅 clone registry，再应用当前 `ExtensionRunner` 的 define/patch
contributions；大型 backend 和 execute function 仍共享引用。

ExtensionRunner 属于 `LiveAgent` generation，保留现有全部扩展能力：tool
define/patch 与 provider contributions、system-prompt append、input / before-agent /
provider / context / tool-call / tool-result interceptors、observed events 与
extension event、ExtensionActions / session actions / presentation / status /
onDispose。

`ExtensionCoreActions` 是 extension author API 的绑定契约，保持现状：orchestrator
构造时创建一份共享 action table，方法显式接收 `agentId` / `extensionId`，内部调用
orchestrator 的正式方法。

system prompt 每个 turn 由三部分组合：`LiveAgent.systemPrompt` 的 prompt facts、
harness 传入的当前 active tools、当前 `LiveAgent.extensionRunner` 的 append sections。
三者现在同属一个对象，回调不再需要跨表取。

reload 的 skip 判定直接读 `harness.getPhase()`：`turn` 与 maintenance 两种 phase 都
跳过，`_live` 未命中视为 gone。语义与今天一致，只是事实来源换了。

## BackgroundJobRuntime

`BackgroundJobRuntime` 已经落地（`c0938cd`），是与 `AgentOrchestrator` 并列的
sibling runtime：

- spawn/resume 时 `attachAgent`，拿到 `OwnerAttachment`（`host` + `settler`）；
- tool context 通过 `ToolAgentHost` 暴露 `jobs`（`BackgroundJobHost`）与
  `settler`（`BackgroundJobSettler`）；
- dispose 的同步窗口内 `detachAgent`；
- settlement 通过 `deliverResult` port 请求 orchestrator 投递普通消息；
- persistence、job lifecycle、output、report、ordering 全部留在 background runtime。

迁移范围（当前分支尚未完成，`agent-record.ts` / `tool-registry.ts` /
`tools/agents/shared.ts` / `tools/jobs/settlement-wait.ts` 还在引用已删除的
`BackgroundJobTable` / `BackgroundJobStore` / `ExternalJobDependencyIndex`）：

- per-agent 的 `backgroundJobTable` / `backgroundJobStore` 字段随 `AgentRecord`
  一起消失，改由 `attachAgent` 返回的 `OwnerAttachment` 挂在 `LiveAgent` 上；
- tool adapter 的 deadline race 从 `table.create(...)` 改写为 `host.startLocal()` →
  `execution.acceptBackground()` → `execution.settle()`；
- `assignAgentTask` 改用 `host.createExternal()`，settle 改用 `settler.settle()`；
- `wait_for_jobs` 改用 `host.watch()` 的原子订阅。

## 已知行为变更（需要 TUI 配合）

1. `agent.status` 的五值来源拆开：`idle` / `running` 来自
   `agent_status_changed.activity`，`disposed` 来自 `agent_disposed`，`creating`
   不再存在。
2. `unavailable` 记录消失。构建失败不再发布任何条目，也不进 `listAgents()`；失败以
   抛出的 `OrchestratorError` + diagnostic 形式返回给发起调用的界面。TUI 里所有
   `status === "unavailable"` 与 `snapshot.hasHarness === false` 的分支改为处理调用
   失败。
3. `AgentRecordSnapshot` 变成 `AgentSnapshot`：live agent 一次投影出全部字段，
   `hasHarness` 由"能否取到快照"表达，`toolSnapshot` 变 `tools`。
4. `getAgentStatus` + `getAgentMaintenance` 合并为
   `getAgentActivity(agentId): { activity, maintenance? }`。
5. `/new` 与 fork 不再继承当前 model；spawn 相关的三个 session 方法合并进
   `spawnAgent`。
6. `listAgents()` / `inspectAgent()` 不再返回已 dispose 的 agent。TUI 里
   `status !== "disposed"` 那几处过滤（`agent-identity.ts:22`、`agent-tree.ts:28`、
   `operation-hint.ts:122`、`application.ts:527/1335`）退化为恒真，删掉即可；
   TUI 自己的 agent map 靠 `agent_disposed` 事件移除条目。
7. dispose 需要传 intent：TUI 的 `/dispose` 是 `removed`，退出流程是
   `runtime_shutdown`。
8. resume 一个 root 会一次性恢复整棵树，并在父的时间线上出现一条恢复期对账消息；
   session picker 默认只列 root。
9. `/compact` 与 tree navigation 不再在 settled 之后的那个窗口里被误拒（见"两层
   门控"）。TUI 无需改动，但相关重试提示可以去掉。

## 删除与保留

删除：

- `AgentRecord` 类型本身，以及 `agent-record.ts` 里围绕它的 snapshot/mutation 辅助；
- `AgentLifecycleStatus` 五值状态机（`creating` / `running` / `idle` /
  `unavailable` / `disposed`）；
- `_disposingAgents`；
- `_maintenanceOperations`（由 `harness.getPhase()` 取代）；
- `record.harnessQueuedMessageCount` 镜像（由 `getQueuedMessageCounts()` 取代）；
- `_transitionAgentStatus` / `_commitAgentStatus` 的 `maintenance` 参数、
  `getAgentMaintenance`、`maintenanceDescription`；
- `inheritModelFromAgentId`；
- `spawnChildAgent` / `newAgentSessionFromAgent` / `forkAgentSessionFromAgent` /
  `resumeAgentSessionByReference` 作为独立创建入口；
- orchestrator 内部的 background table/store/listener 语义。

保留：

- orchestrator 的全部具名调度 API，签名不变；
- `AgentHost` / `ToolAgentHost` / `ExtensionCoreActions` 三个现有 facade，以及
  `_createToolAgentHost` 的 agentId 闭包绑定；
- creation / disposal reservation（职责已重新定义）；
- delivery queue、prompt acceptance 等待；
- `agent_status_changed` / `agent_idle` / `AgentIdleReason`；
- diagnostic / context / presentation 等独立观测投影；
- ExtensionRunner 的全部现有插入点。

## 待办

### 待办 1（已完成）：上游 `AgentHarness` 导出 phase 与队列计数

`getPhase()`、`getQueuedMessageCounts()`、`AgentHarnessQueuedMessageCounts` 已加进
`packages/agent`，两个 harness 测试覆盖"相位在第一个 await 前同步切换"和"三条队列
各自计数"，divergence 记在 `docs/pi-fork.md`。收益与边界见"两层门控"下的
"phase 与队列计数已导出"。

按 `docs/pi-fork.md` 的规矩，这条不向上游提 PR 也不提 issue：它改的是 harness-v2
要整体重写的文件，而它背后的需求（嵌入方能同步读到当前操作与队列深度）在
harness-v2 的 step 模型下多半本来就成立。等 harness-v2 的观测面定型后再判断。

### 待办 2：SessionManager 扩权，承载 spawn tree 持久化

**做什么**：给 `SessionManager` 加一组 agent-tree 原语，落在 session 目录里，与
`jobs/` 并列。

- 新增 `apps/widi/src/core/session-tree.ts`（或并入 `session-manager.ts`）：
  常量 `AGENTS_DIR_NAME = "agents"` / `AGENT_TREE_FILE_NAME = "tree.jsonl"` /
  `AGENT_PARENT_FILE_NAME = "parent.json"`，记录类型与 replay 归约；
- `SessionManager` 新增：`appendAgentTreeRecord(rootAgentId, record)`、
  `readAgentTreeRecords(sessionDir)`、`writeAgentParentPointer(agentId, pointer)`、
  `readAgentParentPointer(sessionDir)`、`openSessionByDir(sessionDir)`；
- `listAgentSessionCandidates` 增加"是否为 child"的标记，供 picker 过滤。

**为什么**：`session-repo.ts` 的目录布局本来就是为此设计的；写进 session 目录可以
避免扩展 session metadata，也让树随 session 删除一起消失。

**依赖与风险**：
- 记录里存 session 目录名而非 sessionId（id 跨进程重复）；
- append-only，读时归约，禁止整体重写；
- 与现有 `AgentSessionCandidate.parentSessionPath`（**fork 血缘**）不是同一条边，
  命名必须区分开；
- 恢复期需要 id 重映射与对账消息，这部分逻辑归 orchestrator，不归 SessionManager。

### 待办 3：`createOrchestratorHost`，统一对外面与能力收窄

**做什么**：重构落地之后，新增一个 `apps/widi/src/core/orchestrator-host.ts`，
用 `createOrchestratorHost(orchestrator)` 生成对外类型，并由它派生调用者绑定的窄视图，
取代今天并列的 `AgentHost` / `ToolAgentHost`。

**为什么推迟**：它解决的是能力面问题——extension 贡献的 tool 与 `aroundExecute`
patch 现在通过 `ToolExecutionContext` 能摸到 `executionEnv.exec` 与 `sessionManager`，
project-trust gate 因此是约定而不是结构保证。这与 record/harness/session 三处的
状态所有权是正交的两件事，混在一起改会让本次重构的 diff 无法审。

**前置条件**：本文其余部分全部落地，且 `AgentOrchestrator` 的公开方法集合稳定下来。
在那之前不要提前引入 host 类型，否则每次方法增删都要改两处签名。

**不在推迟范围内的**：agent tool 的 `agentId` 闭包绑定。它今天就正确，重构过程中
必须一直正确。

## 收益

- 三个数据结构取代一个五状态 record：`_live` 是唯一可路由集合，`_tombstones` 是一个
  字符串集合，`_spawnParent` 是树边。没有一个字段需要问"这个 agent 现在是什么状态"。
- Harness 是所有执行状态的唯一事实源：phase 与队列计数导出之后，投递相位与
  maintenance 门控都不再需要平行登记表，一并消掉一个真实的误拒缺陷。
- tombstone 内存泄漏这一类问题从结构上消失：死掉的 agent 只剩一个 id。
- 创建语义收敛成一个 `spawnAgent`，`origin` 与 `parent` 两个正交维度取代四个入口。
- spawn tree 变成可持久、可恢复的事实，而不是只活在一个进程里的内存边。
- 删除状态镜像与补丁式 idle/dispose 条件，降低代码量与内存留存风险。
