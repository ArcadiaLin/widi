# Orchestrator 接线与持久化落地：实施排期

面向 `apps/widi-pi/src/core/`。前置阅读：`docs/ZH/orchestrator-refactor.md`、`docs/ZH/persistence-ref-writer.md`、`docs/ZH/agent-tree-persistence.md`、`docs/ZH/background-job-persistence.md`。

那四份文档各自描述一件事该长什么样。本文不重复它们的设计，只回答三个问题：**现在到底停在哪、每项工作要动哪些文件、哪些工作卡着哪些工作**。

---

## 1. 现状盘点

以下是分支 `orchestrator-refactor` 的事实陈述，不含判断。

| 模块 | 状态 |
|---|---|
| `orchestrator/agent-orchestrator.ts`（新，4542 行） | 自身类型 0 错误，**零导入方** |
| `core/agent-orchestrator.ts`（旧，4538 行） | 54 个类型错误，仍是 `runtime-service.ts` 的依赖 |
| `core/persistence/*`（约 2000 行 + 7 个测试文件） | 完整、有测试，**零生产调用方**。`JsonlPersistenceRepo` 与 `PersistenceRegistry` 只出现在 `tests/` 里 |
| `background/*` | 重构完成。`JobBranchPort` 已按 `persistence-ref-writer.md` §10 收窄成 `projection()` / `commit()`（`background/types.ts:468`），`SessionJobStore` 完整 |
| `session-manager.ts` | 仍用 `SessionDirectoryRepo`，与 `JsonlPersistenceRepo` 目录命名规则不同、互相看不见 |
| 下游（`tools/jobs/*`、`tools/agents/*`、`tui/*`） | 未跟上新词汇 |

`npm run check` 的结果是 **185 个错误**：54 个在旧 orchestrator，59 个在其它 `src/` 文件，72 个在 `tests/`。

`src/` 那 59 个不是新 orchestrator 的问题，是 background 与 orchestrator 的词汇已经换过而下游没跟上：

- `BackgroundJobTable` / `BackgroundJob` → `BackgroundJobRuntime` / `BackgroundJobSnapshot`
- `core/agent-record.ts` 已删（`dfe0d5a`）
- `AgentLifecycleStatus` 已删，`agent_status_changed` 事件只剩 `activity` / `previousActivity` / `maintenance`
- `ToolAgentHost.send` / `settleTask` → `sendMessage` / `settler`
- `AgentBrief.addressable` / `status` → `activity`

另有两处 stub，是设计已定但接线未做的位置：

- `orchestrator/agent-orchestrator.ts:627`：`openOwnerStore: async () => undefined`，注释里直接指向 `orchestrator-refactor.md`。每个 owner 因此都是 ephemeral——job 照跑，但不留历史。
- `agent-tree-persistence.md` §9 的删除清单**一条都没执行**。新 orchestrator 3217–3470 行的 "Spawn tree persistence" 整节仍在。

---

## 2. 排期的形状

**不存在"先做持久化、再接线"这个选项。**

旧 orchestrator 已经编不过，新的没有任何导入方。今天写下的任何持久化改动都落在一条不能通过 `npm run check` 的分支上，没有可运行的路径去验证它。接线因此不是六项工作里的一项，它是其余五项的地基。

由此得到第一条排期纪律：**批次 1 的完成判据是 `npm run check` 归零**，在那之前不开始任何持久化工作。

---

## 3. 六项工作

### A. 接线新 orchestrator

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

5. **接上 background**。`openOwnerStore` 从 `async () => undefined` 换成真实实现：按 agent 的会话目录算出 `<sessionDir>/persistence/<encoded:core:jobs>/`，`JobHistoryStorage.open` + `SessionJobStore.open`。ephemeral agent 继续返回 `undefined`，调用方按"不持久化"处理。

