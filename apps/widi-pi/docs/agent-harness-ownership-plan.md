# AgentOrchestrator 简化设计

状态：计划中
日期：2026-07-30

## 结论

这次重构的目标不是给 `AgentOrchestrator` 再拆出更多 facade，而是删除已经失去
价值的包装层。

`AgentHarness` 已经封装了 `run_agent_loop`，并拥有当前 model、thinking level、
installed/active tools、agent-loop phase、内部消息队列、prompt、steer、
follow-up、abort 和 wait 等执行语义。Orchestrator 不复制这些状态，也不通过
`AgentRecord` 代理它们。

Orchestrator 继续是 TUI、RPC、agent tools、ExtensionRunner 和其他内部 runtime
的调度中枢，负责：

- AgentId 与 spawn tree；
- spawn、resume、dispose；
- 第一层协作门控；
- model/tool/profile 等 WIDI policy；
- message、session、extension 与 background runtime 的连接。

需要运行态信息时，Orchestrator 直接读取 `AgentHarness`；需要改变运行态时，
直接调用 `AgentHarness`。保留具名的 orchestrator 方法是为了给
TUI/RPC/ExtensionActions 提供稳定入口，不代表 orchestrator 拥有一份相同状态。

## 两个 registry

```ts
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

interface LiveAgent {
	readonly harness: WidiAgentHarness;
	extensionRunner: ExtensionRunner;
	readonly releaseBindings: () => Promise<void>;
}
```

`_agentRecords` 保存相对固定的事实：

- identity、profile 与 spawn 关系；
- session identity；
- 创建时的 model 与资源解析结果；
- system prompt 构建需要的固定事实；
- 是否已经 dispose。

这些事实是 Orchestrator 在 model、tools、prompt 或 extension 发生变化时重新
计算 WIDI policy 的参照，不是 Harness 当前状态的快照。

Record 只有三种可观察结果：

| 查询结果 | 含义 |
| --- | --- |
| 没有 record | unknown AgentId |
| `record.disposed === true` | tombstone，不可路由 |
| record 存在且未 disposed | 通过第一层门控，必须存在对应 `LiveAgent` |

不再把 `creating`、`unavailable`、`running`、`idle` 或 maintenance 写入
`AgentRecord`。创建中的请求只存在于 creation reservation 和局部 build 中；
构建失败不发布一个可以参与协作路由的 record。一个未 disposed record 缺少
`LiveAgent` 是 invariant violation，不是新的 lifecycle 状态。

`_liveAgents` 只保存当前 generation 的 `AgentHarness`、`ExtensionRunner` 和
释放绑定所需的句柄。它不是 facade，也不提供一组 harness 转发方法。

以下内容不进入 record：

- 当前 model、thinking level、installed/active tools；
- harness、runner、phase、queue count；
- context usage、diagnostics 等观测投影；
- background job、journal 或 owner attachment。

`createdWithModel` 只是历史事实。当前 model 永远读取
`harness.getModel()`。

## 两层门控

所有按 AgentId 发起的操作只经过两层判断：

1. Record gate 判断 unknown、disposed 或 exists，并处理 spawn-tree
   collaboration policy。
2. 取得 `_liveAgents.get(agentId).harness`，让 Harness 自己判断当前操作是否
   合法。

第二层不再读取 record 的 running/idle，也不预判 Harness phase：

- prompt：直接调用 `harness.prompt()`；
- steer：直接调用 `harness.steer()`；
- follow-up：直接调用 `harness.followUp()`；
- abort：直接调用 `harness.abort()`；
- wait：直接调用 `harness.waitForIdle()`；
- phase 冲突：以 `AgentHarnessError` 为最终仲裁。

Orchestrator 保留这些公开方法：

- `getAgentModel` / `setAgentModel` / `setAgentModelByReference`；
- `getAgentThinkingLevel` / `setAgentThinkingLevel`；
- `getAgentTools` / `setAgentTools`；
- `getAgentActiveTools` / `setAgentActiveTools`；
- `promptAgent` / `steerAgent` / `followUpAgent` / `abortAgent`；
- `agentHasPendingMessages` / `waitForAgentIdle`。

getter 直接读 Harness。setter 在完成 registry 解析、profile/model 验证、
context invalidation、extension contribution 等 WIDI policy 后直接写 Harness。
这些方法是调度 API，不是状态副本。

Extension API 要求的 `hasPendingMessages`、同步 `isIdle` 与 `waitForIdle` 可以由
message runtime 保存一份最小的 delivery/queue projection。它只满足
ExtensionActions 契约，不进入 record，也不参与 AgentId 路由。

## 直接提供 Orchestrator，不构建 Host

删除 `AgentHost`、`ToolAgentHost` 以及同类 caller-bound facade。Core agent
tools 的 turn context 直接携带：

```ts
interface ToolAdapterContext {
	readonly orchestrator: AgentOrchestrator;
	readonly callerAgentId: AgentId;
	readonly background: BackgroundJobOwnerPort;
	readonly human: AgentHumanRequestPort;
}
```

tool 闭包直接调用 orchestrator：

```ts
await context.orchestrator.spawnChildAgent(
	context.callerAgentId,
	input.profileId,
);
```

