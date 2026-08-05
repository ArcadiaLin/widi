# Orchestrator 接线与持久化落地：实施排期

面向 `apps/widi-pi/src/core/`。前置阅读：`docs/ZH/orchestrator-refactor.md`、`docs/ZH/persistence-ref-writer.md`、`docs/ZH/agent-tree-persistence.md`、`docs/ZH/background-job-persistence.md`。

那四份文档各自描述一件事该长什么样。本文不重复它们的设计，只回答三个问题：**现在到底停在哪、每项工作要动哪些文件、哪些工作卡着哪些工作**。

---

## 1. 现状盘点

以下是分支 `orchestrator-refactor` 的事实陈述，不含判断。**批次 1、2、3 已落地**，本节描述的是它们之后的状态。

| 模块 | 状态 |
|---|---|
| `core/agent-orchestrator.ts`（4580 行） | 新 orchestrator 已就位，旧文件与 `core/orchestrator/` 目录都不存在了 |
| `core/persistence/*`（约 2100 行 + 8 个测试文件） | 生产路径上的仓储。`JsonlPersistenceRepo` 由 `SessionManager` 持有，`PersistenceRegistry` 由 `core/persistence-registry.ts` 建 |
| `background/*` | 重构完成并已接入。`JobBranchPort`（`background/types.ts`）由 orchestrator 的 `_openBranchState` 实现，`SessionJobStore` 走真实的 `JobHistoryStorage` |
| `session-manager.ts`（703 行） | 已迁到 `JsonlPersistenceRepo`。会话按 `SessionAddress` 寻址，spawn 出来的会话嵌在父目录下，`core/session-repo.ts` 与 `core/session-tree.ts` 已删 |
| 下游（`tools/jobs/*`、`tools/agents/*`、`tui/*`） | 已跟上新词汇 |

`npm run check`（Biome + 类型）**归零**。

`npm run test` 是 **1092 passed / 65 failed**。这 65 条集中在 `agent-orchestrator.test.ts`(19)、`agent-message.test.ts`(8)、`agents-collaboration-tools.test.ts`(8)、`agent-idle-event.test.ts`(6)、`extension-runtime-control.test.ts`(6) 等，症状是 `Unknown agent`、`Agent … is gone.`、`_handleSubscribedAgentHarnessEvent is not a function` 一类的生命周期/事件桥接问题，**与持久化无关**，是批次 1 换 orchestrator 时留下的欠账。见第 7 节风险 1。

两处 stub 已经消除：`openOwnerStore` 换成了真实的 job store（批次 2），`agent-tree-persistence.md` §9 的删除清单已执行（批次 1 的 B）。

<details>
<summary>立文时（批次 1 之前）的盘点，保留以说明第 2 节的排期为什么是这个形状</summary>

| 模块 | 状态 |
|---|---|
| `orchestrator/agent-orchestrator.ts`（新，4542 行） | 自身类型 0 错误，**零导入方** |
| `core/agent-orchestrator.ts`（旧，4538 行） | 54 个类型错误，仍是 `runtime-service.ts` 的依赖 |
| `core/persistence/*` | 完整、有测试，**零生产调用方** |
| `session-manager.ts` | 仍用 `SessionDirectoryRepo`，与 `JsonlPersistenceRepo` 目录命名规则不同、互相看不见 |
| 下游 | 未跟上新词汇 |

`npm run check` 当时是 **185 个错误**：54 个在旧 orchestrator，59 个在其它 `src/` 文件，72 个在 `tests/`。`src/` 那 59 个不是新 orchestrator 的问题，是 background 与 orchestrator 的词汇已经换过而下游没跟上（`BackgroundJobTable` → `BackgroundJobRuntime`、`AgentLifecycleStatus` 删除、`ToolAgentHost.send` → `sendMessage` 等）。

</details>

---

## 2. 排期的形状

**不存在"先做持久化、再接线"这个选项。**

旧 orchestrator 已经编不过，新的没有任何导入方。任何持久化改动都会落在一条不能通过 `npm run check` 的分支上，没有可运行的路径去验证它。接线因此不是一项普通工作，它是其余各项的地基。

由此得到第一条排期纪律：**批次 1 的完成判据是 `npm run check` 归零**，在那之前不开始任何持久化工作。这条纪律已经兑现——批次 2、3 都是在类型归零的分支上做的，每一步都能跑起来验证。

---

## 3. 七项工作

A–F 是立文时定下的六项。G 是 C 落地过程中长出来的，附在最后。

### A. 接线新 orchestrator

> **落地状态**：完成（批次 1）。`core/orchestrator/` 目录不再存在，`npm run check` 归零；`tests/` 的类型修完了，但运行时断言没修完，见第 7 节风险 1。