6. **`_reconcileCarriedOverJobs` 换判据**。今天它在分支文本里搜 `backgroundJobResultHeaderPrefix`，正是 `background-job-persistence.md` §1 要消灭的"拿没有信息当信息用"——文本被模型复述、被 compaction 改写、被用户粘贴，判断就错了。换成 `store.carriedOverJobs()`。

   `agent-tree-persistence.md` §8 顺带解决了这里最难的一处：subagent 永不跨运行时恢复之后，"任何 settler 都活不过一次 resume"是无条件成立的，所以这个方法无条件闭合全部 carried-over job 现在是一条正确陈述，不再是待修的近似。

**这一项不依赖 D。** `background-job-persistence.md` §9 特意把分期切在这里：v1 只需要 ref 模式、分支投影、对象日志三样纯工具，不需要仓储的会话生命周期与 fork 闭包。已核对：`JobHistoryStorage.open` 只要 `{fs, dirPath, sessionKey, diagnostics, owner}`，而 `sessionKey` 在 session 依赖钩子被删（`b2e6c72`）之后只剩诊断用途。

**唯一的硬约束**：v1 的 namespace 目录必须落在与新仓储一致的相对位置（`<sessionDir>/persistence/<namespace>/`，见 `layout.ts:108` 的 `namespaceDirSegments`）。这样 D 迁移时只是会话目录改名，namespace 目录原地不动，v1 写下的 ref 和对象无需改动。

---

### D. session-manager 迁移到 `JsonlPersistenceRepo`

六项里最重的一项，也是唯一一项没有现成设计文档的。

1. `SessionManager` 的仓储从 `SessionDirectoryRepo` 换成 `JsonlPersistenceRepo`。寻址从 `JsonlSessionMetadata.path` 换成 `SessionAddress` / `SessionKey`，句柄从 `Session<JsonlSessionMetadata>` 换成 `PersistedSession`。
2. 目录命名规则变了（`layout.ts` 的 `createSessionDirName` vs `session-repo.ts` 的 `sessionDirName`）。旧会话在新布局下作为顶层会话打开，它的子会话作为独立的顶层会话存在——`agent-tree-persistence.md` §12 明说不做兼容读，恢复路径必须只有一条真相。
3. 在生产路径上第一次建 `PersistenceRegistry` 并注册 `createJobsNamespace()`。今天这一步在任何地方都没有做过。
4. 删除 `core/session-repo.ts`。
5. fork 从 `sessionRepo.fork` 换成 `repo.fork`，嵌套子目录复制随之生效。`_forkChildren` 已经按"复制 `listChildren` 下的全部子会话"写好（`jsonl-persistence.ts:571`），不需要改。
6. 修两个直接消费 `SessionManager` 的地方：`tui/session-hydrator.ts`、`tui/commands/built-ins.ts`。

**验收标准沿用 persistence 层自己的那条**：fork 之后删掉源目录，新会话仍然完整可读可恢复。

---

### E. `list_agents` 读盘

语义从"列出运行时内存里我这棵树的活 agent"改成"列出我的会话下的子会话，并标出哪些正在运行"（`agent-tree-persistence.md` §6）。

1. orchestrator 开一条通往 `repo.listChildren` 的路径，递归，深度受 `MAX_SESSION_DEPTH` 约束。
2. 合并规则：**目录是全集，内存是子集。** 一个目录在内存里有对应的 live agent 就是 running，否则是 closed。
3. 条目身份改成**目录名**，AgentId 只作显示——resume 之后 AgentId 会被复用，一个 closed 条目的 AgentId 可能与一条 live 条目撞车。
4. 输出保留层级。列表里可能有几十个 closed 条目，扁平列表读不出谁是谁的子女。
5. `list-agents.ts` 现在的注释写着 "Disposed agents are omitted entirely"，这条正好反过来。
6. `send_message` / `dispose_agent` 的工具描述必须写明 closed 条目不可操作。否则模型看见一个 id 就会去用它。

---

### F. extension 的 persistence 注册

`orchestrator-refactor.md` §2 与 `persistence-ref-writer.md` §11 都写了 v1 不做。今天一个 extension 消费者都没有，内置 namespace 走 core 那条通道。

