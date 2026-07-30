/**
 * AgentOrchestrator 目标形态（架构伪代码）
 *
 * 这不是可编译实现，也不参与 apps/widi-pi 构建。所有方法都只有签名和中文职责
 * 注释，用于直接审阅重构后的类面。
 *
 * 设计基线：
 *
 * - AgentOrchestrator 继续是 TUI、RPC、extensions 和 agent tools 面对的外层中枢。
 * - AgentHarness 是单个 live agent 的执行权威，不再被 orchestrator 重新包装。
 * - AgentRecord 只保存相对固定的构建事实和 disposed tombstone。
 * - LiveAgent 只持有 AgentHarness、ExtensionRunner 及其绑定释放句柄。
 * - ExtensionRunner 现有的 tools、providers、system-prompt appends、
 *   interceptors、observers、actions、session context 和 reload stale boundary
 *   全部保留；精简只改变装配位置，不缩减 extension author API。
 * - BackgroundJobRuntime、消息流水线、事件分发、诊断、context projection 各自
 *   管理自己的状态，orchestrator 只调度它们。
 *
 * 本类刻意不保存：
 *
 * - 当前 model、thinking、installed/active tools 等 AgentHarness 运行值副本；
 * - running/idle status、prompt-run mirror、queue-count mirror；
 * - BackgroundJobTable、job store、job progress/report/emission tail；
 * - _disposingAgents 或多条件 idle resolver；
 * - extension input presentation、diagnostic fan-out 等细节状态机。
 *
 * model、thinking、tools、steer、followUp、abort、hasPendingMessages 和
 * waitForIdle 的查询/修改方法仍是 orchestrator 正式 API。状态由 harness
 * 唯一拥有，但 TUI/RPC/ExtensionActions 需要稳定的 AgentId 路由、policy 与
 * 跨域副作用边界；不能因为方法最终读写 harness 就把这一层删掉。
 *
 * 对应说明：agent-harness-ownership-plan.md
 */

// ---------------------------------------------------------------------------
// 新的核心形状
// ---------------------------------------------------------------------------

/**
 * AgentHarness 创建过程中确定、之后不再随运行变化的事实。
 *
 * diagnostics、context usage、当前 model/tools/runner 不属于这里。
 */
interface AgentRecord {
	readonly agentId: AgentId;
	readonly profile: AgentProfileRecordReference;
	readonly resolvedProfile?: AgentProfile;
	readonly spawnedBy?: AgentId;
	readonly sessionMetadata?: AgentSessionMetadata;
	readonly createdWithModel: RuntimeModel;
	readonly resources?: AgentResourcesSnapshot;
	readonly systemPrompt?: AgentSystemPromptFacts;
	disposed: boolean;
}

/**
 * 当前可执行的 agent generation。
 *
 * 两个 release 句柄只表达订阅和 contribution lease 的生命周期，不保存业务
 * 状态，也不提供 harness 的代理方法。extension reload 只替换 runner 及其
 * binding，harness 本身不换代。
 */
interface LiveAgent {
	readonly harness: WidiAgentHarness;
	extensionRunner: ExtensionRunner;
	extensionBindings: ExtensionRunnerBindings;
	readonly releaseHarnessBindings: () => Promise<void>;
}

/**
 * 当前 ExtensionRunner 安装到 core 后产生的可撤销连接。
 *
 * 包括 harness interceptors、provider contributions，以及 runner context
 * actions；它不拥有 runner，也不保存 extension 业务状态。
 */
interface ExtensionRunnerBindings {
	readonly release: () => Promise<void>;
}

/** spawn 对外返回真实 harness，不再只返回 opaque AgentId。 */
interface SpawnedAgent {
	readonly agentId: AgentId;
	readonly harness: WidiAgentHarness;
}

/** inspect 时才把稳定 record 与可选 live runtime 组合起来。 */
interface AgentSnapshot {
	readonly record: AgentRecordSnapshot;
	readonly runtime?: {
		readonly model: RuntimeModel;
		readonly thinkingLevel: ThinkingLevel;
		readonly tools: AgentToolsSnapshot;
		readonly extensions: ExtensionRunnerSnapshot;
		readonly maintenance?: AgentMaintenanceKind;
	};
	readonly diagnostics: readonly OrchestratorDiagnostic[];
	readonly contextUsage?: AgentContextUsage;
}

/** 构建完成但尚未发布到 live registry 的局部结果。 */
interface LiveAgentBuild {
	readonly record: AgentRecord;
	readonly liveAgent: LiveAgent;
	readonly backgroundAttachment: OwnerAttachment;
}

/** dispose 在第一次 await 前生成的同步 cutover 结果。 */
interface DisposedLiveAgent {
	readonly agentId: AgentId;
	readonly record: AgentRecord;
	readonly liveAgent?: LiveAgent;
}

/**
 * 从 record gate 得到的 delivery 目标。
 *
 * 它不包含 idle/running；实际 harness operation 自己仲裁 phase。
 */
interface DeliveryTarget {
	readonly agentId: AgentId;
	readonly harness: WidiAgentHarness;
	readonly maintenance?: AgentMaintenanceKind;
}