新的 `orchestrator/agent-orchestrator.ts` 正式成为运行时依赖，移动至 `core/agent-orchestrator.ts`， `core/orchestrator/*` 下的文件整体平铺在 `core` 目录下，旧文件删除。

1. `runtime-service.ts`：导入从 `./agent-orchestrator.js` 改为 `./orchestrator/agent-orchestrator.ts`；配置类型名 `AgentOrchestratorConfigs` → `AgentOrchestratorConfig`（新文件用单数）。
2. TUI 侧四个导入点改指向：`tui/application.ts`、`tui/autocomplete.ts`、`tui/commands/types.ts`、`tui/commands/built-ins.ts`。
3. 修 `src/` 侧 59 个错误，分三簇：

   | 簇 | 文件 | 要换的东西 |
   |---|---|---|
   | background 词汇 | `tools/jobs/{read-job,wait-for-jobs,kill-job,settlement-wait}.ts`、`tools/types.ts`、`tool-registry.ts` | `BackgroundJob*` 旧类型 → `BackgroundJobSnapshot` / `BackgroundJobRuntime` |
   | ToolAgentHost 面 | `tools/agents/{shared,send-message,dispose-agent,list-agents}.ts` | `send` → `sendMessage`、`settleTask` → `settler`、`addressable`/`status` → `activity` |
   | TUI 活动模型 | `tui/{event-projector,state,autocomplete}.ts`、`tui/commands/*` | `AgentLifecycleStatus` 消失，事件字段收敛到 `activity` |

   `tools/jobs/read-job.ts` 一个文件 16 个错误，是三簇里最重的：它读的 job 字段结构整个变了。

4. 删除 `core/agent-orchestrator.ts`。
5. 修 `tests/` 侧 72 个错误。先修 `tests/helpers/orchestrator.ts`——它是共用夹具，一批测试会跟着好转。

**完成判据**：`npm run check` 归零，`npm run tui` 能起来并完成一轮对话。

---

### B. orchestrator 代码简化

> **落地状态**：完成（批次 1，与 A 合批）。§9 的删除清单已执行，`core/session-tree.ts` 已删。

执行 `agent-tree-persistence.md` §9 的删除清单。**范围已确认：按 §9 删干净，`resume_agent` 逃生口（§13）不在本次范围。**

1. 删掉新 orchestrator 3217–3470 行的 "Spawn tree persistence" 整节（约 253 行）：`_createTreeSpawnRecord`、`_recordAgentSpawnedInTree`、`_recordAgentRemovedFromTree`、`_enqueueTreeWrite` / `_treeWrites`、`_planAgentTreeResume`、`_restoreSpawnTree`、`_resumeAgentTree`、`_redirectChildResumeToRoot`、`_resolveResumeRoot`。
2. 删掉 `spawnAgent` / `disposeAgent` 里对它们的调用点，以及 `LiveAgentBuild.treeRecord`、`AgentTreeResumeOutcome`。
3. 删 `core/session-tree.ts` 整个文件（68 行），它只有两个导入方：`session-manager.ts:36` 与新 orchestrator 的 `:135`。
4. 删 `SessionManager` 的 `appendAgentTreeRecord`、`readAgentTreeRecords`、`writeAgentParentPointer`、`readAgentParentPointer`、`_agentTreePaths`、`_readAgentParentPointerAtPath`（`session-manager.ts:406–467` 与 `600–642`，约 120 行），以及 `listAgentSessionCandidates` 里为 `isChild` 付的那次读盘。
5. 删四个诊断码：`orchestrator.agent_tree_write_failed`、`agent_tree_read_failed`、`agent_tree_not_persistable`、`agent_tree_root_unresolved`。
6. `_publishTreeResumeReconciliation` 改写成 §5 那条**无条件的、一句话的、不带成员清单的**告知："这次恢复之前你创建的全部 agent 都已经关闭；需要的话重新创建。" 它仍然是一处 `harness.appendMessage` 写入点，理由不变——它必须是 resume 时就在上下文里的事实，不是之后到达的一条消息。

**保留不动**：`_spawnParent` 及它的四个遍历函数（`_resolveAgentTreeRoot`、`_agentsShareTree`、`_collectAgentSubtreePostOrder`、`_pruneSpawnEdges`）。它们是运行时的内存图——路由、子树 dispose、`_agentsShareTree` 都靠它，与持久化无关。

**这一步要承认的代价**：之后 resume 不再恢复 subagent，`list_agents` 只剩内存里的 live agent。`agent-tree-persistence.md` §10 明说这正是最终行为减去 closed 条目，可以先落地；§11 第 2 条把它记为一次有意识的功能删除。

**为什么与 A 合批**：B 删掉的每一行都是 A 要修的代码的一部分。先删再修，A 的工作量直接变小。

---

### C. ref 写入、ref 事件、下行通道

> **落地状态**：C 的六个子项全部完成，含 navigate。navigate 的实际形状与本文原先的设想不同，见第 4 项下的说明。

