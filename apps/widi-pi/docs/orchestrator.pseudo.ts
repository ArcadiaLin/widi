/**
 * AgentOrchestrator 目标形态（架构伪代码）
 *
 * 这不是可编译实现，也不参与 apps/widi-pi 构建。所有方法都只有签名和中文职责
 * 注释，用于直接审阅重构后的类面。
 *
 * 判据（本文件所有形状都从它推出来）：单个 agent 的事实一律从 AgentHarness 取，
 * orchestrator 只做 multi-agent 才需要的判断——AgentId 的分配与不复用、spawn tree
 * 的归属与遍历、跨 agent 路由与来源合成、谁在等谁 idle，以及这些东西的持久化。
 * 例外只有五条，逐条写在计划文档的"必须留在我们这边的例外"里：tool policy 的声明
 * 式意图、我们自己从 harness 删掉的 systemPrompt/resources facts、AgentSettings
 * 剩下的四项、per-run abort signal、agentId ↔ session 目录映射。
 *
 * 设计基线：
 *
 * - 对外边界本轮不动：TUI、RPC、tools、extensions 继续直接持有 AgentOrchestrator，
 *   现有的 AgentHost / ToolAgentHost / ExtensionCoreActions 三个 facade 原样保留。
 *   统一对外面（createOrchestratorHost）与能力收窄是重构之后的独立一步，见计划
 *   文档的"待办 3"。
 * - 但调用者身份绑定不在推迟范围内：agent tool 的 agentId 永远来自
 *   _createToolAgentHost(agentId) 的闭包，绝不来自模型参数。
 * - AgentHarness 是单个 live agent 的执行权威。它的 phase 与队列计数已经通过
 *   getPhase() / getQueuedMessageCounts() 可读，所以 orchestrator 不再维护任何
 *   running/idle/maintenance 副本。相位切换都同步发生在操作的第一个 await 之前，
 *   读到的 phase 对刚发起的那次调用不会过期；抢跑的别的调用者仍由
 *   AgentHarnessError 兜底。
 * - 它同时是这个 agent 的 session 分支的**唯一写者**。四个写入方法
 *   （appendMessage / appendCustomEntry / appendCustomMessageEntry / appendLabel）
 *   与 setSessionName 都排在同一条写入尾上，idle 时立即落盘并返回 entry id，
 *   operation 期间缓冲到下一个 save point，落盘后由 session_write 事件补报 id。
 *   所以本设计里没有第二条通往 session 分支的写路径，也没有"先写再退"的补偿。
 *   例外只有 spawn tree 记录（agents/tree.jsonl 与 parent.json）：那是 session
 *   目录里的旁路文件，不属于分支，仍由 SessionManager 直写。
 * - 但"唯一写者"不等于"随便写"。这五个方法是给必须成为分支事实的条目用的：
 *   会被 resume 重放进上下文、会被 fork 带进子 session、事后要按 entry id 定位。
 *   凡是不满足这三条的（纯 UI 呈现、可重算的派生值、只在本进程有意义的登记），
 *   都放在 session 目录的旁路文件或内存里，不进分支——分支上的条目删不掉，
 *   每次 resume 都要为它付上下文预算。因此：**新增任何一处调用都要向开发者
 *   报告**，说明写的是什么、为什么必须落在分支上。既有调用点见
 *   `_withExtensionInputPresentation` 与 `_reconcileCarriedOverJobs`。
 * - 生命周期是终态而不是约定。shutdown() 之后每个入口都以 shutdown 码拒绝，
 *   abort() 变成等待并返回空结果的幂等操作，订阅表在一切静止后才释放。因此
 *   "这个 harness 还能不能用"由对象自己回答，捕获式引用（DeliveryTarget、
 *   extension bindings、tool 闭包）不再只靠 generation 对账兜底。
 * - AgentRecord 不再存在。LiveAgent 是一个 agent 的全部内存状态：构建事实、
 *   harness、settings 快照、background attachment、ExtensionRunner 及其 bindings、
 *   这一代的 tool policy。
 * - orchestrator 只有三个结构：_live（唯一可路由集合）、_tombstones（死掉的 id，
 *   防止复用）、_spawnParent（树边，必须比 LiveAgent 活得久）。
 * - 创建只有一个入口 spawnAgent：origin 管上下文（new/resume/fork），parent 管
 *   树归属（缺省 root）。
 * - spawn tree 持久化在 session 目录里（agents/tree.jsonl + parent.json），不动
 *   session metadata；resume root 会 eager 恢复整棵树。
 * - ExtensionRunner 现有的 tools、providers、system-prompt appends、interceptors、
 *   observers、actions、session context 和 reload stale boundary 全部保留。
 * - 一段逻辑只有在**拥有一份靠自己就能维持的不变量**时才独立成 runtime 类，否则
 *   留在 orchestrator 内部。满足这条的只有四个：BackgroundJobRuntime（job
 *   lifecycle、journal、per-owner ordering）、OrchestratorEventBus（订阅表与
 *   listener failure isolation）、AgentContextMonitor（generation 校验的投影与
 *   publish 去重）、AuthRuntimeController（OAuth 流程与 credential 状态）。它们
 *   都不需要查 _live 就能判断自己该做什么，端口也都只有三五个回调。
 *
 *   反过来，核心判断必须 join _live、harness phase、spawn tree 或 background 才
 *   得出的，一律留在本类里：那是路由，而路由就是 orchestrator 的定义。曾经计划
 *   中的 AgentMessageRuntime 与 AgentExtensionRuntimeSupport 都是被这条判据挡回
 *   来的，理由分别写在 _messages 与 _extensionStatuses 的注释里。
 *
 *   `core/message.ts` 的 MessageDeliveryQueue 是另一种形态：它满足这条判据（只
 *   拥有 per-target 队列，两个 port 就够），但它是被 orchestrator 调用的工具，
 *   不是与它并列的域。orchestrator/host.ts 与 orchestrator/types.ts 则只放类型，
 *   不放状态。
 *
 * 本类刻意不保存：
 *
 * - 当前 model、thinking、installed/active tools、steering/followUp 模式等
 *   AgentHarness 运行值副本；
 * - AgentLifecycleStatus 五值状态机、prompt-run 镜像、queue-count 镜像、
 *   maintenance 登记表；
 * - _agentToolSets（六个字段：三个是 harness 镜像，两个是 toolPolicy，一个已在
 *   LiveAgent.profile 上）；
 * - _agentStatusRevisions（改用 run reservation 的对象身份，见计划文档）；
 * - background job 表、store、progress/report/emission tail、_progressSequence；
 * - _disposingAgents（_live 删除本身就是 cutover），以及建立在
 *   AgentLifecycleStatus 之上的那版 idle resolver——新的判据只读 phase 与三个
 *   队列长度；
 * - provisional session entries 与它们的 leaf 回滚：自定义条目现在经 harness 写入，
 *   turn 期间自然缓冲，投递失败时那条根本没落盘，没有要撤销的东西；
 * - 由 message 反查 entry id 的索引或反向扫描：写入直接返回 id。
 *
 * 但下面这些留着，因为 harness 答不出：由本类发起的 prompt run 与它的
 * idleReason、run-start waiter、per-run signal、idle waiter，以及尚未与 user
 * message 配对的 extension input presentation。它们不构成一个域，见字段区。
 *
 * 对应说明：agent-harness-ownership-plan.md
 */

// ---------------------------------------------------------------------------
// 新的核心形状
// ---------------------------------------------------------------------------

/**
 * 一个 agent 的全部内存状态。没有第二个"目录项"对象。
 *
 * 旧 AgentRecord 被整体并进来：它原本是"构建事实 + 生命周期载体"，运行态那半已经
 * 归 harness phase，跨进程那半已经归 session 目录里的 spawn tree，剩下的构建事实
 * 只在 agent 活着时有意义。dispose 直接丢弃整个对象，所以 resources/systemPrompt
 * 不再需要"可释放"的可选性——tombstone 里不会残留任何一个字节。
 *
 * generation 是跨 runtime 的 stale 判定依据：状态分散到 message/context/background
 * 之后没有共享对象身份可比，所有回调、waiter、settle 都带它回来对账。
 * extension reload 只替换 runner、bindings 和 toolPolicy，harness 本身不换代。
 *
 * 不在这里：diagnostics、context usage（独立投影），spawnedBy（见 _spawnParent，
 * 它必须比 LiveAgent 活得久）。
 */
interface LiveAgent {
	readonly agentId: AgentId;
	readonly generation: number;

	// 构建期固定事实
	/** profile 的可序列化引用，用于 UI 显示与树记录。 */
	readonly profile: AgentProfileRecordReference;
	/**
	 * 解析后的 profile 全文。**必填**，与今天可选的 record 字段不同。
	 *
	 * 今天唯一的可选来源是失败路径 createAgentRecordFromProfileReference：它从
	 * session metadata 尽力解析一个引用，造一条 unavailable 记录让 TUI 还能显示打不
	 * 开的会话。unavailable 删掉之后，那条路径与 orchestrator.system_prompt_unavailable
	 * 一起变成死代码，这个字段就没有理由再可选。
	 */
	readonly resolvedProfile: AgentProfile;
	/** 持久化 agent 才有；ephemeral 没有 session。 */
	readonly sessionMetadata?: AgentSessionMetadata;
	/** skills 与 project context 全文，每 turn 组装 system prompt 时读。 */
	readonly resources: AgentResourcesSnapshot;
	/** system prompt 的静态部分；动态部分是 harness 的 active tools 与 runner appends。 */
	readonly systemPrompt: AgentSystemPromptFacts;

	// 运行时协作者
	/** 单 agent 全部执行事实的唯一来源。 */
	readonly harness: WidiAgentHarness;
	/** 只剩 harness 答不了的四项，见 AgentSettings。 */
	readonly settings: AgentSettings;
	/** attachAgent 的返回值：这一代的 background owner + settler capability。 */
	readonly backgroundAttachment: OwnerAttachment;
	/** 三个可变字段是 extension reload 的替换单位，harness 不随之换代。 */
	extensionRunner: ExtensionRunner;
	extensionBindings: ExtensionRunnerBindings;
	toolPolicy: AgentToolPolicy;
	/** 解除 harness 上由本代安装的订阅与 interceptor；dispose 与 reload 都要调。 */
	readonly releaseHarnessBindings: () => Promise<void>;
}

/**
 * 这一代 agent 的设置快照，不是第二个 SettingManager。
 *
 * 只保留 harness 答不了的项。steeringMode / followUpMode 曾经在这里，已经删掉：
 * harness 有 getSteeringMode/setSteeringMode 与 getFollowUpMode/setFollowUpMode，
 * 构建时传进去，之后一律读 harness。
 *
 * root 从 SettingManager 取，child 直接拷父的这一份。它是构建期快照：
 * SettingManager.reload() 不传播到已存在的 agent，而 retry 还被 harness 在构造时
 * 吃进去了。当前决议是接受"改设置只影响新 agent"。
 *
 * 项目信任、启用的 extensions 与 division 选择不在这里：前者是项目级安全事实，
 * 后两者在 build 时已经固化成 runner。
 */