caller identity 来自 context，不来自模型参数。spawn-tree discovery、
same-tree dispose、self-dispose、message source 等判断仍集中在 orchestrator
方法中，不需要一个 Host 对象承载。

其他内部 runtime 也可以直接注入同一个 `AgentOrchestrator` 引用。JavaScript
闭包捕获的是引用，不会复制 orchestrator、registry、Harness 或 tool backend；
class 方法也位于 prototype，不会为每个 consumer 复制。

需要遵守两个生命周期规则：

- 长生命周期闭包只捕获 `orchestrator + AgentId`，调用时重新查找
  `LiveAgent`，不捕获 `LiveAgent`、Harness 或 turn transcript；
- runtime/runner dispose 时撤销注册到更长生命周期 event source 上的
  listener，避免真正的引用滞留。

对象之间形成普通引用环不会单独造成 JavaScript 内存泄漏；只有仍被可达根持有的
listener、promise 或缓存才会延长生命周期。因此没有必要为了内存再增加 Host。

## ToolRegistry 与 ExtensionRunner

`ToolRegistry` 保存共享的 tool definitions。为 agent 解析 tools 时浅 clone
registry，再应用当前 `ExtensionRunner` 的 define/patch contributions；大型
backend 和 execute function 仍共享引用。

ExtensionRunner 属于 `LiveAgent` generation，并保留现有扩展能力：

- tool define/patch 与 provider contributions；
- system-prompt append；
- input、before-agent、provider、context、tool-call/result interceptors；
- observed events 与 extension event；
- ExtensionActions、session actions、presentation、status 和 onDispose。

`ExtensionCoreActions` 是 extension author API 的绑定契约，不是 AgentHost。
它可以在 Orchestrator 构造时创建一份共享 action table，其中 model、thinking、
tools、steer、follow-up 等操作直接调用 orchestrator 的正式方法。

system prompt 每个 turn 由三部分组合：

1. `AgentRecord` 中固定的 prompt facts；
2. Harness 传入的当前 active tools；
3. 当前 `LiveAgent.extensionRunner` 的 append sections。

active tools 或 runner 改变时不更新 record。Extension reload 只替换 live
runner、重新解析 Harness tools 并交换 bindings。

## Spawn 与 dispose

Spawn/resume 在局部变量中完成 profile、resources、runner、tools、Harness 和
runtime attachments 的构建。全部成功后，在一个无 `await` 的同步片段中：

1. 写入完整 `AgentRecord`，`disposed: false`；
2. 写入完整 `LiveAgent`；
3. 发布为可路由 generation；
4. 返回 `{ agentId, harness }`。

构建失败只清理局部资源和记录 diagnostic，不发布半成品 record/live entry。

Dispose 在第一次 `await` 前：

1. 保存 `LiveAgent` 局部引用；
2. 把 `record.disposed` 改为 `true`；
3. 从 `_liveAgents` 删除；
4. detach background owner。

随后才 abort/wait Harness、dispose ExtensionRunner、撤销 bindings 并清理其他
runtime workflow。Teardown 失败只记录 diagnostic，不恢复 routing。

subtree dispose 先 snapshot leaf-to-root 顺序，再同步完成所有目标的 record
cutover 和 live-entry 删除。这个边界直接替代 `_disposingAgents`。

## BackgroundJobRuntime

`BackgroundJobRuntime` 是与 `AgentOrchestrator` 并列的 sibling runtime：

- spawn/resume 时 attach owner；
- tool context 获取 owner/settler capability；
- dispose 时 detach owner；
- settlement 通过 delivery port 请求 Orchestrator 投递普通消息；
- persistence、job lifecycle、output、report 与 ordering 全部留在 background
  runtime。

`AgentRecord`、`LiveAgent` 和 Orchestrator 不保存 table/store/job 状态，也不把
jobs 计入 AgentHarness idle。

## 删除与保留

删除：

- `AgentHost` / `ToolAgentHost`；
- Record 中的 harness、runner、当前 model/tools、queue 和 background 字段；
- running/idle lifecycle mirror；
- `_disposingAgents`；
- 为代理 Harness 而存在的 Record/LiveAgent 方法；
- Orchestrator 内部的 background table/store/listener 语义。

保留：

- Orchestrator 对 TUI/RPC/tools/extensions 的具名调度 API；
- creation/disposal reservation；
- message delivery queue；
- Orchestrator 自己发起的 maintenance operation promise；
- diagnostic/context/presentation 等独立观测投影；
- ExtensionRunner 的全部现有插入点。

不修改 `packages/agent`，不增加安全或 capability wrapper，不在本方案中设计
极端情况下的 Harness/job 恢复。

## 收益

- Record 成为稳定的目录项与 tombstone，不再冒充 live agent。
- Harness 是所有执行状态的唯一事实源。
- Agent 协作只经过 record gate 与 Harness operation 两层。
- tools 和 runtimes 直接使用 Orchestrator，不再为每个 caller 构建 Host。
- ExtensionRunner 与 BackgroundJobRuntime 保持完整能力和清晰生命周期。
- 删除状态镜像、转发 facade 和补丁式 idle/dispose 条件，降低代码量与内存
  留存风险。