`orchestrator-refactor.md` 的第 1、3、4 条。三条是一件事的三个面，必须一起做——只有第 1 条，background 写得出 ref 但闭合不了；只有第 4 条，闭合时无处可写。

1. **上行能力（第 1 条）**。orchestrator 内部开一个 core 侧的分支状态端口：请求方给 namespace 与 state root，orchestrator 用 `createPersistenceRefData` 构造载荷，经 `harness.appendCustomEntry(PERSISTENCE_REF_CUSTOM_TYPE, ...)` 写入。请求方不碰 harness、不构造 ref 载荷、不读整条分支。

   > **新增一处会话写入调用点。** 按 `AGENTS.md` 的规矩，落地时要向用户报告它写什么、为什么分支是对的位置。答案在 `background-job-persistence.md` §10：一条被回退掉的分支不应该看见另一条分支起的 job。

2. **反向读（第 1 条的另一半）**。`projection()` 走 `projectBranch(完整分支)`，只回本 namespace 那一份：当前在册的 state root（`null` 表示分支最后一次表态是清除，与"从未持有"不同）、provenance、该 namespace 在这条分支上的 ref 序列。**不把整条分支交出去。** 投影由框架统一计算，没有 per-namespace 覆写。

   形状不需要再抽象：`JobBranchPort`（`background/types.ts:468`）已经是它，`SessionJobStore.open` 已经在按这个形状调用。

3. **ref 事件（第 3 条）**。`OrchestratorEvent` 加一项，至少带：agent、namespace、新的 state root（含 `null`）、条目 id。条目 id 在写入被缓冲时缺席，补齐路径挂在已有的 `_observeSessionWrite` 上——那里已经在做 extension input presentation 的同类配对，形状可以照抄。

   理由：ref 改变的是"某个 namespace 在这条分支上是什么状态"，而这件事今天没有任何观察者能看见——TUI 看不见，extension 的 observed event union 里没有对应项，诊断里也没有。

4. **下行通道（第 4 条）**。resume / navigate / dispose 三个显式调用点，在延长分支之前给持有 namespace 的模块一次写入机会，带上原因。**v1 不做订阅**：只有一个消费者，等第二个真实需要它的 namespace 出现，这三个点再变成一次广播。

   三条次序约束是硬的，写错等于没写：

   | 时机 | 约束 | 出处 |
   |---|---|---|
   | dispose | 必须在 harness 关停**之前** | `background-job-persistence.md` §8.2 |
   | resume | 必须在 agent 变得可路由**之前** | 同上 §8.3 |
   | navigate | 只在分支即将被延长时写，只看不续的导航不留痕迹 | 同上 §4.3 |

   fork 不走这条通道——它发生在新会话里，走 namespace 自己的 `fork` 钩子，那个钩子已经实现（`job-persistence.ts:377`）。

   > **navigate 做了，但形状与设计文档不同，值得单独记一笔。**
   >
   > 原设计把导航当成闭合规则的第四个实例：闭合分支上开着、而运行时不认识的 job。实现时发现这个描述漏掉了导航特有的一种情况——**导航是同进程操作，所以「运行时不认识」不等于「结果不存在」**。一个 job 可能在被绕开的那条分支上已经跑完并写下了 `settled`；导航回到它启动之前，分支重新显示 open，而进程内的归约里明明白白记着结局和 t1 原文。
   >
   > 对这种 job 写 `closed(navigate)` 是说谎。所以 `SessionJobStore.rebind` 给出三种答案而不是两种：运行时还持有执行器的不动，运行时看着它结束的**把自己的 settled 重新记到这条分支上并把 t1 投递进去**，两者皆无的才闭合。边界是 `started` 记录必须在当前分支上——否则这条分支从没启动过它，哪怕结局就在对象日志里也不投递。
   >
   > 跨进程救不回来：`resume` 之后进程内的归约已经不在了，`closed(resume)` 在那里是诚实的。
   >
   > 另外两处与文档的偏差：
   >
   > 1. **重新投影是必须的，文档没提。** 叶子一移动，store 缓存的链头可能属于一条已经没人在的分支，之后的每次 append 都会挂在那条链上。`rebind` 第一件事就是按新分支重读。这是比闭合更严重的问题——它让「回退掉一条分支就回退掉它起的 job」这个性质失效。
   > 2. **写在导航当时，而不是分支「即将被延长」时**（`background-job-persistence.md` §4.3）。做成待决状态要把它穿进每一条写入路径。落地的取舍是：只看不续的导航会留下一条 custom 条目，它对那条分支是真陈述、不进模型上下文，比让 store 继续绑在一条已经离开的链上便宜。理由记在 `navigateAgentTree` 的注释里。