interface AgentSettings {
	/** 只是构造 harness 的入参留档；harness 吃进去后不再暴露。 */
	readonly retry: RetrySettings;
	/** provider 层重试，harness 不参与。 */
	readonly providerRetry: ProviderRetrySettings;
	/** WIDI 的自动压缩阈值；harness 只有被动的 compact()。 */
	readonly compaction: CompactionSettings;
	/** 消息流水线策略，在文本进入 harness 之前生效。 */
	readonly blockImages: boolean;
}

/**
 * 这一代的声明式工具意图。
 *
 * harness 只知道解析后的结果，所以声明式意图落在 LiveAgent 上：与 harness 同生共
 * 死，reload 时随 runner 一起重解析。丢掉它，reload 会用 profile 声明覆盖运行期
 * setAgentTools 的收窄，并且把 default_all 误判成 explicit，导致新扩展工具不被
 * 激活。
 */
interface AgentToolPolicy {
	readonly requestedToolNames?: readonly string[];
	readonly activeToolSelection:
		| { readonly mode: "default_all" }
		| { readonly mode: "explicit"; readonly toolNames: readonly string[] };
}

/** 当前 ExtensionRunner 安装到 core 后产生的可撤销连接。 */
interface ExtensionRunnerBindings {
	readonly release: () => Promise<void>;
}

/** 上下文来源。它决定 session 从哪来，以及 AgentId 怎么分配。 */
type SpawnAgentOrigin =
	| {
			readonly kind: "new";
			readonly profileId?: string;
			readonly profileOverride?: AgentProfileOverride;
	  }
	| {
			readonly kind: "resume";
			readonly reference: string | JsonlSessionMetadata;
	  }
	| {
			readonly kind: "fork";
			readonly sourceAgentId: AgentId;
			readonly entryId?: string;
	  };

/**
 * 唯一的创建入口参数。
 *
 * 两个维度正交：origin 管上下文，parent 管树归属。model 只有
 * options.model ?? defaultModel 两个来源——parent 继承的是 settings 快照，不是
 * 第二套 model 继承规则。
 */
interface SpawnAgentOptions {
	readonly origin: SpawnAgentOrigin;
	/** 缺省即 root；给了就是该 agent 的 child，写入 spawnedBy 与树持久化。 */
	readonly parent?: AgentId;
	readonly model?: RuntimeModel;
	readonly thinkingLevel?: ThinkingLevel;
}

/**
 * dispose 的意图。
 *
 * removed 表示"这个 agent 不该再回来"，写持久 tombstone；runtime_shutdown 什么都
 * 不写。没有这一位，正常退出会把整棵树标记为已移除，树恢复功能等于不存在。
 */
type AgentDisposeIntent = "removed" | "runtime_shutdown";

interface DisposeAgentOptions {
	readonly intent: AgentDisposeIntent;
	readonly reason?: string;
	/** 默认只 dispose 指名的 agent。 */
	readonly scope?: AgentDisposeScope;
}

/** 活动状态只有两个值；creating/unavailable/disposed 不再是活动概念。 */
type AgentActivity = "idle" | "running";

/**
 * 取代旧的 getAgentStatus + getAgentMaintenance。
 *
 * 两个字段都由 harness.getPhase() 直接映射：turn → running；compaction /
 * branch_summary → running + maintenance kind；idle → idle。上游联合里还有一个
 * 从不写入的 "retry"，按 running 处理即可，但不能漏掉分支。
 */
interface AgentActivitySnapshot {
	readonly activity: AgentActivity;
	readonly maintenance?: AgentMaintenanceKind;
}

/**
 * 一个 live agent 的对外投影。
 *
 * 没有"稳定部分 + 可选运行时部分"的二分了：能取到快照就说明 agent 活着，取不到就
 * 是 gone 或 unknown。旧的 hasHarness 布尔与 disposed 快照一并消失。
 */
interface AgentSnapshot {
	readonly agentId: AgentId;
	readonly generation: number;
	readonly profile: AgentProfileRecordReference;
	readonly spawnedBy?: AgentId;
	readonly sessionMetadata?: AgentSessionMetadata;
	readonly model: RuntimeModel;
	readonly thinkingLevel: ThinkingLevel;
	readonly tools: AgentToolsSnapshot;
	readonly activity: AgentActivitySnapshot;
	readonly extensions: ExtensionRunnerSnapshot;
	readonly diagnostics: readonly OrchestratorDiagnostic[];
	readonly contextUsage?: AgentContextUsage;
}

/** 构建完成但尚未发布到 _live 的局部结果。 */
interface LiveAgentBuild {
	readonly liveAgent: LiveAgent;
	/** 有 parent 且 root 可持久化时，install 之后要写的树记录。 */
	readonly treeRecord?: AgentTreeSpawnRecord;
}

/**
 * dispose 在第一次 await 前生成的同步 cutover 结果。
 *
 * liveAgent 可缺席：目标可能已经是 tombstone，或者正处在构建中（此时由 creation
 * reservation 的 cancelled 标记负责让构建方走失败清理）。
 */
interface DisposedLiveAgent {
	readonly agentId: AgentId;
	readonly liveAgent?: LiveAgent;
}

/**
 * 一次 _resolveAgent 的完整结果。四种可能穷尽了一个 AgentId 的全部含义。
 *
 * 三个来源各答一段：_live 命中即 live；_tombstones 命中即 gone；
 * _agentCreations 命中即 creating；都不命中即 unknown。旧的五值
 * AgentLifecycleStatus 由它取代，且不再有任何一份需要维护的状态字段。
 */
type AgentLookup =
	| { readonly kind: "live"; readonly liveAgent: LiveAgent }
	| { readonly kind: "gone" }
	| {
			readonly kind: "creating";
			readonly reservation: AgentCreationReservation;
	  }
	| { readonly kind: "unknown" };

/**
 * 一次查表得到的 delivery 目标。
 *
 * phase 是当场从 harness 读的，不是投影：投递方式的选择需要它，而 harness 的错误
 * 覆盖不到全部相位（对 idle 目标调 followUp 只会拿到可重试的 invalid_state）。
 */
interface DeliveryTarget {
	readonly agentId: AgentId;
	readonly generation: number;
	readonly harness: WidiAgentHarness;
	readonly phase: AgentHarnessPhase;
}

/**
 * 创建预约。它不是"合并并发创建请求"，而是解决两件事：同一 session 被 resume
 * 两次时第二次必须复用第一次的结果（恢复整棵树时尤其重要——用户可能先手动
 * resume 了一个 child，随后又 resume 它的 root）；构建中的 agent 遇到
 * disposeAll/shutdown 时必须能被取消而不是事后变成孤儿。
 */
interface AgentCreationReservation {
	readonly agentId: AgentId;
	readonly completion: Promise<AgentId>;
	cancelled: boolean;
	readonly cancel: () => void;
}

/** 合并重复 dispose 请求；不决定 agent 是否可路由。 */
interface AgentDisposalReservation {
	readonly agentId: AgentId;
	readonly completion: Promise<void>;
}

// ---------------------------------------------------------------------------
// spawn tree 持久化的形状
// ---------------------------------------------------------------------------

/**
 * 树记录写在 root 的 session 目录里：<root session dir>/agents/tree.jsonl，
 * append-only，读时归约。child 的目录里另有一行反向指针 agents/parent.json。
 *
 * sessionDir 存的是相对 <encoded-cwd> 的目录名，不是绝对路径，也不是裸
 * sessionId——session id 等于创建时的 agentId 且跨进程重复，唯一的是
 * <timestamp>_<sessionId> 这个目录名。所谓 "agentId 与 sessionId 的映射"，准确
 * 形式是 agentId → session 目录名。
 */
interface AgentTreeSpawnRecord {
	readonly v: 1;
	readonly type: "spawned";
	readonly agentId: AgentId;
	readonly sessionDir: string;
	readonly profileId: string;
	readonly spawnedBy: AgentId;
	readonly at: string;
}

interface AgentTreeRemovedRecord {
	readonly v: 1;
	readonly type: "removed";
	readonly agentId: AgentId;
	readonly at: string;
}

type AgentTreeRecord = AgentTreeSpawnRecord | AgentTreeRemovedRecord;

/** child 目录里的反向指针，使"从 child 恢复"能找回它的 root。 */
interface AgentParentPointer {
	readonly v: 1;
	readonly rootSessionDir: string;
	readonly parentAgentId: AgentId;
	readonly agentId: AgentId;
}

/** 归约后的一个待恢复成员。 */
interface AgentTreeMember {
	readonly recordedAgentId: AgentId;
	readonly sessionDir: string;
	readonly profileId: string;
	readonly spawnedBy: AgentId;
}

/**
 * 一次树恢复的结果，用于生成恢复期对账消息。
 *
 * 恢复必然是部分的：persist 为 false 的 child 永远回不来，单个 child 恢复失败也
 * 只记 diagnostic 而不影响 root。
 */
interface AgentTreeResumeOutcome {
	readonly rootAgentId: AgentId;
	readonly resumed: readonly AgentId[];
	/** 记录的 id 已被占用而重新分配的成员：模型历史里的旧地址失效了。 */
	readonly remapped: readonly {
		readonly recordedAgentId: AgentId;
		readonly agentId: AgentId;
	}[];
	readonly failed: readonly {
		readonly recordedAgentId: AgentId;
		readonly reason: string;
	}[];
}

// ---------------------------------------------------------------------------
// Tool 闭包面：沿用现有 ToolAgentHost，本轮不改形状
// ---------------------------------------------------------------------------

/**
 * 一个 agent 的 tool 闭包能看到的能力。今天就存在（`core/agent-host.ts`），本次
 * 重构只把它的实现改成读 LiveAgent，不动它的成员。
 *
 * core tools 和 extension 贡献的 tools 拿的是同一个对象。agentId 由
 * _createToolAgentHost 的闭包捕获，**永远不来自模型参数**——这是消息来源不可伪造
 * 的唯一依据，与"是否统一对外面"无关，任何时候都必须成立。
 */
export interface ToolAgentHost {
	readonly agentId: AgentId;
	/** 可见的 profile 清单，用于让模型选择 spawn 什么。 */
	listProfiles(): Promise<readonly AgentProfileBrief[]>;
	/** 本 tree 内仍然 live 的 agents，含自己。 */
	listAgents(): readonly AgentBrief[];
	/** 精确地址解析；跨 tree 有效，但不提供枚举路径。unknown 返回 undefined。 */
	describe(targetAgentId: AgentId): AgentBrief | undefined;
	/** 等价于 spawnAgent({ origin: { kind: "new", profileId }, parent: 自己 })。 */
	spawn(profileId: string): Promise<AgentId>;
	/** 以本 agent 身份发一条消息；来源固定为 { kind: "agent", agentId }。 */
	sendMessage(
		targetAgentId: AgentId,
		body: string,
	): Promise<MessageSendOutcome>;
	/** same-tree dispose，intent 固定为 removed。 */
	dispose(
		targetAgentId: AgentId,
		options: AgentRequestedDisposeOptions,
	): Promise<AgentRequestedDisposeOutcome>;
	/** 本 generation 的 background owner capability（自己的 job）。 */
	readonly jobs: BackgroundJobHost;
	/** 本 generation 的 settler capability（写别人 job 的结果）。 */
	readonly settler: BackgroundJobSettler;
	/** 以 { kind: "agent", agentId } 为来源发起 human request。 */
	requestHuman(request: HumanRequestDraft): Promise<HumanResponse>;
}

