# Agent 树的组织与恢复

面向 `apps/widi-pi/src/core/persistence/` 与 `apps/widi-pi/src/core/`。前置阅读：`docs/ZH/persistence.md`。

本文替换先前的 `core:subagent` 设计。那份设计把成员关系做成父分支上的 persistence ref，本文取消它。

> **本文已全部落地**（`orchestrator-wiring-plan.md` 批次 1、3、4）。§9 的删除清单与 §10 的接线前提因此成了记录而非计划，各自节内有标注；§6 的 `list_agents` 语义在落地时改了两处，改动与理由写在该节。其余各节描述的是今天的实际行为。

---

## 1. 决定

**agent 之间的父子关系由会话目录表达，不由任何分支状态表达。一次运行结束，它 spawn 出来的全部 subagent 就结束了。**

三条直接推论：

- 没有 `core:subagent` namespace，没有成员记录，没有 ref。
- fork、resume、navigate 都不恢复任何 subagent。在新的运行时里它们一律是 closed。
- fork 复制整棵目录子树，不做分支可见性筛选。

模型仍然看得见这些 subagent——通过 `list_agents`，作为盘上确实存在的会话目录，标注为 closed。见第 6 节。

---

## 2. 为什么取消成员 ref

分支 ref 唯一买到的性质是：**回退到一次 spawn 之前，那个 subagent 不存在。**

这个性质只有在"存在"能被兑现时才有价值——也就是说，只有当某处会把一个分支承认的成员真的恢复成一个活的 agent 时，它才值钱。subagent 不再跨运行时恢复之后，回退取消掉的只是一条没人会兑现的记录。

而要让这条记录成立，代价是一整条链：

| 需要什么 | 因为 |
|---|---|
| 转移链（记录依赖上一条记录） | `projectBranch` 每个 namespace 只保留最后一条 ref 的 stateRoot（`state-projection.ts:69-77`），N 次 spawn 必须塞进一个 stateRoot |
| `CustomStorage.listSessionDependencies` | fork 闭包要能从对象走到子会话目录（`fork-closure.ts:172`） |
| 记录里存目录名而非 `SessionKey` | fork 复制子会话时保留目录名但更换父级，绝对 key 在被复制的那一刻就指回源树 |
| orchestrator 逐层重建 + AgentId 重映射 | AgentId 只在单次运行内唯一 |
| 三处边界处理 | nesting_limit 撕开父子关系、ephemeral 无分支可写、写失败不回滚 install |
| 与 `core:jobs` 的 settler 身份对齐 | 一个委派 task 的 settler 是 subagent，resume 时"它会不会回来"决定这个 job 该不该闭合 |

全部成本换来的是那一个性质。取消它，上表整个消失。

**结构本身没有丢。** 树的形状本来就在目录嵌套里，ref 从来只提供一层"这条分支看得见哪些"的过滤。去掉的是过滤，不是结构。

---

## 3. 目录布局保留

`utils/layout.ts` 的两条规则原样有效，本次改动不碰：

1. 一个会话目录拥有它的历史、它的 custom storage、以及它 spawn 出来的会话的目录。ownership、lifetime、copyability 三者都跟着目录走。
2. 子目录放在 `agents/` 下而不是与 `session.jsonl` 并列。

由此继续免费获得：

- `SessionKey` 的前缀就是祖先链，`parentSessionKey` 可用（`layout.ts:133`）。
- 删除一个根会连带删除它的整棵子树（`repo.delete` 对目录 `rm -rf`）。
- `repo.list()` 只列顶层会话，子会话不进 session picker（`jsonl-persistence.ts:184-187`）。
- session header 的 `parentSession` 字段是同一事实的绝对路径形式，由 `_createAt` 写入。

**两个 sidecar 删除**：根的 `agents/tree.jsonl` 与子会话的 `agents/parent.json`。目录嵌套已经表达了它们表达的全部内容，而且表达得更好——它们是被回退撕碎的那两份，目录不是。

---

## 4. fork

`_forkChildren` 的输入从 `plan.sessions` 改成 `repo.listChildren(source)`，即复制源会话 `agents/` 下的每一个子会话。

保留不变：`forking` 集合防环、`canNestUnder` 的深度降级与 `persistence.nesting_limit`、单个子会话失败时的 `persistence.child_not_copied` 隔离、递归形状（`_forkInto` 自调用）。

### 为什么复制全部