5. **接上 background**。`openOwnerStore` 从 `async () => undefined` 换成真实实现：按 agent 的会话目录算出 `<sessionDir>/persistence/<encoded:core:jobs>/`，`JobHistoryStorage.open` + `SessionJobStore.open`。ephemeral agent 继续返回 `undefined`，调用方按"不持久化"处理。

6. **`_reconcileCarriedOverJobs` 换判据**。今天它在分支文本里搜 `backgroundJobResultHeaderPrefix`，正是 `background-job-persistence.md` §1 要消灭的"拿没有信息当信息用"——文本被模型复述、被 compaction 改写、被用户粘贴，判断就错了。换成 `store.carriedOverJobs()`。

   `agent-tree-persistence.md` §8 顺带解决了这里最难的一处：subagent 永不跨运行时恢复之后，"任何 settler 都活不过一次 resume"是无条件成立的，所以这个方法无条件闭合全部 carried-over job 现在是一条正确陈述，不再是待修的近似。

   > **落地时多做了一件事：孤儿 t0。** t0 tool_result 由 harness 在 turn 内写下，而记录这个 job 的 ref 被缓冲在这一轮后面、要到保存点才落盘。两者之间的每一条条目都是导航可以落脚的地方，落在那里就得到一条"模型持有一个承诺、而分支从没启动过这个 job"的分支。`_announceOrphanedJobHandles` 扫分支上的 toolResult 条目，挑出 `details.backgrounded === true` 而 job 历史查无此人的，告诉模型这里不会有答案——**但不为它们写任何记录**，这条分支没有 `started` 可闭合，凭空造一条等于把 job 放到一条从没跑过它的分支上。
   >
   > 判据仍然是结构化的：`ToolResultMessage.details` 随消息整条持久化，`BackgroundJobStartedDetails` 只有运行时会写。而且这种孤儿分支上不可能有 t1——ref 在启动那一轮的保存点 flush，t1 在更晚的一轮到达，所以带 t1 的分支必然也带 ref——因此不需要退回文本搜索。

**这一项不依赖 D。** `background-job-persistence.md` §9 特意把分期切在这里：v1 只需要 ref 模式、分支投影、对象日志三样纯工具，不需要仓储的会话生命周期与 fork 闭包。已核对：`JobHistoryStorage.open` 只要 `{fs, dirPath, sessionKey, diagnostics, owner}`，而 `sessionKey` 在 session 依赖钩子被删（`b2e6c72`）之后只剩诊断用途。

**唯一的硬约束**：v1 的 namespace 目录必须落在与新仓储一致的相对位置（`<sessionDir>/persistence/<namespace>/`，见 `layout.ts:108` 的 `namespaceDirSegments`）。这样 D 迁移时只是会话目录改名，namespace 目录原地不动，v1 写下的 ref 和对象无需改动。

---

### D. session-manager 迁移到 `JsonlPersistenceRepo`

> **落地状态**：六个子项全部完成。会话寻址、嵌套、registry、fork 都已切换，`core/session-repo.ts` 已删。与本文原先设想的四处偏差记在本节末尾。

A–F 里最重的一项，也是唯一一项没有现成设计文档的。

1. `SessionManager` 的仓储从 `SessionDirectoryRepo` 换成 `JsonlPersistenceRepo`。寻址从 `JsonlSessionMetadata.path` 换成 `SessionAddress` / `SessionKey`，句柄从 `Session<JsonlSessionMetadata>` 换成 `PersistedSession`。
2. 目录命名规则变了（`layout.ts` 的 `createSessionDirName` vs `session-repo.ts` 的 `sessionDirName`）。旧会话在新布局下作为顶层会话打开，它的子会话作为独立的顶层会话存在——`agent-tree-persistence.md` §12 明说不做兼容读，恢复路径必须只有一条真相。
3. 在生产路径上第一次建 `PersistenceRegistry` 并注册 `createJobsNamespace()`。今天这一步在任何地方都没有做过。
4. 删除 `core/session-repo.ts`。
5. fork 从 `sessionRepo.fork` 换成 `repo.fork`，嵌套子目录复制随之生效。`_forkChildren` 已经按"复制 `listChildren` 下的全部子会话"写好（`jsonl-persistence.ts:571`），不需要改。
6. 修两个直接消费 `SessionManager` 的地方：`tui/session-hydrator.ts`、`tui/commands/built-ins.ts`。

**验收标准沿用 persistence 层自己的那条**：fork 之后删掉源目录，新会话仍然完整可读可恢复。