/**
 * 一次 turn 共用的轻量 tool binding。
 *
 * 除了 tool host，只多两样与"这一次 turn"绑定的东西：人类中断观察，以及本 turn
 * 起始时的 runner generation（extension tools 用；reload 后旧 context 进入 stale
 * boundary，不能静默改用 replacement runner）。
 */
interface ToolAdapterContext {
	readonly agent: ToolAgentHost;
	readonly humanInterrupts: HumanInterruptWatch;
	readonly createExtensionContext: ExtensionToolContextFactory;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * TUI、RPC、facade 直接持有的类型，与今天一致。
 *
 * "哪些方法对外"本轮仍然只由 public/private 修饰符表达；把公开面收进一个独立的
 * host 类型是重构之后的事（计划文档"待办 3"）。private 服务字段依然全部 private，
 * 但这只是习惯，不构成结构保证——extension 贡献的 tool 目前仍能通过
 * ToolExecutionContext 摸到 executionEnv 与 sessionManager，那是待办 3 要解决的。
 */
export declare class AgentOrchestrator {
	// -- 内部服务 -------------------------------------------------------------

	private readonly _executionEnv: ExecutionEnv;
	private readonly _resourceLoader: ResourceLoader;
	/** 除会话本身外，还拥有 spawn tree 持久化的目录布局与 IO 原语。 */
	private readonly _sessionManager: SessionManager;
	private readonly _settingManager: SettingManager;
	private readonly _modelRegistry: ModelRegistry;
	private readonly _profileRegistry: AgentProfileRegistry;
	private readonly _toolRegistry: ToolRegistry;
	private readonly _extensionLoader: ExtensionLoader;

	/**
	 * background 是 sibling runtime。这里持有引用只为 attach/detach、向 scoped
	 * host 提供 capability、读 liveJobCount 与 carriedOverJobs，以及接收 t1
	 * delivery；不读它的内部 job 状态，也不把 job 计入 idle 判断。
	 */
	private readonly _backgroundJobs: BackgroundJobRuntime;

	/**
	 * 投递队列，就是 `core/message.ts` 里已经存在的那个类，不是一个消息域。
	 *
	 * 它只拥有 per-target FIFO、相邻同 mergeKey 的合并，以及投递失败后的重排与
	 * 重投，两个 port（resolvePhase / deliver）就够，完全不认识 agent registry。
	 * 本轮唯一要改的是 resolvePhase 的类型：直接吃 AgentHarnessPhase，`creating`
	 * 与 `gone` 由 _resolveDeliveryTarget 抛错拦掉，平行的五值 MessageDeliveryPhase
	 * 随之删除。
	 *
	 * **消息域没有第二个类。** 曾经计划中的 AgentMessageRuntime 要打包六件事，
	 * 在 harness 接管 phase、队列计数与 session 写入之后逐条清点，剩不下一个域：
	 *
	 * - delivery queue / ordering / merge：已经是这个类；
	 * - 自定义条目的组装：塌成 appendCustomEntry 的入参构造，纯函数无状态；
	 * - input interception：依赖 LiveAgent.extensionRunner，还要往回报 extension
	 *   diagnostics，切出去就是四个回调换三十行；
	 * - presentation 关联：拿到 session_write 的 entry id 之后是一张 Map；
	 * - prompt run 记录、run-start waiter、per-run signal：各是一个字段。
	 *
	 * 而它的核心判断——"这条消息投到哪、这个 agent 算不算 idle"——是一次跨
	 * _live、harness phase 与 background 的 join（见 isAgentIdle），正是本类的
	 * 定义。把它切出去只会让每条消息都穿一次边界，并且把唯一真正 multi-agent
	 * 的那个判断挪离持有 _live 的地方。
	 */
	private readonly _messages: MessageDeliveryQueue;

	/**
	 * 由本类发起的 prompt run。harness 说得出"在 turn 里"，说不出"这个 turn 是谁
	 * 起的、结果该报给谁、结束时的 idleReason 是 aborted 还是 settled"。
	 *
	 * 用对象身份判 stale，所以不再需要 _agentStatusRevisions：dispose 或 resume
	 * 换代之后，旧 run 的 finally 只在表里仍然是自己时才结算。
	 */
	private readonly _agentPromptRuns: Map<AgentId, AgentPromptRun>;

	/**
	 * 等待目标 harness 下一次 agent_start 的 waiter，在 prompt() 之前注册。
	 *
	 * acceptance 等的就是这个事件：harness 在 agent_start 之前的全部异步工作都可能
	 * 失败，而失败意味着 user message 从未落盘。phase 替代不了它——phase 在
	 * prompt() 第一行就翻成了 turn。见 _startPrompt。
	 */
	private readonly _agentRunStartWaiters: Map<AgentId, Set<() => void>>;

	/** 当前 run 的 abort signal，从 harness 事件订阅里捕获，供 extension context 读。 */
	private readonly _agentRunSignals: Map<AgentId, AbortSignal>;

	/**
	 * idle 边沿的三份状态：等待者、上一次 idle 的原因，以及"已经发过 agent_idle"
	 * 这个去重位。
	 *
	 * 三者必须读同一个判据（isAgentIdle），否则 await waitForAgentIdle 的消费者与
	 * 订阅 agent_idle 的消费者会对"它到底停了没有"给出不同答案。
	 */
	private readonly _agentIdleWaiters: Map<AgentId, Set<AgentIdleWaiter>>;
	private readonly _agentIdleReasons: Map<AgentId, AgentIdleReason>;
	private readonly _publishedAgentIdles: Set<AgentId>;

	/**
	 * 已发出、尚未与 user message 配对的 extension input presentation，按目标
	 * agent 分组的一条投递顺序短队列。
	 *
	 * 配对时机是 harness 的 session_write 事件：它同时带着落盘的那条消息与它的
	 * entry id，所以取队头即可完成配对并直接拿到 id。今天的两条退路——按
	 * expectedText 猜、以及按对象身份反扫 session——一起消失，前者会错配，后者是
	 * O(session) 且在 session 重新 hydrate 后失效。
	 *
	 * 投递失败或 abort 清队列时按对象身份从队列里摘除，见
	 * _withExtensionInputPresentation。
	 */
	private readonly _pendingExtensionInputPresentations: Map<
		AgentId,
		PendingExtensionInputPresentation[]
	>;

	/**
	 * 每个 agent 这一代 runner 里各 extension 的加载/失败状态。已经是独立类，因为
	 * 它自己维护"换代即整组重置"这条不变量。
	 *
	 * 它旁边那些 extension 数据面细节（下面两个 dispatch 深度、上面的 presentation
	 * 表）**不合并成一个 AgentExtensionRuntimeSupport**：它们之间没有共同不变量，
	 * 包起来只是给几张互不相关的表起了个集体名字，而真正的 extension 生命周期
	 * ——runner 的创建、binding、swap、dispose——本来就在本类里显式编排，runner
	 * 本身挂在 LiveAgent 上。
	 */
	private readonly _extensionStatuses: ExtensionStatusRegistry;
	/** extension event 的有界递归深度，随 dispatch 上下文传播。 */
	private readonly _extensionEventDispatchContext: AsyncLocalStorage<number>;
	/** observed-event 扇出的 per-agent 深度，用于避免 diagnostic 自激。 */
	private readonly _extensionObserverDispatchDepth: Map<AgentId, number>;

	/**
	 * 所有 runners 共用的一张 ExtensionCoreActions table。
	 *
	 * 方法显式接收 agentId/extensionId，内部调用 host 的正式方法；runner 负责把它们
	 * 绑定进 author context。因此不会按 agent 或 tool 重复创建整套闭包。
	 */
	private readonly _extensionCoreActions: ExtensionCoreActions;

	/** OAuth 流程、human prompts、credential refresh 等 auth 细节的 owner。 */
	private readonly _auth: AuthRuntimeController;

	/** client/listener 广播和 listener failure 隔离的 owner。 */
	private readonly _events: OrchestratorEventBus;

	/**
	 * 按 AgentId 保存历史 diagnostics，供 AgentSnapshot 读。
	 *
	 * 一张 Map 就是全部：追加、按 agent 读、dispose 时删。没有需要它自己维持的
	 * 不变量，所以不成类。它今天挂在 AgentRecord 上，而 LiveAgent 在 dispose 时
	 * 整个丢弃，所以要独立出来。
	 */
	private readonly _agentDiagnostics: Map<AgentId, OrchestratorDiagnostic[]>;

	/**
	 * 计算并发布 session-derived context usage。
	 *
	 * 它自带 generation 校验与 publish 去重，所以 attach/detach/invalidate/refresh
	 * 四个方法之外不需要本类配合。自动压缩的触发判断留在本类（见
	 * _autoCompactingAgents）：那是调度意图，不是投影。
	 */
	private readonly _context: AgentContextMonitor;

	/** 所有人类请求及取消语义的 owner。 */
	private readonly _humanRequests: HumanRequestBroker;

	/** 人类 steer 是否尚未被 harness 读取的独立协调域。 */
	private readonly _humanInterrupts: HumanInterruptRegistry;

	// -- Orchestrator 自己拥有的状态 -----------------------------------------

	private _defaultModel: RuntimeModel;
	private _defaultThinkingLevel: ThinkingLevel | undefined;
	private _defaultProfileId: string;
	private _enabledProfileIds: readonly string[] | undefined;

	/**
	 * 唯一可路由集合，只有当前 generation。install 写入，dispose cutover 同步删除。
	 * 命中即"活着"，不需要再问状态。
	 */
	private readonly _live: Map<AgentId, LiveAgent>;

	/**
	 * 曾经存在过、已经消失的 AgentId。
	 *
	 * 存在的唯一理由是让死掉的 id 永不被复用：一条还在飞的旧消息若打在重新分配出去
	 * 的同名 id 上，会投递到另一个 agent。dispose 的意图/时间/原因由 agent_disposed
	 * 事件与 agents/tree.jsonl 承载，这里不需要 payload——所以它是 Set，不是 Map，
	 * tombstone 里除了字符串什么都不留。
	 */
	private readonly _tombstones: Set<AgentId>;

	/**
	 * spawn 树边，child → parent。**dispose 时不删**。
	 *
	 * 单个 dispose 不带走子树，中间节点消失后它的存活后代仍要能被祖先的 subtree
	 * dispose 扫到（今天靠 tombstone record 上保留的 spawnedBy 实现，见
	 * agent-orchestrator.ts:1952 与 _collectAgentSubtreePostOrder:2492）。它同时是
	 * agents/tree.jsonl 在内存里的镜像。
	 *
	 * 剪枝规则（否则就是把慢泄漏换了个位置）：dispose 一个没有存活后代的节点时删掉
	 * 它的边，再沿祖先链向上删掉同样已无存活后代的 tombstone 边。留下的只有"死了但
	 * 还挡着路"的中间节点，上界是同时存活的分叉数，不随会话时长增长。
	 */
	private readonly _spawnParent: Map<AgentId, AgentId>;

	/** 下一代 generation 号，按 AgentId 单调递增，resume 复用 id 时继续加。 */
	private readonly _agentGenerations: Map<AgentId, number>;