分支筛选唯一能省掉的，是"这条分支已经回退掉的那些子会话"。它们在新会话里反正也是 closed，少复制一个目录省下的是磁盘，多复制一个目录保住的是一份可读的历史。选后者。

代价是真实的，写在第 10 节。

### 子会话仍在自己的当前 leaf 被复制

`_forkInto` 对子会话传 `options: {}`，不带 fork 点。这一点从旧设计里的一个取舍变成了唯一可能——没有任何东西记录过一个子会话在父的某个时刻处于哪个 leaf，也不打算记录。

`jsonl-persistence.ts:580-584` 的注释仍然是这条规则的说明。

### fork 的自足性换了保证方式

原来是"复制分支点名的闭包"，现在是"复制整棵目录"。检验标准不变：**fork 之后删掉源目录，新会话仍然完整可读可恢复。**

---

## 5. resume 与 navigate

都不做任何事。

- **resume**：根单独打开。它的 `agents/` 下有什么，运行时不问，也不拉起。
- **navigate**：不影响任何目录。回退不删除子会话，前进也不创建。

没有 `_restoreSpawnTree`，没有逐层递归，没有 AgentId 重映射，没有部分恢复的对账。

### 一条 resume 时的告知

根 resume 之后，它的上下文里可能写着"我 spawn 了 coder-1 并给了它任务"，而 coder-1 不存在。模型需要被告知这一点，否则它会对着一个不存在的 agent 说话。

这条告知比旧设计的 `_publishTreeResumeReconciliation` 简单得多：它是**无条件的、一句话的、不带任何成员清单的**——"这次恢复之前你创建的全部 agent 都已经关闭；需要的话重新创建"。没有部分恢复，就没有需要逐个描述的成员。

它仍然是一处 `harness.appendMessage` 会话写入调用点，理由不变：它必须是 resume 时就在上下文里的事实，不是之后到达的一条消息。

`list_agents` 随后会把那些 closed 的条目列出来，所以这条消息不需要枚举它们。

---

## 6. `list_agents` 的新语义

从"列出运行时内存里我这棵树的活 agent"改成：**列出我的会话下的子会话，并标出哪些正在运行。**

### 两个数据源

| 来源 | 提供 |
|---|---|
| 内存 `_live` + `_spawnParent` | 哪些正在运行，以及它们的 activity |
| 磁盘 `repo.listChildren` 递归 | 全集：每个子会话的目录名、sessionId、createdAt |

合并规则：**目录是全集，内存是子集。** 一个目录在内存里有对应的 live agent 就是 running，否则是 closed。

### 为什么这是对的

它陈述的是一个可验证的事实——"你的会话目录下有这些子会话，其中这几个正在跑"——而不是一个需要被维护的声明。一份 fork 或 resume 出来的树全部是 closed，这正是真相。

旧设计里那个"孤儿"问题在这里以另一种方式消解：父回退到某次 spawn 之前，那个目录仍在盘上，仍被列为 closed。模型的上下文里没有它、列表里有它，两者都是真的，而列表明确说了它已经关闭。**没有任何一方在声称一件需要被兑现的事。**

注意 `list-agents.ts` 原来的注释写着 "Disposed agents are omitted entirely"，这条正好反过来。

### 只列调用者自己那一层

`list_agents` 锚定**调用者**，列它自己与它的直接子女，再往下不展开；被隐藏的条目以 `(+N nested)` 计数，并告诉模型下一层要向哪个 running agent 要。

> 本节此前的写法是「保持整棵树，不收窄到一层」，理由是「否则一个孙子的 id 就发现不了」。那条理由不成立：**跨级寻址从来不走发现**。worker 回复 owner 用的是任务消息里带的 `ownerAgentId`（`tools/agents/shared.ts` 的 `formatAgentTaskMessageBody`），`send_message` 接受任何精确 id，无论它在哪一级、哪棵树。发现只决定「模型能自己找到谁」，而一个 agent 需要自己找到的，就是它自己 spawn 的那些。

锚点必须是调用者而不是树根：只砍深度却仍从树根出发，会让一个 child 看见它没 spawn 过的 agent、同时看不见它 spawn 的。

实现上：running 的部分照旧从内存算（`_spawnParent` 里有完整的树），closed 的部分从磁盘递归，深度受 `MAX_SESSION_DEPTH` 约束。**运行时仍然读整棵树**，一层是 `list-agents.ts` 在输出前裁的——放宽或取消这个限制是改一个格式化函数，不碰运行时。