> **四处与本文设想不同的地方。**
>
> 1. **spawn 的嵌套要在这一批接上，本文没写。** 第 5 条说 fork 会复制嵌套子目录，但在此之前没有任何地方给 `repo.create` 传过 `parent`——不接这条线，`agents/` 永远是空的，批次 4 的 `list_agents` 读盘也就无物可读。所以 `createAgentSession` 收一个 `parentAgentId`，在 `_resolveAgentBuild` 的 `new` 分支由 `options.parent` 传入。父是 ephemeral 时没有目录可嵌套，子会话降级为顶层会话，与 `agent-tree-persistence.md` §1 一致。
> 2. **fork 的会话 id 由调用方给，`_forkInto` 改了一行。** 原来 fork 目标的目录名取 `options.sessionId`、而 header id 取源会话的 id，两者不一致；orchestrator 又是从 header id 取新 AgentId 的，照旧会与仍在运行的源 agent 撞名。改成 header 与目录名同用 `options.sessionId`，orchestrator 在 fork 之前先 `_allocateAgentId` 拿一个可读的 id。子会话递归复制时不传 id，保留它自己的身份——它的目录名本来就没变。
> 3. **来源改成 header 首行 metadata 里的一条显式记录。** 旧仓储把 fork 源写进 header 的 `parentSession`，TUI 的 `findForkSource` 和 extension 的 `parentRef` 都读它；新布局下 `_createAt` 往这个字段写的是嵌套父级（`agent-tree-persistence.md` §3），每个 subagent 都有，继续拿它推断 fork 会把整棵 spawn 树标成 fork。所以两种来源被拆成两个具名字段，写在 WIDI 自己的 metadata 里（`utils/session-origin.ts`）：
>
>    ```json
>    {"profile": {...}, "origin": {"spawnedBy": "<地址>", "forkedFrom": "<地址>", "forkEntryId": "..."}}
>    ```
>
>    - `spawnedBy` 是**树的事实**：谁的目录装着我。每个 spawn 出来的会话都有。
>    - `forkedFrom`（可带 `forkEntryId`）是**内容的事实**：我的历史是从谁那里复制来的。只有 fork 有。
>    - 两者可以同时存在：跟着父会话一起被复制过去的子会话，`spawnedBy` 是新的父、`forkedFrom` 是源树里的那个子会话。
>
>    用地址而不是路径，与运行时其它所有引用一致。**由仓储写、且每次重算**，不从源 header 抄——这是唯一能在 fork 之后仍然为真的写法：被复制的子会话的 `spawnedBy` 必须指向新父级，照抄会指回被复制的那棵树。
>
>    消费方：`AgentSnapshot` 增加 `sessionRef`（会话地址），TUI 的 fork 血缘先认 `agent_session_forked` 事件、否则读 header 的 `forkedFrom` 并按 `sessionRef` 在活 agent 里找源——跨运行时的 fork 血缘因此仍然显示。extension 的 `ExtensionSessionCandidate.parentRef` 改名为 `forkedFromRef`，语义收窄成"我是从谁 fork 出来的"（`listSessions` 只列顶层会话，spawn 关系不在这个列表的语义里）。
> 4. **registry 的家在 `core/persistence-registry.ts`。** `createCorePersistenceRegistry()` 一个函数，生产路径与测试都从这里拿。namespace 少一个的后果是它的 ref 与目录被原样留下、状态不解析，所以"这个 build 有哪些 namespace"是一条该有唯一出处的事实。批次 F 的 extension 注册以后接在这里。

---

### E. `list_agents` 读盘

语义从"列出运行时内存里我这棵树的活 agent"改成"列出我的会话下的子会话，并标出哪些正在运行"（`agent-tree-persistence.md` §6）。

> **前提已具备**（批次 3）：spawn 出来的会话确实嵌在父会话目录下，`repo.listChildren` 读得到；`SessionManager.getAgentSessionAddress` 给出当前 agent 的地址作为递归起点；`AgentSnapshot.sessionRef` 让内存里的 live agent 与盘上的目录能对上号——这正是第 2 条"目录是全集，内存是子集"的合并键，比按 AgentId 匹配可靠（第 3 条说的就是 AgentId 会撞车）。

1. orchestrator 开一条通往 `repo.listChildren` 的路径，递归，深度受 `MAX_SESSION_DEPTH` 约束。
2. 合并规则：**目录是全集，内存是子集。** 一个目录在内存里有对应的 live agent 就是 running，否则是 closed。
3. 条目身份改成**目录名**，AgentId 只作显示——resume 之后 AgentId 会被复用，一个 closed 条目的 AgentId 可能与一条 live 条目撞车。
4. 输出保留层级。列表里可能有几十个 closed 条目，扁平列表读不出谁是谁的子女。
5. `list-agents.ts` 现在的注释写着 "Disposed agents are omitted entirely"，这条正好反过来。
6. `send_message` / `dispose_agent` 的工具描述必须写明 closed 条目不可操作。否则模型看见一个 id 就会去用它。