	/** resume 去重 + 构建期取消；不表示 agent activity。 */
	private readonly _agentCreations: Map<AgentId, AgentCreationReservation>;

	/** 只合并并发 dispose 请求；不决定 agent 是否可路由。 */
	private readonly _agentDisposals: Map<AgentId, AgentDisposalReservation>;

	/**
	 * 已经决定要自动压缩、但尚未开始的 agent。保留，phase 取代不了它。
	 *
	 * 判定跨了一个 await（重新测量 context usage），phase 只能在第二次 compact() 真
	 * 调用时才拒；那次拒绝会落进 catch 变成一条 compaction.auto_failed 警告，把一次
	 * 正常去重变成用户可见的噪音。它表达的是调度意图，本来就不是 harness 的问题。
	 */
	private readonly _autoCompactingAgents: Set<AgentId>;

	/**
	 * 每个 root 的 tree 文件写入串行尾，保证 spawned/removed 的追加顺序等于事件
	 * 发生顺序。与 background journal 的 per-owner tail 同构。
	 */
	private readonly _treeWrites: Map<AgentId, Promise<void>>;

	private _shutdownRequested: boolean;

	// -----------------------------------------------------------------------
	// 构造与 runtime 默认值
	// -----------------------------------------------------------------------

	/**
	 * 注入各 service，建立四个独立 runtime 与投递队列的 ports。
	 *
	 * ports 都指回本类的 private 方法（_publishEvent、_publishDiagnostic、
	 * _resolveDeliveryTarget、_deliverQueuedMessage 等），所以依赖边是单向的：
	 * runtime 不认识 orchestrator，只认识自己那三五个回调。
	 */
	constructor(config: AgentOrchestratorConfig);

	/**
	 * runtime 级默认值，spawn 时的取值来源。它们不是任何一个 agent 的状态——单
	 * agent 的当前值一律读 harness——所以整组 setter 都只影响后续 spawn，绝不遍历
	 * 已存在的 agent 去改写。
	 */
	getDefaultModel(): RuntimeModel;
	setDefaultModel(model: RuntimeModel): void;
	getDefaultThinkingLevel(): ThinkingLevel | undefined;
	setDefaultThinkingLevel(level: ThinkingLevel | undefined): void;
	getDefaultProfileId(): string;
	setDefaultProfileId(profileId: string): void;

	/** 限制 spawn 可选的 profile 集合；undefined 表示不限制。 */
	getEnabledProfileIds(): readonly string[] | undefined;
	setEnabledProfileIds(profileIds: readonly string[] | undefined): void;

	/**
	 * 汇总各 service 在启动期间攒下的 diagnostics，从统一事件出口发布。
	 *
	 * 单独一个方法而不是在构造里发：构造时还没有 client 订阅，发了没人收得到。
	 */
	emitStartupDiagnostics(): Promise<void>;

	// -----------------------------------------------------------------------
	// Agent registry 与 lifecycle
	// -----------------------------------------------------------------------

	/**
	 * 唯一的创建入口，只返回 AgentId：harness 不出边界。
	 *
	 * 校验的组合：parent 存在、未 disposed、非自身、不成环；resume/fork 要求
	 * profile 可持久（ephemeral 没有 session），fork 还要求 source 当前 live；
	 * profileOverride 改到 recoverable 字段时不能创建持久 session。
	 */
	spawnAgent(options: SpawnAgentOptions): Promise<AgentId>;

	/** 组合 LiveAgent、harness 当前值与独立 projections，生成快照。 */
	inspectAgent(agentId: AgentId): AgentSnapshot;

	/** 只列 live agents。tombstone 不再出现在这里，TUI 靠 agent_disposed 移除条目。 */
	listAgents(): AgentListResult<AgentSnapshot>;

	/**
	 * dispose 单个 agent 或整个 subtree。
	 *
	 * 所有目标在第一次 await 前完成 _live 删除、tombstone 写入和 background
	 * detach，因此"是否可路由"退化为 _live.has(agentId)，不需要第二个 disposing
	 * 集合。intent 为 removed 时才写持久 tombstone。
	 */
	disposeAgent(
		agentId: AgentId,
		options: DisposeAgentOptions,
	): Promise<readonly AgentId[]>;

	/**
	 * 同步切断全部 live routing，随后释放所有 runtime 资源。
	 *
	 * 先置 _shutdownRequested，再取消并 await 所有在飞 creation reservation，最后
	 * 才全量 sweep（intent 为 runtime_shutdown，不写任何持久 tombstone）：否则一个
	 * 正在构建的 agent 会在 disposeAll 之后才安装完成。
	 *
	 * 这里的 shutdown 与 requestShutdown() 不是一回事：那个只是向 extensions 广播
	 * 一次请求。它返回时每个 harness 都已封死且 session 写入都已落盘，所以进程可以
	 * 直接退出——前提是 _disposeLiveAgent 的超时兜住了不响应 abort 的 tool。
	 */
	disposeAll(reason?: string): Promise<void>;

	// -----------------------------------------------------------------------
	// Spawn tree 与协作查询（ToolAgentHost 的实现基座）
	// -----------------------------------------------------------------------

	/**
	 * agent 能 spawn 的 profile 清单，受 enabledProfileIds 约束。
	 *
	 * 与 listProfiles 的区别只有一个：这里过滤掉不允许被 agent 主动创建的 profile，
	 * 免得模型看见一个它调用必然失败的选项。
	 */
	listSpawnableAgentProfiles(): Promise<readonly AgentProfileBrief[]>;

	/** discovery scope；持有准确 AgentId 的跨 tree send 仍由 sendMessage 接受。 */
	listAgentTree(rootOfAgentId: AgentId): readonly AgentBrief[];

	/**
	 * 精确地址解析，跨 tree 有效，unknown 返回 undefined 而不是抛错。
	 *
	 * 它与 listAgentTree 的分工就是"枚举"与"寻址"的分工：枚举受 tree 约束（不让一个
	 * agent 发现整个 runtime 里有谁），寻址不受——已经拿到准确 AgentId 的调用方，
	 * 拦它没有意义，只会让跨 tree 的合法回执无法投递。
	 */
	findAgent(agentId: AgentId): AgentBrief | undefined;

	/** agent 发起的 same-tree dispose，集中处理 outside_tree/self/subtree。 */
	disposeAgentFromAgent(
		callerAgentId: AgentId,
		targetAgentId: AgentId,
		options: AgentRequestedDisposeOptions,
	): Promise<AgentRequestedDisposeOutcome>;

	/** 以 agent 身份投递消息；来源在这里合成，不接受调用方给的 source。 */
	sendMessageFromAgent(
		callerAgentId: AgentId,
		targetAgentId: AgentId,
		body: string,
	): Promise<MessageSendOutcome>;

	/**
	 * 把上面这些方法与 background capability 打包成调用者绑定视图。
	 *
	 * 今天就叫这个名字（`_createToolAgentHost`），本轮只改实现不改形状。它是 private
	 * 的：tool 闭包由 orchestrator 构造并交给 adapter，外部拿不到构造它的能力。
	 */
	private _createToolAgentHost(agentId: AgentId): ToolAgentHost;

	// -----------------------------------------------------------------------
	// Session（只读与改名）
	// -----------------------------------------------------------------------

	/**
	 * 可恢复会话清单。默认只列 root——即没有 agents/parent.json 的 session；child
	 * 会话由所属 root 带回来，单独列出会让用户 resume 出半棵树。
	 */
	listAgentSessions(): Promise<AgentSessionListResult>;

	/**
	 * 这一组是 SessionManager 的薄转发，orchestrator 只做 AgentId → session 的解析。
	 *
	 * 会话内容（分支、条目、名称）从来不是 orchestrator 的状态；它唯一拥有的是
	 * "哪个 AgentId 对应哪个 session 目录"这条 multi-agent 映射。
	 */
	getAgentSession(agentId: AgentId): Promise<AgentSessionSnapshot>;
	getAgentSessionTree(agentId: AgentId): Promise<AgentSessionTreeSnapshot>;
	getAgentSessionName(agentId: AgentId): Promise<string | undefined>;

	/** 修改 session 名称并发布 session-info changed 事件。 */
	setAgentSessionName(
		agentId: AgentId,
		name: string,
	): Promise<AgentSessionSnapshot>;

	// -----------------------------------------------------------------------
	// Model、auth 与资源选择
	// -----------------------------------------------------------------------

	/** 直接读 harness.getModel()；orchestrator 侧没有 model 字段可读。 */
	getAgentModel(agentId: AgentId): RuntimeModel;

	/**
	 * 把已经解析、验证过的 RuntimeModel 写入 harness，并使旧的 context-usage
	 * projection 失效。
	 */
	setAgentModel(agentId: AgentId, model: RuntimeModel): Promise<void>;

	/**
	 * runtime 级的 model 目录，与任何 agent 无关，所以不带 agentId。
	 *
	 * 它带 credential 可用性：一个没有凭据的 provider 仍然列出但标记不可用，否则用户
	 * 只会看到"这个模型不存在"，而真实原因是没登录。
	 */
	listAvailableModelCandidates(): Promise<AgentModelCandidateListResult>;

	/** 解析 provider/model reference、验证可用性，再委托 setAgentModel。 */
	setAgentModelByReference(
		agentId: AgentId,
		reference: string,
	): Promise<RuntimeModel>;

	/**
	 * auth 域的两个只读投影，同样与 agent 无关。
	 *
	 * orchestrator 在这里只做转发：凭据的读写、刷新、OAuth 交互全部归
	 * AuthRuntimeController，它需要的 human request 也由它自己发起。
	 */
	listAuthProviderCandidates(): AuthProviderCandidateListResult;
	listAuthCredentialCandidates(): Promise<AuthCredentialCandidateListResult>;

	/** 启动 provider 登录流程，并把交互步骤映射到 human request 与事件。 */
	loginAuthProvider(
		providerId: string,
		options?: { readonly agentId?: AgentId },
	): Promise<AuthProviderLoginResult>;

	/** 删除 provider credential，并刷新依赖 credential 的 model 可用性。 */
	logoutAuthProvider(providerId: string): Promise<AuthProviderLogoutResult>;

	/** 依据 harness 当前 model 列出它支持的 thinking levels。 */
	listAgentThinkingLevelCandidates(
		agentId: AgentId,
	): AgentThinkingLevelCandidateListResult;

	/** 直接读 harness.getThinkingLevel()；同样没有第二份。 */
	getAgentThinkingLevel(agentId: AgentId): ThinkingLevel;

	/** 依据 harness 当前 model 验证支持范围，再写入 thinking level。 */
	setAgentThinkingLevel(agentId: AgentId, level: ThinkingLevel): Promise<void>;

	/**
	 * 面向 UI 的字符串入口：解析名称、验证当前 model 支持，再委托
	 * setAgentThinkingLevel。
	 *
	 * 独立存在是因为"名称无效"和"模型不支持"是两种要分别说清楚的失败，塞进
	 * setAgentThinkingLevel 会让类型化入口背上字符串解析的责任。
	 */
	setAgentThinkingLevelByName(
		agentId: AgentId,
		levelName: string,
	): Promise<AgentThinkingLevelResult>;