/**
 * 一次 turn 共用的轻量 tool binding。
 *
 * core tools 直接调用 orchestrator；background/human 各拿自己 runtime 的窄
 * capability。createExtensionContext 捕获这个 turn 的 runner generation，
 * 仅 extension-owned tools 会用到。
 */
interface ToolAdapterContext {
	readonly orchestrator: AgentOrchestrator;
	readonly callerAgentId: AgentId;
	readonly human: AgentHumanRequestPort;
	readonly background: BackgroundJobOwnerPort;
	readonly humanInterrupts: HumanInterruptWatch;
	readonly createExtensionContext: ExtensionToolContextFactory;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export declare class AgentOrchestrator {
	// -- 外部服务 -------------------------------------------------------------

	private readonly _executionEnv: ExecutionEnv;
	private readonly _resourceLoader: ResourceLoader;
	private readonly _sessionManager: SessionManager;
	private readonly _settingManager: SettingManager;
	private readonly _modelRegistry: ModelRegistry;
	private readonly _profileRegistry: AgentProfileRegistry;
	private readonly _toolRegistry: ToolRegistry;
	private readonly _extensionLoader: ExtensionLoader;

	/**
	 * background 是 sibling runtime。这里持有引用只为 attach/detach、向 tool
	 * context 提供 capability，以及接收 t1 delivery；不读取它的内部 job 状态。
	 */
	private readonly _backgroundJobs: BackgroundJobRuntime;

	/**
	 * 消息域负责 input interception、extension input-presentation 与实际 user
	 * message 的关联、provisional session entries、per-target ordering 和尚未
	 * 进入 harness 的 delivery queue。它也是唯一消费 harness queue_update 的
	 * pending/idle projection，供 extension 的 hasPendingMessages、isIdle、
	 * waitForIdle 使用；AgentRecord 不保存这些值。
	 */
	private readonly _messages: AgentMessageRuntime;

	/**
	 * extension 支撑域只拥有 output/notification/published-message
	 * presentation、status store、extension event dispatch depth 等数据面细节。
	 * runner 的创建、binding、swap 和 dispose 仍由 orchestrator 显式编排，
	 * runner 本身由 LiveAgent 持有。
	 */
	private readonly _extensions: AgentExtensionRuntimeSupport;

	/**
	 * 所有 runners 共用的一张 ExtensionCoreActions table。
	 *
	 * 方法显式接收 agentId/extensionId；runner 负责把它们绑定进 author context。
	 * 因此不会按 agent 或 tool 重复创建整套 orchestrator closures。
	 */
	private readonly _extensionCoreActions: ExtensionCoreActions;

	/** OAuth 流程、human prompts、credential refresh 等 auth 细节的 owner。 */
	private readonly _auth: AuthRuntimeController;

	/** client/listener 广播和 listener failure 隔离的 owner。 */
	private readonly _events: OrchestratorEventBus;

	/** 按 AgentId 保存历史 diagnostics，但不参与 agent 路由。 */
	private readonly _diagnostics: AgentDiagnosticLedger;

	/** 计算并发布 session-derived context usage，不保存 agent activity。 */
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

	/** 已发布的 identity，包括 live record 与 disposed tombstone。 */
	private readonly _agentRecords: Map<AgentId, AgentRecord>;

	/** 只有当前 generation；spawn 安装，dispose 立即删除。 */
	private readonly _liveAgents: Map<AgentId, LiveAgent>;

	/** 只合并并发创建请求，不表示 agent activity。 */
	private readonly _agentCreations: Map<AgentId, AgentCreationReservation>;

	/** 只合并并发 dispose 请求，不决定 agent 是否可路由。 */
	private readonly _agentDisposals: Map<AgentId, AgentDisposalReservation>;

	/** 只记录 orchestrator 自己发起且尚未结束的 maintenance operation。 */
	private readonly _maintenanceOperations: Map<
		AgentId,
		AgentMaintenanceOperation
	>;

	private _shutdownRequested: boolean;

	// -----------------------------------------------------------------------
	// 构造与 runtime 默认值
	// -----------------------------------------------------------------------

	/** 注入各独立 runtime/service，建立消息、background 和事件之间的 ports。 */
	constructor(config: AgentOrchestratorConfig);

	/** 返回后续 spawn 在未显式指定 model 时使用的默认 model。 */
	getDefaultModel(): RuntimeModel;

	/** 修改后续 spawn 的默认 model，不改动任何已经存活的 harness。 */
	setDefaultModel(model: RuntimeModel): void;

	/** 返回后续 spawn 使用的默认 thinking level。 */
	getDefaultThinkingLevel(): ThinkingLevel | undefined;

	/** 修改后续 spawn 的默认 thinking level，不改动现有 harness。 */
	setDefaultThinkingLevel(level: ThinkingLevel | undefined): void;

	/** 返回未显式指定 profile 时使用的默认 profile id。 */
	getDefaultProfileId(): string;

	/** 修改后续 spawn 使用的默认 profile id。 */
	setDefaultProfileId(profileId: string): void;

	/** 返回当前允许外部选择和 agent spawn 的 profile 白名单。 */
	getEnabledProfileIds(): readonly string[] | undefined;

	/** 替换 profile 白名单；undefined 表示不额外限制。 */
	setEnabledProfileIds(profileIds: readonly string[] | undefined): void;

	/** 汇总各 service 启动期间积累的 diagnostics，并通过统一事件出口发布。 */
	emitStartupDiagnostics(): Promise<void>;

	// -----------------------------------------------------------------------
	// Agent registry 与 lifecycle
	// -----------------------------------------------------------------------

	/**
	 * 创建或 resume agent，完成 record/live/background 的原子安装后返回 harness。
	 *
	 * 这是外部创建 agent 的唯一入口。
	 */
	spawnAgent(options?: SpawnAgentOptions): Promise<SpawnedAgent>;

	/**
	 * 返回当前可路由 generation 的真实 harness。
	 *
	 * unknown、disposed 返回 undefined；未 disposed record 缺少 live entry
	 * 属于 invariant violation。
	 */
	getAgentHarness(agentId: AgentId): WidiAgentHarness | undefined;

	/** 组合 record、live harness/runner 和独立 projections，生成当前快照。 */
	inspectAgent(agentId: AgentId): AgentSnapshot;

	/** 列出所有 record，包括 disposed tombstone，并逐个生成诚实快照。 */
	listAgents(): AgentListResult<AgentSnapshot>;

	/**
	 * dispose 单个 agent 或整个 subtree。
	 *
	 * 所有目标在第一次 await 前从 live registry 删除并标记 disposed。
	 */
	disposeAgent(
		agentId: AgentId,
		options?: DisposeAgentOptions,
	): Promise<readonly AgentId[]>;

	/** 同步切断全部 live routing，随后释放所有 runtime 资源。 */
	disposeAll(reason?: string): Promise<void>;

	// -----------------------------------------------------------------------
	// Agent collaboration tools 直接调用的 orchestrator API
	// -----------------------------------------------------------------------

	/** 列出当前 enabled、可用于 spawn 的 profile 摘要。 */
	listSpawnableAgentProfiles(): Promise<readonly AgentProfileBrief[]>;

	/**
	 * 以 caller 的稳定 spawnedBy 链为边界列出同一 agent tree。
	 *
	 * 这是 discovery scope；持有准确 AgentId 的跨 tree send 仍由 sendMessage
	 * 接受。
	 */
	listAgentTree(callerAgentId: AgentId): readonly AgentBrief[];

	/** 按准确 AgentId 返回可路由摘要；unknown 返回 undefined。 */
	findAgent(agentId: AgentId): AgentBrief | undefined;

	/**
	 * 创建 caller 的 child，并把 spawnedBy 事实写入新 AgentRecord。
	 *
	 * callerAgentId 来自 ToolAdapterContext，不来自模型参数。
	 */
	spawnChildAgent(
		callerAgentId: AgentId,
		profileId: string,
	): Promise<SpawnedAgent>;

	/**
	 * 执行 agent 发起的 same-tree dispose，集中处理 outside_tree/self/subtree。
	 *
	 * tool 闭包直接调用此方法；不存在中间 ToolAgentHost。
	 */
	disposeAgentFromAgent(
		callerAgentId: AgentId,
		targetAgentId: AgentId,
		options: AgentRequestedDisposeOptions,
	): Promise<AgentRequestedDisposeOutcome>;

	// -----------------------------------------------------------------------
	// Session workflows
	// -----------------------------------------------------------------------

	/** 使用来源 agent 的构建配置创建一个新的独立 session 与 live agent。 */
	newAgentSessionFromAgent(agentId: AgentId): Promise<AgentSessionResult>;

	/** fork 指定 agent 的 session branch，并把 fork 作为新的 live agent 打开。 */
	forkAgentSessionFromAgent(
		agentId: AgentId,
		options?: ForkAgentSessionOptions,
	): Promise<AgentSessionResult>;

	/** 列出项目范围内可 resume 的持久化 agent sessions。 */
	listAgentSessions(): Promise<AgentSessionListResult>;

	/** 解析一个用户可见 session reference，并以新的 live generation resume。 */
	resumeAgentSessionByReference(
		reference: string,
	): Promise<AgentSessionResult>;

	/** 读取指定 AgentId 当前 session branch 的结构化快照。 */
	getAgentSession(agentId: AgentId): Promise<AgentSessionSnapshot>;

	/** 读取指定 AgentId 的完整 session tree。 */
	getAgentSessionTree(agentId: AgentId): Promise<AgentSessionTreeSnapshot>;

	/** 返回指定 AgentId 当前 session 的显示名称。 */
	getAgentSessionName(agentId: AgentId): Promise<string | undefined>;

	/** 修改 session 名称并发布 session-info changed 事件。 */
	setAgentSessionName(
		agentId: AgentId,
		name: string,
	): Promise<AgentSessionSnapshot>;

	// -----------------------------------------------------------------------
	// Model、auth 与资源选择
	// -----------------------------------------------------------------------

	/**
	 * 从当前 live harness 读取 model。
	 *
	 * AgentRecord.createdWithModel 只保留创建事实，不跟随运行期 model 变化。
	 */
	getAgentModel(agentId: AgentId): RuntimeModel;

	/**
	 * 把已经解析、验证过的 RuntimeModel 写入 harness，并使旧 context-usage
	 * projection 失效。
	 *
	 * ExtensionActions 不直接持有 harness；它仍通过 orchestrator 的稳定边界。
	 */
	setAgentModel(agentId: AgentId, model: RuntimeModel): Promise<void>;

	/** 列出当前 credential/provider 条件下真正可用的 model candidates。 */
	listAvailableModelCandidates(): Promise<AgentModelCandidateListResult>;

	/**
	 * 解析 provider/model reference、验证可用性，再委托 setAgentModel。
	 */
	setAgentModelByReference(
		agentId: AgentId,
		reference: string,
	): Promise<RuntimeModel>;

	/** 列出支持产品级登录流程的 auth providers。 */
	listAuthProviderCandidates(): AuthProviderCandidateListResult;

	/** 列出当前已有 credential、可以执行 logout 的 providers。 */
	listAuthCredentialCandidates(): Promise<AuthCredentialCandidateListResult>;

	/** 启动 provider 登录流程，并把交互步骤映射到 human request 与事件。 */
	loginAuthProvider(
		providerId: string,
		options?: { readonly agentId?: AgentId },
	): Promise<AuthProviderLoginResult>;

	/** 删除 provider credential，并刷新依赖 credential 的 model 可用性。 */
	logoutAuthProvider(providerId: string): Promise<AuthProviderLogoutResult>;

	/** 根据 live harness 当前 model 列出它支持的 thinking levels。 */
	listAgentThinkingLevelCandidates(
		agentId: AgentId,
	): AgentThinkingLevelCandidateListResult;

	/** 从当前 live harness 读取 thinking level，不在 record 中保存副本。 */
	getAgentThinkingLevel(agentId: AgentId): ThinkingLevel;

	/**
	 * 根据 harness 当前 model 验证支持范围，再写入 thinking level。
	 *
	 * ExtensionActions.setThinkingLevel 绑定到这个 typed 入口。
	 */
	setAgentThinkingLevel(
		agentId: AgentId,
		level: ThinkingLevel,
	): Promise<void>;

	/**
	 * 解析外部字符串，再委托 typed setAgentThinkingLevel。
	 */
	setAgentThinkingLevelByName(
		agentId: AgentId,
		levelName: string,
	): Promise<AgentThinkingLevelResult>;

	/** 从磁盘重新加载 prompt templates，并返回可供 UI 选择的 candidates。 */
	listAgentPromptTemplateCandidates(
		agentId: AgentId,
	): Promise<AgentPromptTemplateCandidateListResult>;

	/** 从最新资源中按名称取得一个 prompt template。 */
	getAgentPromptTemplate(
		agentId: AgentId,
		name: string,
	): Promise<PromptTemplate>;

	/** 按 record 中的 profile 约束重新加载 skills，并返回 candidates。 */
	listAgentSkillCandidates(
		agentId: AgentId,
	): Promise<AgentSkillCandidateListResult>;

	/** 从该 agent 当前可用的最新 skills 中按名称取得一个 skill。 */
	getAgentSkill(agentId: AgentId, name: string): Promise<Skill>;

	// -----------------------------------------------------------------------
	// Tool policy 与 system prompt
	// -----------------------------------------------------------------------

	/**
	 * 从 harness 当前 installed/active tools 生成快照。
	 *
	 * ExtensionActions.getTools 通过这里读取，不维护第二份 tool snapshot。
	 */
	getAgentTools(agentId: AgentId): AgentToolsSnapshot;

	/**
	 * 用 base registry、profile policy 和当前 ExtensionRunner contributions
	 * 解析 declarative names，再一次性替换 harness tools。
	 *
	 * ExtensionActions.setTools 绑定到这里；解析 diagnostics 仍走统一出口。
	 */
	setAgentTools(
		agentId: AgentId,
		toolNames: readonly string[],
		activeToolNames?: readonly string[],
	): Promise<void>;

	/** 直接从 harness 当前 active tools 返回名称。 */
	getAgentActiveTools(agentId: AgentId): readonly string[];

	/**
	 * 在 harness 当前 installed tools 上验证并替换 active selection。
	 *
	 * System prompt 下一 turn 直接读取新的 active tools；
	 * ExtensionActions.setActiveTools 绑定到这里。
	 */
	setAgentActiveTools(
		agentId: AgentId,
		toolNames: readonly string[],
	): Promise<void>;

	/**
	 * 用 record 的静态 prompt facts、harness 当前 active tools 和当前 runner
	 * appends 计算下一 turn 会看到的 system prompt；不缓存结果。
	 */
	getAgentSystemPrompt(agentId: AgentId): Promise<string>;

	// -----------------------------------------------------------------------
	// 输入与消息调度
	// -----------------------------------------------------------------------

	/**
	 * 所有 human/agent/background/system 输入的统一入口。
	 *
	 * 对外隐藏 interception、session accounting 和 per-target ordering 细节。
	 */
	sendMessage(draft: MessageDraft): Promise<MessageSendOutcome>;

	/**
	 * 人类 prompt 入口；走统一消息流水线，并等待这次 prompt 的 assistant 结果。
	 */
	promptAgent(
		agentId: AgentId,
		text: string,
		options?: PromptAgentOptions,
	): Promise<PromptOutcome>;

	/**
	 * 把文本直接放入目标 harness 的 steer queue。
	 *
	 * 这是已明确选择投递方式的低层入口：执行 AgentId/maintenance gate 和
	 * human-interrupt 协调，但不再次运行 sendMessage 的 input interception
	 * 或 session provisional accounting。ExtensionActions.steer 也绑定到这里。
	 */
	steerAgent(
		agentId: AgentId,
		text: string,
		options?: AgentMessageInjectionOptions,
	): Promise<void>;

	/**
	 * 把文本直接放入目标 harness 的 follow-up queue。
	 *
	 * 与 steerAgent 一样是显式低层投递；ExtensionActions.followUp 绑定到这里。
	 */
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
	 * 终止当前 harness run，并让消息 runtime 同步处理被清空的 steer/follow-up。
	 *
	 * AgentRecord 不保存 aborted/running 镜像；真实结果直接来自 harness。
	 */
	abortAgent(agentId: AgentId): Promise<AbortResult>;

	/**
	 * 同步回答 core delivery queue 或 harness queues 是否仍有未读消息。
	 *
	 * 数据来自唯一的 AgentMessageRuntime projection，不把 queue count 写入
	 * AgentRecord。
	 */
	agentHasPendingMessages(agentId: AgentId): boolean;

	/**
	 * 同步回答 extension context 当前是否可视为 idle。
	 *
	 * 这是 ExtensionContext.isIdle 的绑定点：harness run 已结束，且 core 与
	 * harness 两层消息队列都为空。当前 AgentHarness 没有同步 phase/queue
	 * snapshot，因此这个兼容 projection 暂时不可完全删除；它只存在一份。
	 */
	isAgentIdle(agentId: AgentId): boolean;

	/**
	 * 等到 harness run 结束且 core/harness 两层消息队列都清空。
	 *
	 * 这是 ExtensionActions.waitForIdle 的稳定语义，不另建 orchestrator
	 * status machine；unknown 或 dispose 会使等待失败而不是永久悬挂。
	 */
	waitForAgentIdle(
		agentId: AgentId,
		options?: { readonly signal?: AbortSignal },
	): Promise<void>;

	// -----------------------------------------------------------------------
	// Maintenance
	// -----------------------------------------------------------------------

	/**
	 * 运行 compaction，登记 orchestrator-owned maintenance promise，并使旧的
	 * context-usage projection 失效。
	 */
	compactAgent(
		agentId: AgentId,
		customInstructions?: string,
	): Promise<CompactResult>;

	/**
	 * 运行 session tree navigation，并在 branch 改变后使 context projection
	 * 失效。
	 */
	navigateAgentTree(
		agentId: AgentId,
		targetId: string,
		options?: NavigateAgentTreeOptions,
	): Promise<NavigateTreeResult>;

	// -----------------------------------------------------------------------
	// Extensions
	// -----------------------------------------------------------------------

	/** 向 extension loader 注册一个进程内 extension module。 */
	registerExtension(extensionId: string, module: ExtensionModule): () => void;

	/**
	 * 刷新 extension catalog，并为选中的 live agents 事务式替换 runner。
	 *
	 * replacement 同时覆盖 tool define/patch、provider registrations、
	 * system-prompt appends、harness interceptors、observed/event subscribers、
	 * ExtensionActions/session context 和 onDispose；任何一步失败都不能留下
	 * “新 tools + 旧 runner”之类的混合 generation。
	 */
	reloadExtensions(options?: {
		readonly agentIds?: readonly AgentId[];
	}): Promise<ExtensionReloadResult>;

	/** 返回某个 agent 当前 extension runner 对外发布的 status snapshots。 */
	listExtensionStatuses(agentId: AgentId): readonly ExtensionStatusSnapshot[];

	// -----------------------------------------------------------------------
	// Human requests
	// -----------------------------------------------------------------------

	/** 发送一个带完整 source 的 human request，由已注册 client 响应。 */
	requestHuman(request: HumanRequest): Promise<HumanResponse>;

	/** 按 request id 取消尚未完成的 human request。 */
	cancelHumanRequest(requestId: string, reason?: string): Promise<boolean>;

	// -----------------------------------------------------------------------
	// Events、clients 与 runtime shutdown
	// -----------------------------------------------------------------------

	/** 注册一个外部 client；返回只撤销这次注册的 unsubscribe。 */
	registerClient(client: OrchestratorClient<OrchestratorEvent>): () => void;

	/** 订阅全部 orchestrator events；listener failure 由 event bus 隔离。 */
	subscribe(listener: OrchestratorEventListener): () => void;

	/** 只订阅携带指定 AgentId 的 orchestrator events。 */
	subscribeAgent(
		agentId: AgentId,
		listener: OrchestratorEventListener,
	): () => void;

	/**
	 * 发布一次 runtime shutdown request；真正退出进程仍由外部 host 决定。
	 *
	 * shutdown observed handlers 必须先完成，再通知可能立即 disposeAll 的
	 * host client，给 extensions 最后一次持久化/清理机会。
	 */
	requestShutdown(request: RuntimeShutdownRequest): Promise<void>;

	// -----------------------------------------------------------------------
	// Private：spawn / resume / dispose
	// -----------------------------------------------------------------------

	/** 解析一次全新 spawn，并把构建、安装、事件发布串成一个 lifecycle workflow。 */
	private _spawnNewAgent(
		options: SpawnAgentCreateOptions,
		spawnedBy?: AgentId,
	): Promise<SpawnedAgent>;

	/** 解析持久化 session，并把它安装成一个全新的 live generation。 */
	private _resumeAgent(
		options: SpawnAgentResumeOptions,
	): Promise<SpawnedAgent>;

	/**
	 * 解析新 agent 的 profile、override、session、model 和 thinking 初值。
	 *
	 * 返回纯 build request，不注册半成品 live resource。
	 */
	private _resolveNewAgentBuild(
		options: SpawnAgentCreateOptions,
		spawnedBy?: AgentId,
	): Promise<AgentBuildRequest>;

	/**
	 * 解析 resume metadata、profile、session context、model、thinking 和 tools。
	 *
	 * 不恢复旧进程中的 harness/runtime 对象。
	 */
	private _resolveResumeAgentBuild(
		options: SpawnAgentResumeOptions,
	): Promise<AgentBuildRequest>;

	/**
	 * 在局部变量中创建 resources、runner、tools、harness 和 background
	 * attachment；成功前不触碰 live registry。
	 *
	 * extension 顺序是 activate runner、应用 provider contributions、用 runner
	 * contributions 解析 scoped tools、创建 harness、绑定 actions/interceptors。
	 * 任一步失败都按相反顺序释放候选资源。
	 */
	private _buildLiveAgent(request: AgentBuildRequest): Promise<LiveAgentBuild>;

	/**
	 * 无 await 地同时安装完整 AgentRecord 与 LiveAgent。
	 *
	 * record 初始为 disposed=false；这是 spawn 的唯一 routing cutover。
	 */
	private _installLiveAgent(build: LiveAgentBuild): SpawnedAgent;

	/**
	 * 发布 agent 构建失败 diagnostic。
	 *
	 * 候选资源由 build workflow 清理；失败不会发布 record 或 live entry。
	 */
	private _reportAgentBuildFailure(
		agentId: AgentId,
		error: unknown,
		facts?: PartialAgentRecordFacts,
	): Promise<void>;

	/**
	 * 合并重复 dispose、snapshot subtree，并生成确定的 leaf-to-root 计划。
	 *
	 * 该计划尚未执行异步 teardown。
	 */
	private _planDisposal(
		agentId: AgentId,
		options: DisposeAgentOptions,
	): AgentDisposalPlan;

	/**
	 * 无 await 地把计划内所有 record 标为 disposed、删除 live entries，并
	 * detach background attachments。
	 */
	private _cutOverDisposed(
		plan: AgentDisposalPlan,
	): readonly DisposedLiveAgent[];

	/**
	 * 使用 cutover 前保存的局部引用释放 harness、runner、bindings 和外围
	 * workflows；失败不恢复 live routing。
	 */
	private _disposeLiveAgent(
		disposed: DisposedLiveAgent,
		reason?: string,
	): Promise<void>;

	/** 为新 profile 生成 runtime-local、不会与 tombstone 冲突的 AgentId。 */
	private _allocateAgentId(profile: AgentProfile): AgentId;

	/** 验证 spawning agent 仍为 live 且允许创建 child。 */
	private _assertAgentCanSpawn(agentId: AgentId): void;

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
	// Private：registry、snapshot 与不变量
	// -----------------------------------------------------------------------

	/** 取得已注册 record；unknown AgentId 立即失败。 */
	private _requireAgentRecord(agentId: AgentId): AgentRecord;

	/**
	 * 先执行 record 的 unknown/disposed gate，再取得 live entry。
	 *
	 * 未 disposed record 缺少 entry 被视为 invariant violation，而不是新的
	 * lifecycle 状态。
	 */
	private _requireLiveAgent(agentId: AgentId): LiveAgent;

	/** 在读取时组合 record、harness、runner、diagnostics 和 context projection。 */
	private _snapshotAgent(record: AgentRecord): AgentSnapshot;

	/**
	 * 验证未 disposed record 与 _liveAgents membership 完全一致，且没有
	 * partial live。
	 *
	 * 供高风险 lifecycle 边界和测试使用，不参与业务分支。
	 */
	private _assertRegistryInvariant(agentId?: AgentId): void;

	// -----------------------------------------------------------------------
	// Private：harness、tools 与 prompt 装配
	// -----------------------------------------------------------------------

	/**
	 * 根据 record prompt facts、harness 传入的 active tools 和当前 runner
	 * appends 组合 system prompt。
	 */
	private _composeAgentSystemPrompt(
		agentId: AgentId,
		activeTools: readonly ToolPromptGuidance[],
	): string;

	/**
	 * 用 base registry、profile declaration 和当前 runner contribution 解析
	 * 一组真正交给 harness 的 tools。
	 */
	private _resolveAgentTools(
		agentId: AgentId,
		request: AgentToolConfigurationRequest,
		runner: ExtensionRunner,
	): Promise<ResolvedAgentTools>;

	/**
	 * 浅 clone base registry，再按 runner registration order 应用 extension
	 * defineTool/patchTool；tool definitions 和大型 backend 仍共享引用。
	 */
	private _createScopedToolRegistry(
		runner: ExtensionRunner,
	): ToolRegistry;

	/**
	 * 为一次 harness turn 创建 WIDI tool context。
	 *
	 * core agent tools 得到具体 orchestrator 引用和 callerAgentId，执行闭包
	 * 直接调用本类，不再创建 ToolAgentHost。闭包只捕获引用，不复制
	 * orchestrator、harness 或 tool backend。
	 *
	 * extension tools 额外捕获本 turn 开始时的 runner generation；reload 后
	 * 旧 context 进入 stale boundary，不能静默改用 replacement runner。
	 */
	private _createToolAdapterContext(
		agentId: AgentId,
		profileId: string,
	): ToolAdapterContext;

	/**
	 * 绑定 harness 原始事件与释放句柄。
	 *
	 * extension interceptors 由独立的 runner binding 安装，便于 reload
	 * replacement；这里不把 event 投影回 AgentRecord，也不建立第二套 phase。
	 */
	private _bindHarness(
		agentId: AgentId,
		harness: WidiAgentHarness,
	): Promise<() => Promise<void>>;

	// -----------------------------------------------------------------------
	// Private：ExtensionRunner lifecycle 与全部插入点
	// -----------------------------------------------------------------------

	/**
	 * 按 settings/divisions 激活 extension factories，收集 tools、providers、
	 * prompt appends、interceptors、observers、event handlers 和 onDispose。
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
		harness: WidiAgentHarness,
		runner: ExtensionRunner,
	): Promise<ExtensionRunnerBindings>;

	/**
	 * 创建 runner author actions 到 orchestrator/runtime services 的映射。
	 *
	 * 这是一个共享 action table；runner 再注入自己的 agentId/extensionId，
	 * 不为每个 tool 创建大型 service 实例。
	 */
	private _createExtensionCoreActions(): ExtensionCoreActions;

	/**
	 * 创建当前 runner generation 的 signal、idle、session 和失败报告 ports。
	 *
	 * session actions 保留 extension namespace；跨 session reads 和 exec 仍走
	 * project-trust gate。
	 */
	private _createExtensionContextActions(
		agentId: AgentId,
	): ExtensionContextActions;

	/**
	 * 在 harness 上注册现有五个可变换 hook：
	 * before_agent_start、before_provider_request、context、tool_call、
	 * tool_result。
	 *
	 * context hook 仍与 core blockImages policy 顺序组合；release 只撤销这个
	 * runner generation 的 handlers。
	 */
	private _registerExtensionHarnessInterceptors(
		agentId: AgentId,
		harness: WidiAgentHarness,
		runner: ExtensionRunner,
	): () => void;

	/**
	 * 执行一个 runner interceptor，记录 handler diagnostics，并返回组合结果。
	 *
	 * input 不走这里，因为它位于 harness 之外的 sendMessage ingress。
	 */
	private _runExtensionInterceptor<
		TName extends ExtensionInterceptorName,
	>(
		agentId: AgentId,
		runner: ExtensionRunner,
		event: ExtensionInterceptorEventFor<TName>,
	): Promise<ExtensionInterceptorResultFor<TName>>;

	/**
	 * 在任何 human/agent/background/system 消息进入 delivery queue 前运行
	 * ExtensionRunner input pipeline，保留串行 transform、首个 block 和
	 * fail-closed diagnostics 语义。
	 */
	private _interceptExtensionInput(
		agentId: AgentId,
		event: ExtensionInputEvent,
	): Promise<ExtensionInputInterceptRun>;

	/**
	 * 安装 runner 的 provider contributions；command config 仍受 project
	 * trust gate，冲突和非法 provider 仍形成 attributed diagnostics。
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
	 * presentation 在对应 user message 真正进入 session 后提交；投递失败或
	 * abort 清队列时撤销，且 presentation events 不反向喂给 extension
	 * observers。
	 */
	private _withExtensionInputPresentation(
		agentId: AgentId,
		extensionId: string,
		method: "steer" | "follow_up",
		presentation: ExtensionInputPresentation | undefined,
		deliver: () => Promise<void>,
	): Promise<void>;

	/**
	 * 为一个 live agent 构建 candidate runner，重解 tools，安装新的 actions、
	 * interceptors 和 providers，再原子替换 LiveAgent.extensionRunner。
	 *
	 * 成功后 invalidate/dispose 旧 runner 并运行 onDispose；失败则释放 candidate
	 * 并恢复原 runner、tools 和 bindings。已开始的 turn 继续持有旧 generation
	 * 并看到明确 stale error。旧 status/presentation bindings 一并清理，但新
	 * runner 在安装后发布的状态不能被旧 generation 的 cleanup 误删。
	 */
	private _reloadLiveAgentExtensions(
		agentId: AgentId,
	): Promise<ExtensionReloadAgentResult>;

	/**
	 * 使 runner context stale，撤销 bindings/provider leases，执行全部
	 * onDispose，并释放它持有的 handler/module closures。
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
	 * 把一条输入交给消息 runtime 做 interception、session accounting 和排队。
	 *
	 * requiresFreshPrompt 只表达调用者是否必须获得本次 assistant result。
	 */
	private _routeMessage(
		draft: MessageDraft,
		options: RouteMessageOptions,
	): Promise<AcceptedMessage>;

	/**
	 * 只做一级 availability gate，并附带 orchestrator-owned maintenance。
	 *
	 * 不推断 harness idle/running。
	 */
	private _resolveDeliveryTarget(agentId: AgentId): DeliveryTarget;

	/**
	 * Message runtime 请求真正投递时调用。
	 *
	 * 根据消息 mode 尝试 prompt/follow-up/steer；竞态由 typed harness error
	 * 仲裁，绝不读取 status mirror。
	 */
	private _deliverQueuedMessage(
		request: QueuedMessageDelivery,
	): Promise<MessageDeliveryReceipt>;

	/**
	 * 发起必须产生 assistant result 的 fresh prompt，并把 run promise 直接放进
	 * receipt；不登记全局 _agentPromptRuns。
	 */
	private _startPrompt(
		target: DeliveryTarget,
		request: PromptDeliveryRequest,
	): MessageDeliveryReceipt;

	/**
	 * 把 queue_update、run settle 和 core delivery 状态交给唯一消息 projection。
	 *
	 * 该 projection 驱动 isAgentIdle/agentHasPendingMessages/waitForAgentIdle，
	 * 并在组合条件第一次成立时发布 agent_idle。它不更新 AgentRecord，也不
	 * 维护第二套可路由 lifecycle。
	 */
	private _observeHarnessDeliveryState(
		agentId: AgentId,
		event: AgentHarnessEvent,
	): Promise<void>;

	/**
	 * 登记并等待 orchestrator 自己发起的 compaction/tree operation。
	 *
	 * reservation 仅阻止 WIDI delivery 误入 maintenance，不表示全部 harness
	 * activity。
	 */
	private _runMaintenanceOperation<T>(
		agentId: AgentId,
		kind: AgentMaintenanceKind,
		operation: (harness: WidiAgentHarness) => Promise<T>,
	): Promise<T>;

	// -----------------------------------------------------------------------
	// Private：事件驱动的外层协调
	// -----------------------------------------------------------------------

	/**
	 * 接收 harness 原始事件，依次通知 message、human-interrupt、extension、
	 * context monitor 和外部 event bus。
	 *
	 * 不更新 AgentRecord running/idle。
	 */
	private _handleHarnessEvent(
		agentId: AgentId,
		event: AgentHarnessEvent,
		signal?: AbortSignal,
	): Promise<void>;

	/**
	 * 将一个已发布的 observable event 投递给目标 runner 的 observe handlers。
	 *
	 * runtime_shutdown_requested 广播给所有 live runners；stale runner 跳过；
	 * handler failures 进入 diagnostics，extension-published diagnostics 和
	 * presentation events 不回流，避免递归。
	 */
	private _dispatchExtensionObservedEvent(
		event: ExtensionObservedEvent,
	): Promise<void>;

	/**
	 * 把一个具名 extension event 广播给所有 live runners 的订阅者。
	 *
	 * 保留 immutable payload、source attribution、同 runtime 自接收和有界递归
	 * 深度；runner reload/dispose 自然替换订阅集合。
	 */
	private _emitExtensionEvent(
		envelope: ExtensionEventEnvelope,
	): Promise<void>;

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
// 伪代码中出现的新协作者边界
// ---------------------------------------------------------------------------

/**
 * 这些类型只说明被移出 orchestrator 的 ownership，并不在本文设计其方法：
 *
 * - AgentMessageRuntime：消息变换、input-presentation/message correlation、
 *   session provisional entries、delivery queue，以及唯一的 harness
 *   queue/activity projection。
 * - AgentExtensionRuntimeSupport：output/notification/published-message
 *   presentation、status store、extension event recursion guard 等数据面细节；
 *   不拥有 ExtensionRunner。
 * - AuthRuntimeController：OAuth/login/logout 与 credential refresh。
 * - OrchestratorEventBus：listeners、clients、failure isolation。
 * - AgentDiagnosticLedger：diagnostic history。
 * - AgentContextMonitor：context usage 与 auto-compaction trigger。
 *
 * 它们不是 AgentHarness wrapper；没有任何一个保存 model 或 tools 的副本。
 * 只有 AgentMessageRuntime 根据 harness events 保存满足 extension
 * hasPendingMessages/isIdle/waitForIdle 契约所需的最小 queue/activity
 * projection，而且它不参与 AgentRecord 的一级路由。
 */