> **落地状态**：完成（批次 4）。三条偏离本节写法的地方，都在实现里写了理由：
>
> - **第 3 条改成了「身份是完整 ref，且 closed 条目不显示 AgentId」。** 深度 ≥ 2 时单独一个目录名不可寻址（`parseSessionKey` 收的是 `root/child`），而完整 ref 正是 `/resume` 已经在收的形式。至于 AgentId：本节自己列的 closed 条目两个用途都不需要它，显示它只会制造第 6 条想避免的那个动作。类型上做成了判别联合，running 才有 `agentId`。
> - **递归锚点是内存树根的目录，只向下不向上。** 一个从别人树里 resume 出来的会话，向上走会把它从未 spawn 过的兄弟子树一并拖进来。
> - **磁盘读失败降级而不抛。** 谁在运行是内存单独就能回答的，为一次文件系统故障丢掉这个答案不划算：发 `orchestrator.session_tree_unreadable`，列表照出，文末说明 closed 部分不可读。
>
> 落地过程中修掉的两个界外 bug（都不在本节范围内，但都由这一批的验证暴露）：
>
> - **AgentId 改成 `<profile>-<4 位 base36 随机>`**（原来是 profile label + `-2`/`-3` 计数）。旧规则只在单次运行内唯一，而会话目录名是 `<秒级时间戳>_<AgentId>`：resume 一个根之后它的第一个孩子必然又叫 `worker-agent`，与上一次运行同秒时目录名逐字节相同，而 `_createAt` 用 `writeFile` 建 header——不报错，直接把上一个会话的历史截断。`layout.ts` 里时间戳前缀的职责随之改写：它现在只负责让容器按时间排序，唯一性由 id 自己保证。
> - **`_newSessionKey` 加了目录占用检查**（占用则加 `-2` 后缀）。随机 id 把碰撞压到 10⁻⁶ 量级，这条把它压到 0。
> - **resume 时 header id 若被另一个会话的 live agent 占用，另分配 AgentId。** header id 是「创建这个会话的 agent 叫什么」，不是地址；两次运行写的两个会话可以带同一个 id，而 `spawnAgent` 那句 `if (this._live.has(request.agentId)) return request.agentId` 会把已经在跑的那个 agent 静默还给调用方。批次 3 之后会话按 address 寻址，所以换 id 不需要改盘上任何字节。

---

### F. extension 的 persistence 注册

`orchestrator-refactor.md` §2 与 `persistence-ref-writer.md` §11 都写了 v1 不做。今天一个 extension 消费者都没有，内置 namespace 走 core 那条通道。

真正被推迟的是**经纪那一半**：extension 卸载后已注册的 namespace 怎么办、同一个名字被两个 extension 争抢时如何裁决、namespace 名字如何由 extension id 派生（`NAMESPACE_PATTERN` 在 `custom-storage.ts:288`，要求 `owner:name` 且只收小写字母数字和连字符，而 extension id 未必满足）。

**本次唯一要做的**：在 `ExtensionActivationApi` 旁边留一条注释，写明这道入口将来的准入标准是"**状态是不是对话的函数**"，不是"我想不想持久化"。理由见 `persistence-ref-writer.md` §3.1——进来之后回退就不再可选，一个缓存了 OAuth token 的 namespace 进来，用户回退一次对话就把自己登出了。这句话必须以 API 文档的形式写着，而不是留给 extension 作者推断。

---

### G. orchestrator message

这一项是 C 落地过程中长出来的，不在原来的六项里。

**问题**：「不是用户输入、但必须以用户输入的身份进入模型」的文本，今天有五个生产者、两套互不相识的机制，而且在 TUI 里全都渲染成用户消息。

| 生产者 | 怎么进模型 | 唤醒 agent | TUI 里长什么样 |
|---|---|---|---|
| background t1 | `sendMessage(mode:"interrupt")` → prompt / steer | 是 | 用户消息 |
| resume 未答 t0 | `harness.appendMessage` | 否 | 用户消息 |
| spawn tree 关闭通告 | `harness.appendMessage` | 否 | 用户消息 |
| navigate 回放 t1 / 孤儿 t0 | `harness.appendMessage` | 否 | 用户消息 |
| extension `publishMessage` | `core:extension_message` custom 条目 | 否 | 有自己的渲染 |

前四行是同一件事的四种写法。最后一行证明「有自己的渲染」这条路走得通，只是它绕开了模型上下文。

**要用的 primitive 上游已经有了，widi 一行没用**：`custom_message` 条目。不是 `appendCustomEntry`——那个不进上下文（`session.ts:135`，`custom` 条目没注册 entry projector 就产出空数组）。

```
持久化    {type:"custom_message", customType, content, display, details}
进上下文  role:"custom" 的 AgentMessage        session.ts:114
进 LLM    role:"user"，content 原样            messages.ts:133
```

模型看到纯 user 文本，会话里存的是带类型的条目。这就是「在 TUI 层区分渲染」需要的全部，不需要新的条目类型。`appendCustomMessageEntry` 已经在 harness 的写入 API 里。