	/** 从磁盘重新加载 prompt templates，并返回可供 UI 选择的 candidates。 */
	listAgentPromptTemplateCandidates(
		agentId: AgentId,
	): Promise<AgentPromptTemplateCandidateListResult>;

	/**
	 * 取一个已解析的 prompt template。
	 *
	 * 带 agentId 只是为了应用该 agent 的 profile 约束与搜索路径；模板本身不属于
	 * agent，也不进 LiveAgent——`/prompt` 在文本进入 harness 之前就展开完了。
	 */
	getAgentPromptTemplate(
		agentId: AgentId,
		name: string,
	): Promise<PromptTemplate>;

	/** 按 LiveAgent.resolvedProfile 的约束重新加载 skills，并返回 candidates。 */
	listAgentSkillCandidates(
		agentId: AgentId,
	): Promise<AgentSkillCandidateListResult>;

	/**
	 * 取一条已解析的 skill，语义与 getAgentPromptTemplate 对称。
	 *
	 * skills 是我们从 harness 上删掉的那部分（docs/pi-fork.md "The resource
	 * removal"）：harness 不再持有它们，由应用每 turn 组装进 system prompt。
	 */
	getAgentSkill(agentId: AgentId, name: string): Promise<Skill>;

	// -----------------------------------------------------------------------
	// Tool policy 与 system prompt
	// -----------------------------------------------------------------------

	/**
	 * 从 harness 当前 installed/active tools 生成快照，不维护第二份。
	 *
	 * 这条替代整张 _agentToolSets 表：它六个字段里，tools/toolNames/activeToolNames
	 * 是 harness 镜像（getTools() 返回的就是 ResolvedAgentHarnessTool[]），
	 * requestedToolNames/activeToolSelection 是 toolPolicy，profileId 已在
	 * LiveAgent.profile 上。没有一个字段需要自己的表。
	 */
	getAgentTools(agentId: AgentId): AgentToolsSnapshot;

	/**
	 * 用 base registry、profile policy 和当前 ExtensionRunner contributions 解析
	 * declarative names，一次性替换 harness tools，并把新的意图写回
	 * LiveAgent.toolPolicy——reload 要靠它重解析。
	 */
	setAgentTools(
		agentId: AgentId,
		toolNames: readonly string[],
		activeToolNames?: readonly string[],
	): Promise<void>;

	/** 直接读 harness.getActiveTools() 的名字，不读 toolPolicy。 */
	getAgentActiveTools(agentId: AgentId): readonly string[];

	/**
	 * 在 harness 当前 installed tools 上验证并替换 active selection，同时把
	 * toolPolicy 的 activeToolSelection 改为 explicit。
	 */
	setAgentActiveTools(
		agentId: AgentId,
		toolNames: readonly string[],
	): Promise<void>;

	/**
	 * 用 LiveAgent.systemPrompt 的静态 facts、harness 当前 active tools 和当前 runner
	 * appends 计算下一 turn 会看到的 system prompt；不缓存结果。
	 */
	getAgentSystemPrompt(agentId: AgentId): Promise<string>;

	// -----------------------------------------------------------------------
	// 输入与消息调度
	// -----------------------------------------------------------------------

	/**
	 * 所有 human/agent/background/system 输入的统一入口。
	 *
	 * 这一版给可信外壳（TUI/RPC）使用：它可以构造 human/system 来源。agent 身份
	 * 走 sendMessageFromAgent / ToolAgentHost，不允许调用方自填 agent source。
	 */
	sendMessage(draft: MessageDraft): Promise<MessageSendOutcome>;

	/** 人类 prompt 入口；走统一流水线，并等待这次 prompt 的 assistant 结果。 */
	promptAgent(
		agentId: AgentId,
		text: string,
		options?: PromptAgentOptions,
	): Promise<PromptOutcome>;

	/**
	 * 把文本直接放入目标 harness 的 steer queue。
	 *
	 * 已明确选择投递方式的低层入口：执行 AgentId gate、phase gate 和
	 * human-interrupt 协调，但不再跑 sendMessage 的 interception 与 session
	 * accounting。phase gate 不能省：harness.steer() 只在 phase 为 idle 时报错，
	 * compaction/branch_summary 期间它会被静默接受、压进没人读的队列。
	 * ExtensionActions.steer 也绑定到这里。
	 */
	steerAgent(
		agentId: AgentId,
		text: string,
		options?: AgentMessageInjectionOptions,
	): Promise<void>;

	/** 与 steerAgent 对称的低层入口；ExtensionActions.followUp 绑定到这里。 */
	followUpAgent(
		agentId: AgentId,
		text: string,
		options?: AgentMessageInjectionOptions,
	): Promise<void>;

	/**
	 * 把 harness 已持有的 follow-ups 提升为 steer，并同步 human-interrupt 语义。
	 *
	 * 保留它是因为它增加 WIDI 协调，不是纯 promoteFollowUpsToSteer 代理。
	 */
	steerQueuedFollowUps(agentId: AgentId): Promise<number>;

	/**
	 * 终止当前 harness operation，并同步处理被清空的 steer/follow-up（撤销它们的
	 * extension input presentation、唤醒投递队列）。
	 *
	 * 结果直接来自 harness；没有 aborted/running 镜像可更新。它现在也能中止
	 * compaction 与 branch summary，并在返回前等它们落地——但那两个相位在
	 * _requireHarnessOutsideMaintenance 就被拦下了，用户发起的 abort 到不了那里；
	 * 真正用到这个能力的是 dispose。
	 */
	abortAgent(agentId: AgentId): Promise<AbortResult>;

	/**
	 * 当前活动快照，供 TUI 的 /status 与编辑器可用性判断使用。
	 *
	 * 直接由 harness.getPhase() 映射：turn → running；compaction/branch_summary →
	 * running + maintenance kind；idle → idle。这个映射只对 live agent 成立：
	 * 已 shutdown 的 harness 同样报 idle，而 _live 未命中在此之前就已经把它挡掉。
	 */
	getAgentActivity(agentId: AgentId): AgentActivitySnapshot;

	/**
	 * core delivery queue 或 harness queues 是否仍有未读消息（同步）。
	 *
	 * 前者是 _messages.hasPending()，后者来自 harness.getQueuedMessageCounts()。
	 */
	agentHasPendingMessages(agentId: AgentId): boolean;

	/**
	 * extension context 当前是否可视为 idle（同步）。
	 *
	 * 判据是一次四来源的 join：phase 为 idle、harness 两个队列空、_messages 没有
	 * pending，且 _agentPromptRuns 里没有本类自己的 run 在飞。最后一项不能省：
	 * harness 在 agent_end 里先把 phase 置 idle 再 emit settled，而 prompt() 的
	 * promise 还要走完 finally 的第二次 flush 才 resolve，所以有一小段"phase 已
	 * idle、run 未结算"的窗口。
	 *
	 * 它仍然不是 harness.waitForIdle() 的同义词，但理由只剩一条了：waitForIdle
	 * 现在覆盖 compaction 与 tree navigation（两者都是 tracked operation），却仍然
	 * 不看任何队列——一个队列里压着 steer 的 harness 在 waitForIdle 眼里是 idle 的。
	 *
	 * 这个 join 跨 _live、harness 与 _messages，是消息域无法独立成类的直接原因。
	 */
	isAgentIdle(agentId: AgentId): boolean;

	/**
	 * 等到上面这个组合条件成立。
	 *
	 * 实现建在 harness.waitForIdle() 之上再补队列条件，不自己跟踪 maintenance 的
	 * 结束边沿：waitForIdle 等的是 operation task，与 idle 期的 session 写入
	 * （mutation task）不互相阻塞。dispose 或 generation 更替会让等待失败而不是
	 * 永久悬挂。
	 */
	waitForAgentIdle(
		agentId: AgentId,
		options?: { readonly signal?: AbortSignal },
	): Promise<void>;

	// -----------------------------------------------------------------------
	// Maintenance
	// -----------------------------------------------------------------------

	/**
	 * 运行 compaction 并使旧的 context-usage projection 失效。
	 *
	 * 并发由 harness 自己拒绝（compact() 要求 phase 为 idle），不再需要
	 * orchestrator 侧的 maintenance 登记表；释放后发布 reason 为 maintenance 的
	 * idle 边沿。
	 */
	compactAgent(
		agentId: AgentId,
		customInstructions?: string,
	): Promise<CompactResult>;

	/** 运行 session tree navigation，并在 branch 改变后使 context projection 失效。 */
	navigateAgentTree(
		agentId: AgentId,
		targetId: string,
		options?: NavigateAgentTreeOptions,
	): Promise<NavigateTreeResult>;

	// -----------------------------------------------------------------------
	// Background（薄转发：_live 查表 + 委托）
	// -----------------------------------------------------------------------

	/**
	 * 这四个都是 BackgroundJobRuntime 的窗口，orchestrator 只做一件事：确认 agentId
	 * 还 live，再把调用转过去。
	 *
	 * 它们留在这里而不是让 TUI 直连 background runtime，唯一的理由是 owner 归属是
	 * multi-agent 事实——"这个 job 属于谁、谁有权中止它"要用 _live 与 spawn tree 才能
	 * 回答，而 background runtime 只按 owner 键存，不认识树。
	 */
	listAgentBackgroundJobs(agentId: AgentId): readonly BackgroundJobSnapshot[];
	readAgentBackgroundJobOutput(
		agentId: AgentId,
		jobId: string,
	): string | undefined;
	abortAgentBackgroundJob(
		agentId: AgentId,
		jobId: string,
		reason?: string,
	): boolean;
	agentBackgroundJobHistory(
		agentId: AgentId,
	): readonly PersistedBackgroundJob[];

	// -----------------------------------------------------------------------
	// Extensions
	// -----------------------------------------------------------------------

	/** 向 extension loader 注册一个进程内 extension module。 */
	registerExtension(extensionId: string, module: ExtensionModule): () => void;

	/**
	 * 刷新 extension catalog，并为选中的 live agents 事务式替换 runner。
	 *
	 * skip 判定直接读 harness.getPhase()：turn 与两种 maintenance phase 都跳过，
	 * _live 未命中视为 gone。replacement 同时覆盖 tool define/patch、provider
	 * registrations、system-prompt appends、harness interceptors、observed/event
	 * subscribers、ExtensionActions/session context 和 onDispose；任何一步失败都不能
	 * 留下"新 tools + 旧 runner"之类的混合 generation。
	 */
	reloadExtensions(options?: {
		readonly agentIds?: readonly AgentId[];
	}): Promise<ExtensionReloadResult>;

	/**
	 * 该 agent 这一代 runner 里每个 extension 的加载/失败状态。
	 *
	 * 按 agent 分，因为同一个 extension 在不同 agent 上可以有不同结果（profile 决定
	 * 启用集合）。reload 换代时整组重置，不保留上一代的失败记录。
	 */
	listExtensionStatuses(agentId: AgentId): readonly ExtensionStatusSnapshot[];

	// -----------------------------------------------------------------------
	// Human requests
	// -----------------------------------------------------------------------