输出保留层级缩进。即使只有一层，closed 条目也可能有几十个，缩进是「谁在谁下面」的唯一线索。

### 身份：会话地址，不是 AgentId

一个 closed 条目的 AgentId 可能与一条 live 条目撞车，所以列表条目的身份是**会话地址**（`root/child` 这样的 ref）而不是 AgentId。用完整地址而不是末段目录名：深度 ≥ 2 时单独一个目录名解析不到东西，而完整地址正是 `/resume` 已经在收的形式。

**closed 条目根本不显示 AgentId。** 本节下面列的两个用途都不需要它，而显示一个看上去可用的 id，正好制造下一小节想避免的那个动作。类型上做成判别联合：running 才有 `agentId`，closed 只有 `sessionRef`。

### closed 条目不可操作

`send_message`、`dispose_agent` 只接受 live 的 AgentId。对一个 closed 条目做任何事都会失败。工具描述必须把这一点写明，否则模型看见一个 id 就会去用它。

一个 closed 条目对模型只有两个用途：知道自己以前做过什么，以及决定要不要重新 spawn 一个同样 profile 的新 agent。

---

## 7. dispose

dispose 不写任何持久化记录。它把 agent 从 `_live` 移除、停掉工作、取消它欠的 job，目录留在盘上。下一次 `list_agents` 里它是 closed。

旧设计的 `removed` 记录、`recordRemoval`、"一个成员至多有一条 removed"、"reducer 丢弃没有头的记录"——整套消失。

subtree scope 的递归 dispose 不变，它走的是内存里的 `_spawnParent`。

---

## 8. 与 `core:jobs` 的关系

这次改动顺带切断了 subagent 与 background job 之间最难处理的那一处耦合。

一个委派 task 是 owner 表里的一条 external job，`origin.settlerId` 是那个 subagent 的 AgentId（`tools/agents/shared.ts:65-71`）。旧设计下，resume 时"这个 settler 会不会被恢复出来"决定了这条 job 该不该闭合，需要两阶段 seal，还需要给 job 记录补一个跨运行时稳定的 settler 身份。

**subagent 永不跨运行时恢复之后，答案是无条件的：任何 settler 都活不过一次 resume。** 于是：

- `_reconcileCarriedOverJobs` 无条件闭合全部 carried-over job（`agent-orchestrator.ts:1258`）——它现在是对的，注释里 "The jobs are gone, so this recovers the conversation rather than the work" 从一个待修的近似变成一条正确陈述。
- `background-job-persistence.md` §4.1 表格里 resume 那一行「内存里一个都没有，等于全部」重新成立。
- 该文档 §8.3（闭合发生在 agent 可路由之前）与旧版本文 §8.3（父先可路由再恢复子女）的次序冲突消失。
- job 记录不需要携带 settler 的会话目录名。

剩余的耦合全部落在一次运行之内：task 是内存 job 表里的一条 external job，settler 是同进程的 agent，两者同生共死。把 subagent 的结果从 background job 语义里移出去，因此是一次**纯内存重构**，不涉及任何持久化。

---

## 9. 删除清单

> **已执行**（`orchestrator-wiring-plan.md` 批次 1）。下面这份清单留作记录：它说明今天 `agent-orchestrator.ts` 里为什么找不到任何一处「树的持久化」，以及那些扩展点为什么消失。

代码：

- `src/core/orchestrator/agent-tree.ts` 整个文件。
- `src/core/session-tree.ts` 整个文件。
- `agent-orchestrator.ts` 的 "Spawn tree persistence" 整节：`_createTreeSpawnRecord`、`_recordAgentSpawnedInTree`、`_recordAgentRemovedFromTree`、`_enqueueTreeWrite`/`_treeWrites`、`_planAgentTreeResume`、`_restoreSpawnTree`、`_resumeAgentTree`、`_resolveResumeRoot`、`_redirectChildResumeToRoot`。
- `SessionManager` 的 `appendAgentTreeRecord`、`readAgentTreeRecords`、`writeAgentParentPointer`、`readAgentParentPointer`。
- 诊断码 `orchestrator.agent_tree_write_failed`、`agent_tree_read_failed`、`agent_tree_not_persistable`、`agent_tree_root_unresolved`。

失去唯一使用者、建议一并删除的持久化扩展点：

- `CustomStorage.listSessionDependencies`（`custom-storage.ts:121`）。
- `walkNamespace` 的 session 半边与 `ForkPlan.sessions` / `NamespaceForkPlan.sessions`（`fork-closure.ts`）。
- `JsonlObjectStore` 的 `sessionDependenciesOf` 钩子与 `openDefaultStorage` 的同名选项。