1. **一个 orchestrator 内部的消息队列**，所有上表前四行的生产者改走它。入队带一个档位：

   | 档位 | 语义 |
   |---|---|
   | `steer` | 打断当前这一轮，现在就读 |
   | `follow_up` | 这一轮结束时读 |
   | `precede` | 不唤醒，附在用户下一次输入之前 |

   `precede` 不叫 `prompt`：`harness.prompt()` 是「立刻起一轮」，同一个词两个意思在这个文件里迟早出事。它描述的正是 resume 通告与 navigate 回放今天的实际行为——今天那是「写进分支然后碰运气」，具名之后「谁在等这条被读到」才是可查询的。

2. **transform 在入队之前跑完，不进条目。** 闭包不可持久化，而条目要落到分支上：一条在投递前被缓冲、进程重启、或被 fork 带走的消息，会失去它的 transform，重放出的文本与当初进模型的不一致。队列里存最终文本，`details` 里存原文、产生者、经过了哪些 transform——与 `core:input_transform` 今天的纪律一致。

3. **hydrator 与渲染**：`tui/session-hydrator.ts` 加 `custom_message` 分支，按 `customType` 分派渲染规则，与用户消息区分开。

**v1 只做投递侧。** extension 的 transform 挂载点、以及把 `_pendingExtensionInputPresentations` 那套「user 消息 + custom 配对条目」的双记录并进来，都推迟：双记录确实是 orchestrator message 的一个特例（`details` 里放 presentation，`_observeSessionWrite` 能少一半），但它碰 extension 的公开面，范围比加一个队列大得多。等这一层有了真实用户，接口形状从两个实现里抽，而不是照着设想编。

**这一项不依赖 C / D / E。** 它动的是消息进入模型的路径，与状态存在哪里无关。

---

## 4. 依赖关系

```
                      ┌───────────────────────────────┐
                      │  批次 1                        │
                      │  A 接线 ── 合批 ── B 简化      │
                      │  判据：npm run check 归零      │
                      └───────────────┬───────────────┘
                                      │
                 ┌────────────────────┴────────────────────┐
                 │                                         │
                 ▼                                         ▼
      ┌─────────────────────┐                   ┌─────────────────────┐
      │  批次 2              │                   │  批次 3              │
      │  C ref 写入 / 事件   │                   │  D session-manager   │
      │    / 下行通道        │                   │    迁移到新仓储      │
      │  → background 闭合   │                   │  → fork 生效         │
      └──────────┬──────────┘                   └──────────┬──────────┘
                 │                                         │
                 │  C 与 D 无依赖，可并行                    │
                 │  （background-job-persistence.md §9）     │
                 │                                         ▼
                 │                              ┌─────────────────────┐
                 │                              │  批次 4              │
                 │                              │  E list_agents 读盘  │
                 │                              └─────────────────────┘
                 │                                         │
                 └────────────────────┬────────────────────┘
                                      │  C 的 fork 半边在 D 之后自动生效
                                      ▼
                           ┌─────────────────────┐
                           │  F extension 注册    │
                           │  等第一个真实消费者  │
                           └─────────────────────┘

      ┌─────────────────────┐
      │  批次 5              │   G 与上面整条链无依赖：它动的是消息
      │  G orchestrator      │   进入模型的路径，不是状态存在哪里。
      │    message           │   排在 C 之后只是因为 C 又添了两个
      │  → 渲染可区分         │   走 appendMessage 的生产者。
      └─────────────────────┘
```

四条边值得单独说明：

- **C 与 D 解耦**，这是 `background-job-persistence.md` §9 特意设计的分期，不是巧合。实际是先 C 后 D，D 落地时 C 写下的 ref 与对象一行没改——分期的前提兑现了。
- **E 严格依赖 D**，无法提前。`list_agents` 要读 `repo.listChildren`，D 之前运行时还在旧仓储上，两者互相看不见。**两者都已落地**，这条边如期兑现：E 一行仓储代码都没改，只是把 D 建好的嵌套读了出来。
- **B 可以先于 D 做**（`agent-tree-persistence.md` §10 的"在此之前唯一可以先做的是删除"）。代价是那段时间失去 subagent 跨 resume 恢复，但那个能力本来就要被删。
- **G 谁都不依赖**，随时可插。它排在这里是因为 C 把 `appendMessage` 的生产者从两个添到了四个——同一件事的四种写法，再拖就是第五种。

---

## 5. 分批计划