	/**
	 * 向人类提问并等待回答，以及取消一个未答复的提问。
	 *
	 * 它必须经过 orchestrator 而不是让 tool 直接问 TUI：请求要按 agent 归属登记，
	 * 这样 dispose 或 shutdown 才能把该 agent 名下所有未答复的提问一次性取消掉——
	 * 否则一个被销毁的 agent 会留下一个永远等不到人的 await。
	 */
	requestHuman(request: HumanRequest): Promise<HumanResponse>;
	cancelHumanRequest(requestId: string, reason?: string): Promise<boolean>;

	// -----------------------------------------------------------------------
	// Events、clients 与 runtime shutdown
	// -----------------------------------------------------------------------

	/**
	 * 三种订阅形态，都返回退订函数。
	 *
	 * client 是有身份的长连接消费者（TUI、RPC），listener 是匿名旁观者，
	 * subscribeAgent 是按 AgentId 过滤的旁观者。分三种是因为失败隔离不同：一个
	 * listener 抛错只影响它自己，一个 client 掉线要触发它自己的清理。
	 *
	 * 所有事件都经 OrchestratorEventBus 发出，orchestrator 不自己维护订阅表。
	 */
	registerClient(client: OrchestratorClient<OrchestratorEvent>): () => void;
	subscribe(listener: OrchestratorEventListener): () => void;
	subscribeAgent(
		agentId: AgentId,
		listener: OrchestratorEventListener,
	): () => void;

	/**
	 * 发布一次 runtime shutdown request；真正退出进程仍由外部 host 决定。
	 *
	 * shutdown observed handlers 必须先完成，再通知可能立即 disposeAll 的 host
	 * client，给 extensions 最后一次持久化/清理机会。
	 */
	requestShutdown(request: RuntimeShutdownRequest): Promise<void>;

	// -----------------------------------------------------------------------
	// Private：spawn / resume / dispose
	// -----------------------------------------------------------------------

	/**
	 * 按 origin 解析出一个 build request：profile、override、session、model、
	 * thinking、settings 快照与 tool policy 初值。
	 *
	 * new：分配可读 AgentId（避开 tombstone 与树里已记录的 id），建 session；
	 * resume：解析 reference 或 metadata，复用 session 记录的 id；
	 * fork：从 source 的 live session fork 出新 session，用新 session id。
	 *
	 * 返回纯 build request，不注册半成品 live resource。
	 */
	private _resolveAgentBuild(
		options: SpawnAgentOptions,
	): Promise<AgentBuildRequest>;

	/**
	 * 在局部变量中创建 background attachment、runner、tools、harness 并绑定
	 * actions/interceptors；成功前不触碰 live registry。
	 *
	 * 顺序：attach background、activate runner、应用 provider contributions、用
	 * runner contributions 解析 scoped tools、创建 harness、绑定 bindings。每个
	 * await 之后检查 reservation.cancelled；任一步失败或被取消都按相反顺序释放。
	 */
	private _buildLiveAgent(
		request: AgentBuildRequest,
		reservation: AgentCreationReservation,
	): Promise<LiveAgentBuild>;

	/**
	 * 无 await 地安装 LiveAgent、分配新 generation、清 tombstone、写 _spawnParent。
	 *
	 * 这是 spawn 的唯一 routing cutover：_live 里出现即可路由，没有"先建目录项、
	 * 再补 harness"的中间态。resume 在这里把同 id 从 _tombstones 移除。
	 */
	private _installLiveAgent(build: LiveAgentBuild): AgentId;

	/**
	 * 释放一次失败或被取消的构建：detach background、dispose 候选 runner、撤销
	 * bindings、shutdown 半成品 harness，并发布 diagnostic。
	 *
	 * 用 shutdown() 而不是 abort()：这个 harness 从未可路由，也永远不会变成可路由，
	 * 但构建期已经可能给它绑过 interceptor 或写过 session。封死它比让它保持可用
	 * 更接近事实。
	 *
	 * 什么都不发布：构建失败的 agent 不进 _live，**也不写 _tombstones**——它从未
	 * 存在过，那个 AgentId 仍可被后续 spawn 使用。失败通过抛出的 OrchestratorError
	 * 回到发起调用的界面。
	 */
	private _releaseFailedBuild(
		agentId: AgentId,
		build: Partial<LiveAgentBuild>,
		error: unknown,
	): Promise<void>;

	/**
	 * resume 后、可路由前，把上一次运行遗留的未答复 t0 handle 补进 session。
	 *
	 * 读 BackgroundJobRuntime.carriedOverJobs，用 harness.appendMessage 直接写入
	 * 分支：晚于可路由就会变成"模型读到一条过期结果并可能起一个没人要的 run"。
	 *
	 * 此刻 harness 必然 idle，所以写入立即落盘并返回 entry id；它排在 harness 的
	 * 写入尾上，与随后开放路由后的任何写入天然有序。
	 */
	private _reconcileCarriedOverJobs(agentId: AgentId): Promise<void>;

	/** 合并重复 dispose、snapshot subtree，并生成确定的 leaf-to-root 计划。 */
	private _planDisposal(
		agentId: AgentId,
		options: DisposeAgentOptions,
	): AgentDisposalPlan;

	/**
	 * 无 await 地完成 cutover：从 _live 删除、写 _tombstones、detachAgent。
	 *
	 * _spawnParent 不删：这条边要留给存活的后代。resources/systemPrompt 随被丢弃的
	 * LiveAgent 一起消失，不需要单独清空。
	 *
	 * detach 的位置是 background runtime 的硬性契约（标记 disposing 之后、其他
	 * teardown 之前）。
	 */
	private _cutOverDisposed(
		plan: AgentDisposalPlan,
	): readonly DisposedLiveAgent[];

	/**
	 * 用 cutover 前保存的局部引用释放 harness、runner、bindings 和外围 workflows；
	 * 失败只记 diagnostic，不恢复 live routing。
	 *
	 * harness 两步，顺序是正确性的一部分：**先 abort() 再 shutdown()**。
	 *
	 * - abort() 让被中断的那一轮走完自己的 finally，把缓冲的 session 写入 flush
	 *   出去；它现在也真的能取消 compaction 与 branch summary（两者都拿 operation
	 *   signal），并在返回前等它们落地。
	 * - shutdown() **丢弃** pendingSessionWrites，所以它永远不能替代 abort()；它
	 *   负责封死这个 harness，并等所有 idle 期写入（mutation task）落盘。
	 *
	 * 两个调用都幂等：重复 dispose 时 abort() 会等 shutdown 完成并返回空结果。
	 *
	 * 顺序还有第二条：**先 cancel 投递队列，再拆 harness**。队列被 cancel 会把数组
	 * 换掉，重投逻辑据此把已经无处可去的消息判为 target_unavailable；反过来先拆
	 * harness，那些消息会先撞上 shutdown 码再被 cancel 收尾，多绕一圈。
	 *
	 * **约束：shutdown() 只能是 disposal 的尾巴。** abort() 不是 tracked task，
	 * 所以一次与它并发的 shutdown 可以在它发出最后那个 abort 事件之前就清空订阅表，
	 * 事件被静默丢弃。今天这无害，因为唯一的并发来源就是这次 disposal，而那个事件
	 * 的全部消费者（presentation 撤销、idleReason、activity 边沿、idle 结算）都带
	 * generation 校验且目标已不在 _live，本来就不会产生可见效果。这条无害性依赖的
	 * 正是"shutdown 不会在 disposal 之外发生"。若将来出现"封存 harness 但保留
	 * agent"之类的用法，必须**先**把 abort() 纳入 harness 的 lifecycle task（或让
	 * 两者共享一条 teardown promise），再引入那种用法。
	 *
	 * shutdown() 是无界等待——它等的是 operation 的 finish，而那取决于每个被 await
	 * 的 tool 是否真的响应 abort signal（ask_human 在 tool call 内等真人是已知的
	 * 反例）。这里必须自带超时：超时后放弃等待、记 diagnostic 并继续 teardown，
	 * 不要恢复 routing。harness 已经封住了后续写入，超时的代价是有界的。
	 */
	private _disposeLiveAgent(
		disposed: DisposedLiveAgent,
		options: DisposeAgentOptions,
	): Promise<void>;

	/** 为新 profile 生成可读、且不与 tombstone 或树记录冲突的 AgentId。 */
	private _allocateAgentId(profile: AgentProfile): AgentId;

	/** 验证 parent 存在、未 disposed、非自身、不成环，且允许创建 child。 */
	private _assertAgentCanParent(parentAgentId: AgentId): void;

	/** 沿稳定 spawnedBy tombstones 找到一个 agent 所属 spawn tree 的根。 */
	private _resolveAgentTreeRoot(agentId: AgentId): AgentId;

	/** 判断两个 AgentId 是否属于同一个 runtime-local spawn tree。 */
	private _agentsShareTree(
		firstAgentId: AgentId,
		secondAgentId: AgentId,
	): boolean;

	/** 对 subtree 做 cycle-safe snapshot，并返回确定的 leaf-to-root 顺序。 */
	private _collectAgentSubtreePostOrder(agentId: AgentId): readonly AgentId[];

	// -----------------------------------------------------------------------
	// Private：spawn tree 持久化
	// -----------------------------------------------------------------------

	/**
	 * install 之后向 root 的 agents/tree.jsonl 追加 spawned，并向 child 目录写
	 * agents/parent.json。
	 *
	 * 反向指针必须写：树索引是单向的，而 session picker 会列出 child 的 session。
	 * 没有它，用户直接打开一个 child session 会得到一个孤立的 top-level agent；
	 * 之后再 resume 它的 root，同一个 session 会被打开两次。
	 *
	 * 写失败只记 diagnostic，不回滚 install——一个能用但不可恢复的 agent 好过一个
	 * 不存在的 agent。root 不可持久时整棵树不做持久化，并发一条 diagnostic。
	 */
	private _recordAgentSpawnedInTree(build: LiveAgentBuild): Promise<void>;

	/** intent 为 removed 时向 root 追加 removed；runtime_shutdown 什么都不写。 */
	private _recordAgentRemovedFromTree(
		agentId: AgentId,
		intent: AgentDisposeIntent,
	): Promise<void>;

	/**
	 * 读取一个 root session 目录的树记录并归约出仍为 live 的成员。
	 *
	 * SessionManager 只提供 append/replay 与按目录名打开 session 的原语；归约、
	 * 顺序与重映射都在这里。
	 */
	private _planAgentTreeResume(
		rootSessionDir: string,
	): Promise<readonly AgentTreeMember[]>;

	/**
	 * 把 append-only 记录归约成成员表：spawned 建立成员，removed 移除它，重复
	 * 记录以最后一条为准。日志是追加写的，所以顺序即真相。
	 */
	private _reduceAgentTreeRecords(
		records: readonly AgentTreeRecord[],
	): readonly AgentTreeMember[];

	/**
	 * eager 恢复整棵树：root 先，然后按记录顺序逐个 resume。
	 *
	 * 记录的 AgentId 跨进程会重复，被占用时重新分配并记进 remapped——不重映射的
	 * 话，父的历史里写着 coder-2，而 send_message("coder-2") 会打到别的 agent 上。
	 * 单个成员失败只记 diagnostic 并进 failed，不影响 root 与其他成员。
	 */
	private _resumeAgentTree(
		rootAgentId: AgentId,
		members: readonly AgentTreeMember[],
	): Promise<AgentTreeResumeOutcome>;