真正被推迟的是**经纪那一半**：extension 卸载后已注册的 namespace 怎么办、同一个名字被两个 extension 争抢时如何裁决、namespace 名字如何由 extension id 派生（`NAMESPACE_PATTERN` 在 `custom-storage.ts:288`，要求 `owner:name` 且只收小写字母数字和连字符，而 extension id 未必满足）。

**本次唯一要做的**：在 `ExtensionActivationApi` 旁边留一条注释，写明这道入口将来的准入标准是"**状态是不是对话的函数**"，不是"我想不想持久化"。理由见 `persistence-ref-writer.md` §3.1——进来之后回退就不再可选，一个缓存了 OAuth token 的 namespace 进来，用户回退一次对话就把自己登出了。这句话必须以 API 文档的形式写着，而不是留给 extension 作者推断。

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
```

三条边值得单独说明：

- **C 与 D 解耦**，这是 `background-job-persistence.md` §9 特意设计的分期，不是巧合。可以并行，也可以先 C 后 D。先 C 能让 background 立刻拿到"跨 resume 的 job 历史"，是六项里对用户最可见的收益（§10：`read_job` 与 `list_jobs` 跨 resume 可用）。
- **E 严格依赖 D**，无法提前。`list_agents` 要读 `repo.listChildren`，而运行时今天还在旧仓储上，两者互相看不见。在 D 之前 `list_agents` 只有 live agent——那是最终行为的子集，不是错误行为。
- **B 可以先于 D 做**（`agent-tree-persistence.md` §10 的"在此之前唯一可以先做的是删除"）。代价是那段时间失去 subagent 跨 resume 恢复，但那个能力本来就要被删。

---

## 5. 分批计划

| 批次 | 内容 | 完成标志 | 可交付的用户可见变化 |
|---|---|---|---|
| 1 | A + B 合批 | `npm run check` 归零；`npm run tui` 能完成一轮对话 | 无（纯内部）。resume 不再恢复 subagent |
| 2 | C：三条要求 + background 接入 | job 历史跨 resume 可读，`read_job` 能查到上一个运行时的 job | t0 悬着的承诺不再靠文本搜索判断；`read_job` / `list_jobs` 跨 resume 可用 |
| 3 | D：session-manager 迁移 | 生产路径上第一次出现 `JsonlPersistenceRepo`；fork 之后删源目录，新会话仍完整可读 | fork 会话带走 job 历史与子会话目录 |
| 4 | E：`list_agents` 读盘 | 一份 fork 或 resume 出来的树全部列为 closed | 模型能看见自己以前做过什么 |
| — | F | 等第一个真实 extension 消费者 | — |

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

**1. 批次 1 的测试修复量被低估。** 72 个测试错误分布在 30 多个文件里，其中 `tests/tui/event-projector.test.ts` 一个文件 17 个。这些不全是机械替换——`agent_status_changed` 从 `status` 换到 `activity` 改变的是断言的语义，需要逐条判断原测试想验证什么。

**2. 批次 3 的目录改名没有迁移路径。** 用户现有的会话在新布局下作为顶层会话打开，子会话变成独立的顶层会话。这是文档明确接受的（"恢复路径必须只有一条真相"），但落地时应当在 `/resume` 列表里能看出这件事发生了，而不是让用户以为会话丢了。

**3. 批次 2 新增的会话写入调用点是永久的。** 分支是 append-only 的，ref 一旦开始写就永远留在所有已经产生的会话分支上。`core:jobs` 的准入理由是充分的（job 历史就该被回退掉），但这条写入点的形状值得在落地时再核一遍 `persistence-ref-writer.md` §3.2。

**4. C 的三个下行调用点次序错了不会立刻显形。** dispose 写晚了等于没写，resume 写晚了会把上下文变成一条迟到的消息。两者都不会抛错，只会在下一次 resume 时表现为"一个已死的 job 看起来还开着"。这三处需要测试直接锁次序，而不是只测结果。