这是一个没有第二个使用者的扩展点。留着会腐烂，第三方真需要时重新加回来不难。

**`_spawnParent` 及其四个遍历函数保留。** 它们是运行时的内存图——路由、子树 dispose、`_agentsShareTree` 都靠它，与持久化无关。

保留但改写：`_publishTreeResumeReconciliation` 变成第 5 节那条无条件的一句话。

---

## 10. 接线前提

> **已满足**：删除在批次 1 完成，运行时在批次 3 迁到 `JsonlPersistenceRepo`，`list_agents` 在批次 4 读盘。本节留作记录。

`list_agents` 要读 `repo.listChildren`，fork 要复制嵌套目录，两者都需要运行时已经迁到 `JsonlPersistenceRepo`。在那之前运行时用的是旧的会话目录仓储，两者目录命名规则不同、互相看不见。

所以本文的接线**排在 session-manager 迁移到 `JsonlPersistenceRepo` 之后，或与之同批**。

在此之前唯一可以先做的是删除：旧的 `tree.jsonl` / `parent.json` 路径可以先拆掉，代价是那段时间 resume 不再恢复 subagent、`list_agents` 只有内存里的 live agent——正是本设计的最终行为，只是少了 closed 条目。实际就是这么走的：批次 1 先删，批次 4 才把 closed 条目补上。

---

## 11. 代价

**1. `agents/` 只增不减，fork 全量复制。** 分支过滤原来至少把复制范围约束在"这条分支看见过的"。一个跑过 50 次 resume、spawn 过 200 个 agent 的根，目录里就是 200 份，每次 fork 全量复制。边际成本没有听上去那么大——今天 `_forkChildren` 本来就把每个子会话整份复制、停在它自己的 leaf，差的只是"分支看不见的那些"，只有在大量回退的会话里才拉开差距。没有任何回收机制，也不打算加（第 12 节）。

**2. 长期专家 agent 的工作流被删掉了。** 今天 `_restoreSpawnTree` 是能工作的：resume 一个根确实会把整棵树拉回来。取消之后，依赖长期专家 agent 的工作流每次 resume 都要重新 spawn，而且新 agent 上下文为空——旧会话在盘上，但没有任何入口能把它拉起来。这是一次有意识的功能删除，不是简化未落地的设计。第 13 节留了逃生口。

**3. closed 条目可能没有对应的上下文记忆。** 父回退到某次 spawn 之前，那个 closed 条目仍然被列出。第 6 节论证了这不构成矛盾，但它确实是一个模型需要读懂的状态。

---

## 12. 明确不做

- **不做成员 ref，不做 `core:subagent` namespace。** 见第 2 节。
- **不自动恢复 subagent。** resume、fork、navigate 都不做。恢复如果要做，必须是显式的、由模型或用户点名一个目录，见第 13 节。
- **不回收 `agents/` 目录。** 一个目录被删只能是它的整个根被删。自动回收需要一条"这个子会话再也用不到了"的判据，而本设计里不存在这样的判据——任何一个 closed 会话都可能是用户下一分钟想读的那个。
- **不读兼容 `agents/tree.jsonl` 与 `agents/parent.json`。** 旧会话在新布局下作为顶层会话打开，它的子会话作为独立的顶层会话存在。恢复路径必须只有一条真相。
- **不给 closed 条目任何操作。** 见第 6 节。一个可以对 closed 条目调用的 `send_message` 会立刻把"恢复"这件事偷偷加回来。
- **不记录子会话在父的某个时刻处于哪个 leaf。** 要做到这一点，父就得在每个子会话的每一轮之后写一次记录。

---

## 13. 逃生口（不在本次范围）

如果第 11 节第 2 条成为真实痛点，可以加一个显式恢复动作：

```
resume_agent(sessionRef) -> AgentId
```

从 `list_agents` 列出的 closed 条目里点名一个会话地址，把它拉起来成为一个 live agent。参数正好是 closed 条目已经显示的那个 ref，也正是 `/resume` 收的形式（`SessionManager.resolveAgentSessionReference`）。

它不需要任何分支状态：它不声称"这条分支知道有这些 agent"，只声称"这个目录在盘上，我要打开它"。回退语义不受影响，因为它不参与投影。fork 语义也不受影响，因为目录本来就被复制过去了。

要不要做、什么时候做，都可以独立决定。