	/**
	 * 把树恢复结果与 carried-over job 的对账合并成一条系统消息注入 root 的分支。
	 *
	 * 内容：哪些 child 恢复了、哪些没有（ephemeral 或失败）、哪些 id 被重映射。
	 * 部分恢复是常态，模型必须被告知，否则它会继续对着不存在的地址发消息。
	 */
	private _publishTreeResumeReconciliation(
		outcome: AgentTreeResumeOutcome,
	): Promise<void>;

	/**
	 * 用户直接 resume 一个 child session 时，读它的 parent.json 找回 root。
	 *
	 * 找到就改为恢复整棵树并把视图切到该 child；找不到（老数据或 root 已删）就作为
	 * top-level 恢复并发一条 diagnostic。
	 */
	private _resolveResumeRoot(
		sessionDir: string,
	): Promise<AgentParentPointer | undefined>;

	// -----------------------------------------------------------------------
	// Private：registry、snapshot 与不变量
	// -----------------------------------------------------------------------

	/**
	 * 唯一的 agent 查表入口，一次给出完整门控答案。
	 *
	 * _live 命中即可路由；未命中时按 _tombstones / _agentCreations 分辨 gone 与
	 * creating，都不命中就是 unknown。没有第二次跨表 join：命中的对象上同时挂着
	 * harness、profile、settings、runner。
	 */
	private _resolveAgent(agentId: AgentId): AgentLookup;

	/** _resolveAgent 的 live 分支；其余三种结果一律抛出对应的 OrchestratorError。 */
	private _requireLiveAgent(agentId: AgentId): LiveAgent;

	/**
	 * 取 harness，并拒绝那些"接得下但没人读"的相位。
	 *
	 * steerAgent / steerQueuedFollowUps / followUpAgent / abortAgent 四个入口共用它，
	 * 取代旧的 _requireAgentOutsideMaintenance + _requireAgentHarness 两行。
	 *
	 * 它**只拒绝** compaction 与 branch_summary：
	 *
	 * - idle 留给 harness。steer()/followUp()/promoteFollowUpsToSteer() 已经对 idle
	 *   抛 invalid_state，我们再判一次是把同一个条件写两遍。分工是 harness 覆盖
	 *   idle、我们覆盖它覆盖不到的两个 maintenance phase，每个条件只有一个产生者。
	 * - abort 在 idle 必须放行：那是一次有意义的队列清空，不是错误。正因为这里只拦
	 *   maintenance，四个入口才能共用同一个 helper。
	 * - 已 shutdown 的 harness 不需要在这里判：它到不了这一步，_live 未命中在
	 *   _requireLiveAgent 就已经抛了。真漏过来也只是拿到一个 shutdown 码。
	 */
	private _requireHarnessOutsideMaintenance(
		agentId: AgentId,
		action: string,
	): WidiAgentHarness;

	/** 在读取时组合 LiveAgent、harness phase、runner、diagnostics 与 context。 */
	private _snapshotAgent(liveAgent: LiveAgent): AgentSnapshot;

	/**
	 * 验证三张表互不矛盾：_live 与 _tombstones 不相交，_spawnParent 的每个 parent
	 * 要么 live 要么是 tombstone（不能指向 unknown）。供高风险 lifecycle 边界和测试
	 * 使用，不参与业务分支。
	 */
	private _assertRegistryInvariant(agentId?: AgentId): void;

	// -----------------------------------------------------------------------
	// Private：harness、tools 与 prompt 装配
	// -----------------------------------------------------------------------

	/**
	 * 根据 LiveAgent.systemPrompt、harness 传入的 active tools 和当前 runner appends
	 * 组合 system prompt。
	 */
	private _composeAgentSystemPrompt(
		agentId: AgentId,
		activeTools: readonly ToolPromptGuidance[],
	): string;

	/**
	 * 用 base registry、给定 toolPolicy 和当前 runner contribution 解析一组真正交给
	 * harness 的 tools，并回传新的 toolPolicy。
	 */
	private _resolveAgentTools(
		agentId: AgentId,
		policy: AgentToolPolicy,
		runner: ExtensionRunner,
	): Promise<ResolvedAgentTools>;

	/**
	 * 浅 clone base registry，再按 runner registration order 应用 extension
	 * defineTool/patchTool；tool definitions 和大型 backend 仍共享引用。
	 *
	 * ToolRegistry 本身不持有任何 per-agent 状态。
	 */
	private _createScopedToolRegistry(runner: ExtensionRunner): ToolRegistry;

	/**
	 * 为一次 harness turn 创建 WIDI tool context。
	 *
	 * 只放三样东西：scoped host（身份闭包捕获）、human-interrupt watch，以及本 turn
	 * 起始时的 runner generation 工厂。core tools 与 extension tools 拿的是同一个
	 * 对象，所以这里的成员就是 tool 层能力上限——orchestrator 本体、executionEnv、
	 * sessionManager 都不在其中。
	 */
	private _createToolAdapterContext(
		agentId: AgentId,
		profileId: string,
	): ToolAdapterContext;

	/**
	 * 绑定 harness 原始事件与释放句柄。
	 *
	 * 订阅回调内同步完成必须立即生效的捕获（per-run abort signal、run-start
	 * waiter），其余异步扇出排到 per-agent 串行 tail。harness 是 await 订阅者的
	 * （emitOwn/emitAny 逐个 await，agent_end 要等到 listener 全部 settle），所以
	 * 扇出直接做会把 agent loop 卡在我们的下游；排到 tail 上既不阻塞它，又保住
	 * listener 看到的顺序等于 harness 产生的顺序。
	 *
	 * 返回的 release 句柄仍然必须能独立撤销本代订阅：shutdown() 会自己清空订阅表，
	 * 但 extension reload 换代时没有 shutdown，release 是那条路径上唯一的出口。
	 */
	private _bindHarness(
		agentId: AgentId,
		generation: number,
		harness: WidiAgentHarness,
	): Promise<() => Promise<void>>;

	// -----------------------------------------------------------------------
	// Private：ExtensionRunner lifecycle 与全部插入点
	// -----------------------------------------------------------------------

	/**
	 * 按 settings/divisions 激活 extension factories，收集 tools、providers、prompt
	 * appends、interceptors、observers、event handlers 和 onDispose。
	 *
	 * 这里只创建候选 runner；未 bind 前不能从 live registry 被看到。
	 */
	private _createExtensionRunner(
		agentId: AgentId,
		profileId: string,
	): Promise<ExtensionRunner>;

	/**
	 * 把 runner 绑定到 core，并返回一个 generation-scoped release handle。
	 *
	 * binding 包含两类 ports：
	 * - ExtensionCoreActions：tools/jobs/human/presentation/diagnostics、
	 *   prompt/steer/followUp、context/system-prompt/pending/idle、extension
	 *   events、shutdown/dispose、session/model/thinking/compact/abort/exec；
	 * - ExtensionContextActions：当前 run signal、isIdle、namespaced session
	 *   reads/writes、cross-session trust gate 和 action-failure diagnostics。
	 */
	private _bindExtensionRunner(
		agentId: AgentId,
		generation: number,
		harness: WidiAgentHarness,
		runner: ExtensionRunner,
	): Promise<ExtensionRunnerBindings>;

	/**
	 * 创建 runner author actions 到 host/runtime services 的映射。
	 *
	 * 一张共享 action table；runner 再注入自己的 agentId/extensionId，不为每个 tool
	 * 创建大型 service 实例。
	 */
	private _createExtensionCoreActions(): ExtensionCoreActions;

	/**
	 * 创建当前 runner generation 的 signal、idle、session 和失败报告 ports。
	 *
	 * run signal 来自 _agentRunSignals；session actions 保留 extension namespace；
	 * 跨 session reads 和 exec 仍走 project-trust gate。
	 */
	private _createExtensionContextActions(
		agentId: AgentId,
		generation: number,
	): ExtensionContextActions;

	/**
	 * 在 harness 上注册现有五个可变换 hook：before_agent_start、
	 * before_provider_request、context、tool_call、tool_result。
	 *
	 * context hook 仍与 core blockImages policy 顺序组合（blockImages 取自这一代的
	 * AgentSettings）；release 只撤销这个 runner generation 的 handlers。
	 */
	private _registerExtensionHarnessInterceptors(
		agentId: AgentId,
		harness: WidiAgentHarness,
		runner: ExtensionRunner,
	): () => void;

	/** 执行一个 runner interceptor，记录 handler diagnostics，并返回组合结果。 */
	private _runExtensionInterceptor<TName extends ExtensionInterceptorName>(
		agentId: AgentId,
		runner: ExtensionRunner,
		event: ExtensionInterceptorEventFor<TName>,
	): Promise<ExtensionInterceptorResultFor<TName>>;

	/**
	 * 在任何 human/agent/background/system 消息进入 delivery queue 前运行
	 * ExtensionRunner input pipeline，保留串行 transform、首个 block 和 fail-closed
	 * diagnostics 语义。input 不在 harness hook 里，因为它位于 harness 之外的
	 * sendMessage ingress。
	 */
	private _interceptExtensionInput(
		agentId: AgentId,
		event: ExtensionInputEvent,
	): Promise<ExtensionInputInterceptRun>;

	/**
	 * 安装 runner 的 provider contributions；command config 仍受 project trust
	 * gate，冲突和非法 provider 仍形成 attributed diagnostics。
	 */
	private _applyExtensionProviderContributions(
		agentId: AgentId,
		runner: ExtensionRunner,
	): Promise<void>;

	/** 撤销这个 agent 当前 runner 注册的 providers，不影响其他 agents。 */
	private _withdrawExtensionProviderContributions(
		agentId: AgentId,
	): Promise<void>;

	/**
	 * 为 ExtensionActions.steer/followUp 关联可持久化 presentation。
	 *
	 * presentation 在对应 user message 真正进入 session 后提交；投递失败或 abort
	 * 清队列时撤销，且 presentation events 不反向喂给 extension observers。
	 *
	 * "对应哪一条"由 harness 的 session_write 事件给出——它带着 entry id 与写入本身，
	 * 消息进入 session 的那一刻就能配对。不要再按对象身份反扫 session：那既是
	 * O(session) 的，也在 session 重新 hydrate 后失效。
	 */
	private _withExtensionInputPresentation(
		agentId: AgentId,
		extensionId: string,
		method: "steer" | "follow_up",
		presentation: ExtensionInputPresentation | undefined,
		deliver: () => Promise<void>,
	): Promise<void>;

	/**
	 * 为一个 live agent 构建 candidate runner，用当前 toolPolicy 重解析 tools，安装
	 * 新的 actions、interceptors 和 providers，再原子替换 LiveAgent 的
	 * extensionRunner/extensionBindings/toolPolicy。
	 *
	 * 成功后 invalidate/dispose 旧 runner 并运行 onDispose；失败则释放 candidate 并
	 * 恢复原 runner、tools 和 bindings。已开始的 turn 继续持有旧 generation 并看到
	 * 明确 stale error。旧 status/presentation bindings 一并清理，但新 runner 在安装
	 * 后发布的状态不能被旧 generation 的 cleanup 误删。
	 */
	private _reloadLiveAgentExtensions(
		agentId: AgentId,
	): Promise<ExtensionReloadAgentResult>;

