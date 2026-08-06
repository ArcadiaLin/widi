# Orchestrator 重构：可接线的扩展点

面向 `apps/widi/src/core/orchestrator/`。展开在 `docs/ZH/persistence-ref-writer.md`。

本文只列要求，不含设计细节。

---

## 为什么又要动它

上一次重构解决的是 orchestrator 内部的分层。这一次要解决的是**它对外没有可接线的位置**。

具体表现：一个模块想把状态挂到会话分支上，今天只能由 orchestrator 在自己内部为它写一段专用代码（`_reconcileCarriedOverJobs` 就是这样一段）。第二个这样的模块出现时，会再长出一段。extension 则根本没有这条路——`appendEntry` 只能写它自己前缀下的条目。

orchestrator 持有 harness，因此持有分支的唯一写入权。这个权力现在没有被表达成接口，只被表达成一堆调用点。

---

## 要开放的四件

### 1. core 模块的 ref 写入

内置模块（第一个是 background）请求 orchestrator 代写一条 persistence ref。请求方给 namespace 与 state root，不碰 harness，不构造 ref 载荷，不读整条分支。

对应地要能反向读：本 namespace 在当前分支上的投影（state root + provenance + ref 序列），而不是整条分支。

### 2. extension 面向的 ref 写入

同一件事的对外版本。区别只在身份怎么来：extension 在 activation 时注册一个 persistence namespace，写入能力是注册的后果，namespace 不出现在调用签名里。

这等于开放一道准入——extension 可以选择把自己的状态交给会话历史管理，换到回退、分叉、可追溯三条性质。准入标准与代价见 `persistence-ref-writer.md` 第 3 节。

v1 只做第 1 条。第 2 条是同一个接口的对外投影，不是另一套机制。

### 3. ref 事件

每次 ref 落地要发一个事件。理由：ref 改变的是「某个 namespace 在这条分支上是什么状态」，而这件事今天没有任何观察者能看见——TUI 看不见，extension 的 observed event union 里没有对应项，诊断里也没有。

事件至少要带：agent、namespace、新的 state root（含 `null` 这个清除语义）、条目 id（写入被缓冲时缺席，随 `session_write` 补齐）。

### 4. 下行：分支即将被延长

orchestrator 在 resume / navigate / dispose / fork 延长一条分支之前，给持有 namespace 的模块一次写入机会，带上原因。

harness 里没有对应物（`save_point`、`session_write` 都是事后的），必须建在这一层。v1 是三个显式调用点，不做订阅。

---

## `core:subagent` 取消之后

agent 的父子关系改由会话目录嵌套表达，不再有成员 ref、不再有恢复递归（`docs/ZH/agent-tree-persistence.md`）。这去掉了本文原本预设的第二个消费者，三条要求因此定形：

**第 4 条只服务一个消费者。** resume / navigate / dispose / fork 四个时机里，subagent 一侧全部不再写入——resume 不恢复、dispose 不写记录、fork 不做筛选。所以下行通道的形状按 background 的闭合需要定，不为第二种消费者预留。

**第 1 条的反向读直接按 `JobBranchPort` 定形。** 曾经存在的 `SubagentBranchPort` 是同形状的第二个实现，取消后不再有。原先"要从两个可工作的实现里抽形状"的理由随之消失，不必再等。

**新增一条：`list_agents` 要读磁盘。** 新的语义是列出本会话 `agents/` 下的子会话并标出哪些在跑，closed 的条目只来自目录。orchestrator 因此需要一条通往 `repo.listChildren` 的路径。

这条与第 1 条共用同一个前提——`session-manager` 迁到 `JsonlPersistenceRepo`。两者可以合并排期；在此之前 `list_agents` 只有内存里的 live agent，正是最终行为减去 closed 条目。

---

## 边界

- **不改 harness。** `appendCustomEntry` 的 `customType` 本来就是任意字符串，命名规则全部在 orchestrator 侧。
- **core 与 extension 两条通道，同一个 harness 方法。** core 在信任边界内直通，extension 经注册发放。这个不对称是有意的。
- **投影不可覆写。** 「分支上哪条 ref 在生效」由框架统一计算，没有 per-namespace 版本，否则回退的含义会随会话持久化了什么而变。