| 批次 | 内容 | 完成标志 | 可交付的用户可见变化 |
|---|---|---|---|
| 1 ✅ | A + B 合批 | `npm run check` 归零；`npm run tui` 能完成一轮对话 | 无（纯内部）。resume 不再恢复 subagent |
| 2 ✅ | C：三条要求 + background 接入 | job 历史跨 resume 可读，`read_job` 能查到上一个运行时的 job | t0 悬着的承诺不再靠文本搜索判断；`read_job` / `list_jobs` 跨 resume 可用 |
| 3 ✅ | D：session-manager 迁移 | 生产路径上第一次出现 `JsonlPersistenceRepo`；fork 之后删源目录，新会话仍完整可读 | fork 会话带走 job 历史与子会话目录；spawn 出来的 agent 的会话嵌在父会话目录下 |
| 4 ✅ | E：`list_agents` 读盘 | 一份 fork 或 resume 出来的树全部列为 closed | 模型能看见自己以前做过什么 |
| 5 | G：orchestrator message | 上表前四行的生产者全部改走队列；hydrator 能按 `customType` 分派 | 运行时替模型写的话不再伪装成用户自己打的字 |
| — | F | 等第一个真实 extension 消费者 | — |
| — | 清偿批次 1 的测试欠账 | `npm run test` 归零 | 无（但在此之前，非持久化行为没有测试兜底） |

批次 5 不依赖任何其它批次。**测试欠账那一行没有编号，因为它不是排期的一环而是一笔债**——见第 7 节风险 1，它越晚清偿，越难判断某条失败是本来就坏的还是新弄坏的。

---

## 6. 已定的取舍

这些是上游文档已经拍板的，列在这里是为了避免实施时重新讨论：

- **subagent 不跨运行时恢复。** 父子关系由会话目录嵌套表达，不由任何分支状态表达（`agent-tree-persistence.md` §1）。
- **fork 复制整棵目录，不做分支可见性筛选。** 少复制一个目录省下的是磁盘，多复制一个目录保住的是一份可读的历史（同上 §4）。
- **`agents/` 只增不减，没有回收机制，也不打算加。** 自动回收需要一条"这个子会话再也用不到了"的判据，而这个判据不存在（同上 §12）。
- **不在 harness 里加 hook。** 上行不需要（`appendCustomEntry` 已经是），下行属于 orchestrator 的知识（`persistence-ref-writer.md` §11）。
- **投影不可覆写。** "分支上哪条 ref 在生效"由框架统一计算，否则回退的含义会随会话恰好持久化了什么而变（同上 §7.1）。
- **不做 ref 的撤销。** 分支是 append-only 的，要"取消"正确的动作是回退（同上 §11）。
- **`resume_agent(sessionDirName)` 逃生口不在本次范围。** 若 `agent-tree-persistence.md` §11 第 2 条成为真实痛点再独立决定（同上 §13）。

---

## 7. 风险

**1. 批次 1 的测试修复量被低估。**（**已发生，仍未清偿**）72 个测试错误分布在 30 多个文件里，这些不全是机械替换——`agent_status_changed` 从 `status` 换到 `activity` 改变的是断言的语义，需要逐条判断原测试想验证什么。

类型错误当时是修完了（`npm run check` 归零），但**运行时行为没有跟着修完**：今天 `npm run test` 仍有 65 条失败，症状是 `Unknown agent`、`Agent … is gone.`、`_handleSubscribedAgentHarnessEvent is not a function`，集中在 agent 生命周期与事件桥接上。批次 2、3 都逐条比对过失败用例名字集合，确认自己没有增删——但这层欠账一直挂着，它意味着**这条分支上除持久化以外的行为没有测试兜底**。清偿它应该排在批次 4 之前，或者至少作为一个独立批次显式承认。

**2. 批次 3 的目录改名没有迁移路径。**（**未发生**）担心的是用户现有会话在新布局下变成孤立的顶层会话。实际不成立：旧布局根本没有嵌套，盘上每个会话本来就是顶层的，目录名规则变化只影响**新建**的会话。已用真实的 `.widi/runs`（12 个旧布局会话）验证——全部照常列出、按地址可解析可 resume。

**3. 批次 2 新增的会话写入调用点是永久的。**（**已接受**）分支是 append-only 的，ref 一旦开始写就永远留在所有已经产生的会话分支上。`core:jobs` 的准入理由是充分的（job 历史就该被回退掉）。

**4. C 的三个下行调用点次序错了不会立刻显形。** dispose 写晚了等于没写，resume 写晚了会把上下文变成一条迟到的消息。两者都不会抛错，只会在下一次 resume 时表现为"一个已死的 job 看起来还开着"。这三处需要测试直接锁次序，而不是只测结果（`tests/core/orchestrator-branch-state.test.ts`）。

**5. 会话 header 的 metadata 现在有两个 WIDI 自己的字段。**（批次 3 新增）`profile` 与 `origin`（见 D 的偏差 3）。它们写在创建会话的那一行上，此后不再改写，所以不像分支写入那样只能增不能减——但它们是**每个会话都有**的，改形状就等于新老会话读法不同。`parseSessionOrigin` 对不合形状的内容一律当作没有，这是为了让以后加字段不会让旧会话打不开；新增字段时要保持这条纪律。