	/**
	 * 使 runner context stale，撤销 bindings/provider leases，执行全部 onDispose，
	 * 并释放它持有的 handler/module closures。
	 */
	private _disposeExtensionRunner(
		agentId: AgentId,
		runner: ExtensionRunner,
		bindings: ExtensionRunnerBindings,
		reason: string,
	): Promise<void>;

	// -----------------------------------------------------------------------
	// Private：消息与 harness operation arbitration
	// -----------------------------------------------------------------------

	/**
	 * 一条输入的完整 ingress：跑 transformMessage（其 intercept port 读
	 * LiveAgent.extensionRunner）、写 session accounting 条目、渲染来源信封，
	 * 最后交给 _messages.enqueue。
	 *
	 * 这一整段留在本类而不是切给一个消息域，因为它每一步的依赖都在本类：拦截要
	 * runner，写入要 harness，发 input_blocked/input_transformed 要 event bus。
	 * 切一刀出去，每条消息都要在两侧来回穿四次。
	 *
	 * requiresFreshPrompt 只表达调用者是否必须获得本次 assistant result。
	 *
	 * session accounting 指命令展开与 input transform 这类条目：内容在这里组装，
	 * 写入走 harness.appendCustomEntry()。目标在 turn 中时它会被缓冲到下一个 save
	 * point，所以不再有"抢在 harness 缓冲的写入之前插进分支"的倒序，投递失败时那条
	 * 也从未落盘，不需要 moveTo() 回退叶子。
	 */
	private _routeMessage(
		draft: MessageDraft,
		options: RouteMessageOptions,
	): Promise<AcceptedMessage>;

	/** 第一层 availability gate，返回 harness、generation 与当场读到的 phase。 */
	private _resolveDeliveryTarget(agentId: AgentId): DeliveryTarget;

	/**
	 * _messages 的 deliver port：队列决定轮到哪一批时回调进来。
	 *
	 * 方法选择直接由 phase 决定：idle → prompt，turn → steer/follow_up（按 mode），
	 * compaction/branch_summary → defer。读 phase 与调用之间的竞态才由 typed
	 * harness error 兜底重试。不能只靠错误仲裁：对 idle 目标先调 followUp 会拿到
	 * 可重试的 invalid_state，消息将无限期 defer。
	 *
	 * 重试集合是 busy 与 invalid_state 两个码，都描述"等一会儿就能过去的相位"。
	 * shutdown 码不在其中，它是终态：这条循环的终止条件因此写在错误里，而不是
	 * 依赖"每次重试都重新 _resolveDeliveryTarget，迟早会发现 _live 已经没有它"
	 * 这个附带效果——重新查表仍然要做（它决定 phase），但不再是唯一的出口。
	 *
	 * background job result 的 retryOnFailure 盖过"不可重试"的判断（它没有调用方
	 * 可以报错），但**不盖过终态**：对着一个已 shutdown 的 harness 等相位变化，等
	 * 到的只会是 dispose 顺手做的那次 cancel。
	 */
	private _deliverQueuedMessage(
		request: QueuedMessageDelivery,
	): Promise<MessageDeliveryReceipt>;

	/**
	 * 发起必须产生 assistant result 的 fresh prompt。
	 *
	 * acceptance 等 harness 自己的 agent_start，与 run promise 的 rejection 赛跑：
	 * harness 在 agent_start 之前的全部异步工作都可能失败，而失败意味着 user
	 * message 从未落盘。过早 resolve 会让队列丢掉一条模型正在等的 background job
	 * t1。phase 导出替代不了这一条：phase 在 prompt() 第一行就变成了 turn。
	 */
	private _startPrompt(
		target: DeliveryTarget,
		request: PromptDeliveryRequest,
	): Promise<MessageDeliveryReceipt>;

	/**
	 * 由 harness 事件驱动的活动边沿检测：决定是否发布 agent_status_changed /
	 * agent_idle，并唤醒投递队列。
	 *
	 * 活动值本身来自 harness（phase + 队列计数），事件只提供"边沿发生了"这个时机
	 * 与 idleReason 所需的因果（abort、turn_end 的 stopReason、maintenance 释放）。
	 *
	 * idle 的判据是一次 join：phase 为 idle、harness 两个队列空、_messages 没有
	 * pending、且没有本类自己的 prompt run 在飞；agent_idle 的 payload 还要
	 * _backgroundJobs 的 liveJobCount。跨三个来源的判断只能在这里做，这也是消息
	 * 域切不出去的根本原因。_agentIdleWaiters 与 _publishedAgentIdles 读同一个
	 * 判据，两类消费者不会给出不同答案。
	 */
	private _observeHarnessActivity(
		agentId: AgentId,
		generation: number,
		event: AgentHarnessEvent,
	): Promise<void>;

	/**
	 * 运行一个不驱动 agent loop 的 harness 操作（compaction、tree navigation）。
	 *
	 * 并发由 harness 拒绝（phase 不是 idle 就抛 busy），这里只负责发布活动边沿、
	 * 在结束时使 context projection 失效，并让 idle 的 reason 记为 maintenance。
	 *
	 * 不要恢复旧的 record.status 前置检查：它落后于 harness 一个事件广播，settled
	 * 之后的那个窗口里 harness 已能接受 compact，它却报 busy。
	 *
	 * 顺序是正确性的一部分：必须**先启动 harness 操作，再 await 活动边沿的发布**。
	 * compact()/navigateTree() 在第一行同步翻 phase，先发事件就会留下一个"表已经说
	 * maintenance、phase 还说 idle"的窗口，而表已经不存在了，落在这个窗口里的 steer
	 * 会穿过 phase 守卫。中间那个 await 抛出时，先启动的 promise 必须显式接住再重抛，
	 * 否则是 unhandled rejection。
	 */
	private _runMaintenanceOperation<T>(
		agentId: AgentId,
		operation: (harness: WidiAgentHarness) => Promise<T>,
	): Promise<T>;

	// -----------------------------------------------------------------------
	// Private：事件驱动的外层协调
	// -----------------------------------------------------------------------

	/**
	 * 接收 harness 原始事件，依次通知 message、human-interrupt、extension、context
	 * monitor 和外部 event bus。
	 *
	 * 带 generation：上一代 harness 的尾巴事件不得写进新一代的投影。
	 */
	private _handleHarnessEvent(
		agentId: AgentId,
		generation: number,
		event: AgentHarnessEvent,
		signal?: AbortSignal,
	): Promise<void>;

	/**
	 * 将一个已发布的 observable event 投递给目标 runner 的 observe handlers。
	 *
	 * runtime_shutdown_requested 广播给所有 live runners；stale runner 跳过；handler
	 * failures 进入 diagnostics，extension-published diagnostics 和 presentation
	 * events 不回流，避免递归。
	 */
	private _dispatchExtensionObservedEvent(
		event: ExtensionObservedEvent,
	): Promise<void>;

	/**
	 * 把一个具名 extension event 广播给所有 live runners 的订阅者。
	 *
	 * 保留 immutable payload、source attribution、同 runtime 自接收和有界递归深度；
	 * runner reload/dispose 自然替换订阅集合。
	 */
	private _emitExtensionEvent(envelope: ExtensionEventEnvelope): Promise<void>;

	/**
	 * 统一向 clients/listeners 发布事件，并按事件白名单衔接 extension observers。
	 *
	 * listener failure 被隔离；调用者可以显式禁止 observer 回流。
	 */
	private _publishEvent(
		event: OrchestratorEvent,
		options?: PublishEventOptions,
	): Promise<void>;

	/**
	 * 接收 BackgroundJobRuntime 的 t1 delivery port 请求，并送入普通消息入口。
	 *
	 * 不查询 job record，也不决定 job lifecycle。
	 */
	private _deliverBackgroundResult(
		delivery: BackgroundJobDelivery,
	): Promise<BackgroundJobDeliveryReceipt>;

	/**
	 * 给 extension/agent 等已绑定 AgentId 的调用者发 human request。
	 *
	 * AgentId 只用于 lifecycle cancellation 和 diagnostics attribution。
	 */
	private _requestHumanForAgent(
		agentId: AgentId,
		request: HumanRequest,
	): Promise<HumanResponse>;
}

// ---------------------------------------------------------------------------
// 协作者边界
// ---------------------------------------------------------------------------

/**
 * orchestrator 之外只有这几个模块，本文不设计它们的方法：
 *
 * 独立 runtime（各自维持一份不变量，都不查 _live）：
 *
 * - BackgroundJobRuntime（`core/background/`，已落地）：job lifecycle、journal、
 *   output、report、per-owner ordering、attach/detach 与 generation 校验。
 * - OrchestratorEventBus（`orchestrator/event-bus.ts`，已落地）：listeners、
 *   clients、listener failure isolation。
 * - AgentContextMonitor（`orchestrator/context-monitor.ts`，已落地）：
 *   session-derived context usage 的计算、generation 校验与 publish 去重。
 * - AuthRuntimeController（`orchestrator/auth-controller.ts`，已落地）：
 *   OAuth/login/logout、credential refresh 与登录期的 human prompts。
 * - HumanRequestBroker / HumanInterruptRegistry（`core/human-request.ts`、
 *   `core/human-interrupt.ts`，已存在）：人类请求的登记与取消语义；人类 steer
 *   是否已被 harness 读取。
 *
 * 被调用的工具与类型（不是并列的域）：
 *
 * - MessageDeliveryQueue（`core/message.ts`）：per-target FIFO、merge、失败重排。
 *   两个 port，不认识 agent registry。它旁边的 transformMessage /
 *   decideMessageDelivery / renderMessageEnvelope 都是纯函数。
 * - ExtensionStatusRegistry（`core/extension/status-registry.ts`）：按 agent 与
 *   runner generation 保存 extension 加载状态，换代整组重置。
 * - `orchestrator/host.ts`、`orchestrator/types.ts`：ToolAgentHost、LiveAgent、
 *   AgentSnapshot 等类型，无状态。
 *
 * 扩权的既有模块：
 *
 * - SessionManager：会话的打开、目录布局与只读查询，spawn tree 的 IO 原语
 *   （appendAgentTreeRecord / readAgentTreeRecords / writeAgentParentPointer /
 *   readAgentParentPointer / openSessionByDir），以及候选列表里的 isChild 标记。
 *   它不知道什么是 spawn tree 语义——归约、顺序、id 重映射都在 orchestrator。
 *   **它不再向 live agent 的分支写入**：appendCommandExpansionEntry 这一类方法连同
 *   retractAgentSessionEntries 一起消失，写入是 harness 的事；tree.jsonl 与
 *   parent.json 是 session 目录里的旁路文件，不属于分支，仍归它写。
 *
 * 明确不创建的：AgentMessageRuntime、AgentExtensionRuntimeSupport、
 * AgentDiagnosticLedger。前两个的核心判断要 join _live 与 harness phase 才成立，
 * 第三个只是一张 Map。理由见文件头的判据与 _messages / _extensionStatuses /
 * _agentDiagnostics 三处注释。
 *
 * 以上没有一个是 AgentHarness wrapper，也没有一个保存 model、tools、phase 或队列
 * 计数的副本。
 */
