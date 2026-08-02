# 谁来写 persistence ref

面向 `apps/widi-pi/src/core/`。前置阅读：`docs/ZH/persistence.md`，`docs/ZH/background-job-persistence.md`。

本文只描述设计与顶层接口，不含实现，不改动 orchestrator。

---

## 1. 问题

persistence ref 是会话分支上的一条 `custom` 条目。分支只有一个合法写入者——harness——因为它在一次运行期间持有分支：它会缓冲自己的写入让一个 turn 的消息保持连续，任何绕过它直接写同一个 session 的代码都会插进中间并把 leaf 带走。

但**决定写什么**的不是 harness，也不是 orchestrator。是 namespace 自己：只有它知道自己刚落盘的对象是哪一个、这一条是接在哪条链上的、这次转移算不算数。

于是形成一个分裂：

- 有资格写的（orchestrator，因为它持有 harness）不知道该写什么。
- 知道该写什么的（namespace）没有资格写。

`custom-storage.ts` 已经为这个分裂划过一次线：投影归框架，解析归 namespace，激活归调用方。本文划的是同一条线在**写入方向**上的样子。

---

## 2. 现状：这条通道已经存在

这一节是事实陈述，不是提案。设计要接的是既有的东西，不是新造一条。

### 2.1 「什么时候写」由 harness 的 interceptor 给出

`ExtensionInterceptorName` 里的 `tool_result` 在工具返回后触发，带 `toolCallId`、`toolName`、`details`、`isError`。一个 job 被后台化时返回的就是 t0 句柄，`details` 里带着 `jobId` 与 `backgrounded` 标记。

所以「此刻该写一条 ref 了」这个时机，今天就是可识别的，不需要新的 hook。

注意它是 **interceptor**，运行在 harness 的一次操作内部。在其中写入不会死锁（写入被缓冲），但条目会落在下一个保存点，不会与触发它的那件事相邻。

### 2.2 「怎么写」已经走 harness

`ExtensionSessionContext.appendEntry(type, data)` 的实现路径是 orchestrator → `harness.appendCustomEntry`。返回 `string | undefined`，`undefined` 表示写入被缓冲在运行中的 turn 后面、此刻还没有条目 id。

这正是「由 orchestrator 代为调用 harness」的形状，已经实现，并且已经是唯一正确的实现（`session-manager` 里那个直接写 session 的同名方法绕开了 harness 的写入缓冲，只有死代码在用）。

### 2.3 唯一的缺口是命名规则

`appendEntry` 强制把类型改写成 `extension:<id>:<type>`，`findEntries` 也只匹配自己的前缀。因此一个 extension **写不出** `widi:persistence-ref` 类型的条目。

这个强制是对的。没有它，任何 extension 都能给别人的 namespace 追加 ref，或者用 `stateRoot: null`——那是合法的清除操作——抹掉别人的状态。

所以要加的不是新机制，是 `appendEntry` 的一个**兄弟方法**：类型固定为 `widi:persistence-ref`，身份不再靠类型前缀承载，而是进入 ref 载荷的 `namespace` 字段。这个字段谁来填、凭什么填，是第 4 节的事。

### 2.4 下行通道确实没有

harness 的事件里有 `save_point`、`session_write`、`session_before_tree`、`session_before_compact`，**没有**「分支即将被延长」这一类。extension 层则明确把 session hooks 整体推迟了，理由是权限、诊断与陈旧上下文语义尚未明确。

`agent_resumed`、`agent_session_forked` 是 observer，事后触发，保证不了「在 agent 变得可路由之前完成闭合」这个次序。

第 8 节那条通道因此只能建在 orchestrator 层。

---

## 3. 这件事是什么：一道准入，不是一次授权

把它说成「谁有资格写 ref」是把它当成了权限问题。更准确的说法是：

> **orchestrator 开放一个入口，让 extension 选择是否把自己的状态交给会话历史管理。**

extension 本来就能往任何地方写文件，会话管理不是它唯一的持久化途径，是它**可以选**的一种。选进来，它换到的是三条它自己造不出来的性质：回退、分叉、可追溯——因为这三条都是从「状态被分支上的一条 ref 点名」这一件事免费长出来的。

这个说法有两处必须跟着说清楚，否则「选择」这个词会盖住它们。

### 3.1 准入标准是「状态是不是对话的函数」

不是「我想不想持久化」。

进来之后**回退就不再可选**。job 历史该被回退掉——回退到 job 启动之前，那个 job 就不该存在，这正是它进来的理由。但一个缓存了 OAuth token 或远端资源句柄的 namespace 进来，用户回退一次对话就把自己登出了。

`forkPolicy` 里的 `omit` 就是为后一类状态准备的，`custom-storage.ts` 把「激活」从「解析」里单独划出去也是同一个原因。

文档如果只说「持久化入口」，extension 作者会读成「官方推荐的保存方式」。准入标准必须以这句话的形式写在 API 文档里，而不是留给作者推断。

### 3.2 进入便宜，退出昂贵

分支是 append-only 的。一个 namespace 进来、发版、再改主意，它写下的 ref 会永远留在所有已经产生的会话分支上。

这不致命：一个未注册的 namespace，本层只会原样留下它的 ref 和目录并报告，绝不回收——那是 `custom-storage.ts` 明写的禁令，因为本层分不清「卸载了」「加载失败」「用户禁用了」「这个 build 没实现」。但那是永久的垃圾，所以进来这件事值得想清楚一次，而不是当成一个可以随手打开的开关。

---

## 4. 选择发生在激活时的注册

既然是准入，它就应该发生在 **activation 时的一次注册**，而不是每次调用时的一次校验。

`ExtensionActivationApi` 今天有 `registerTool`、`patchTool`、`registerProvider`、`appendSystemPrompt`、`observe`、`intercept`、`onExtensionEvent`、`onDispose`，唯独没有注册持久化的。而框架需要的东西——`forkPolicy`、`version`、`openStorage`、`migrate`——没有一样能从一次 `commit(namespace, stateRoot)` 调用里推出来。所以缺的不是一个写入方法，是一次注册。

一旦注册在激活时完成：

- **写入能力是注册的后果，不是另一次授权。** 能力闭包住那个 namespace，压根不存在「点名一个自己没注册过的 namespace」这种调用形状，也就没有什么需要在调用时校验。
- **`owner` 由 loader 强制填成 extension id**，不让 extension 自己声明。`custom-storage.ts` 设这个字段的理由就是「namespace 名字全局唯一但不保留」：extension 被卸载后别人可以认领同一个名字，然后拿自己的 schema 去读前一个的对象。让被注册方自报 owner 等于把这道门交给它自己看守。
- **注册与其它 contribution 一样受 division 管辖。** 一个被禁用的 division 从不 register，因此也从不产生 namespace——和它从不开连接、从不装 watcher 是同一条规则。

namespace 名字怎么由 extension id 派生（`NAMESPACE_PATTERN` 要求 `owner:name` 且只收小写字母数字和连字符，而 extension id 未必满足）是一个尚未回答的问题，留给实现时决定，不在本文预设。

---

## 5. 结论：一个能力，不是一个事件

对外开放的是**能力（port）**，调用它会得到结果，不是一个投递出去就不管的事件。

理由有三，都不是风格问题：

1. **写入方要结果。** 写失败意味着这个 namespace 的历史从此不完整，它必须据此转入降级状态（background 的 `degraded`）。事件不回传成败，等于逼每个 namespace 自己猜。
2. **写入方要新根。** 链式 namespace 的下一条记录接在这一条上。拿不到确认就无法安全地推进自己的链头。
3. **顺序是语义的一部分。** 一个 namespace 的两条 ref 之间有先后关系（先 `started` 后 `settled`）。请求-应答天然串行化；事件总线不保证。

这与 2.2 的既有形状一致：`appendEntry` 本来就是一个返回 promise 的动作，不是一个事件。

---

## 6. 两条通道，同一个 harness 方法

**不开放 `writeRef(namespace, stateRoot)` 这种由调用方自报 namespace 的形状。**

那等于宣布 namespace 的归属只是建议。`PersistenceRegistry` 里的 `owner` 校验会因此变成一道只在读侧生效的门。身份由发放方注入这一条，第 4 节已经通过「能力是注册的后果」解决了：extension 侧的 `appendEntry(type, data)` 没有 `extensionId` 参数，ref 写入照抄。

- **extension 通道**：能力挂在它已经持有的会话动作面上，由第 4 节的注册发放。
- **core 模块通道**：不走 extension 那条。它们在 orchestrator 的信任边界内，由 orchestrator 用自己持有的 harness 直接写——`_reconcileCarriedOverJobs` 今天写 t1 就是这么做的。同一个 harness 方法，两条通道，这个不对称是有意的。
- 没有会话目录的 agent（ephemeral）拿不到这个能力。调用方按「不持久化」处理，和今天 `openOwnerJournal` 的语义一致。

能力句柄绝不进入任何模型可控的载荷。这和 background 的 `OwnerAttachment` 闭包住 agentId 是同一条理由：不让一个工具调用点名自己要扮演谁、要写哪个 namespace。

---

## 7. 能力的形状

两个方法。

```
projection()             — 本 namespace 在当前分支上在册的状态
commit(stateRoot | null) — 追加一条 ref；stateRoot 必须已经落盘
```

### 7.1 `projection` 只回本 namespace 的那一份

**不把整条分支交出去。** 一个 extension namespace 拿到整条分支就等于拿到了整段对话——那是 `getTree` 该管的事，且已经有它自己的信任门槛。

能力回的是框架已经算好的那一份投影：

- 当前在册的 state root（`null` 表示分支最后一次表态是清除，与「从未持有」不同）。
- provenance（`current` / `forked` / `degraded` / `migrated`）。namespace 据此判断这份状态是不是自己这条分支挣来的——一份 `forked` 的 job 历史里点名的进程从来不属于本会话。
- 该 namespace 在这条分支上的 ref 序列，供审计与诊断。

投影本身由框架统一计算（`projectBranch`），没有 per-namespace 覆写余地。这是 `custom-storage.ts` 已经定下的规矩：否则「回退」会因为会话恰好持久化了什么而含义不同。

### 7.2 `commit` 的前置条件写在契约里

**对象必须先落盘，ref 才能提交。** 内容寻址让这个顺序不需要协调：对象的身份不依赖 ref 落在哪里，所以先写对象、ref 没写成，留下的只是可回收的垃圾；反过来则是一条永远解析不了的悬空指针。

契约把这条写明，而不是由能力代劳去写对象。对象怎么落盘是 namespace 的事——它可能用默认对象日志，也可能是一棵树、一个快照、一个本层没有对应物的东西。

### 7.3 `commit` 不承诺返回条目 id

harness 在一次运行期间缓冲写入，缓冲期间不报条目 id；id 要到下一个保存点才存在，届时以 `session_write` 事件带出真实 id。这与 `appendEntry` 和 `publishMessage` 的既有语义完全一致，不是这个能力的特例。

- `commit` 的返回值是「这条 ref 已被接受」，不是条目 id。
- ref 上的 `anchorEntryId` 多数情况下是空的，它本来就只有诊断意义。
- **任何东西都不许依赖 ref 与它记录的那件事在分支上相邻。** turn 中途提交的 ref 会落在 harness flush 时 leaf 所在的位置。`persistence-ref.ts` 已经写明了这一点，这里只是重申它是能力契约的一部分。

---

## 8. 反向通道：分支即将被延长

上面全是上行的（namespace → orchestrator）。**还需要一条下行的**，否则 `docs/ZH/background-job-persistence.md` 第 4.3 节那条触发时机没有实现路径。

闭合规则是「闭合分支上开着、而当前运行时不认识的 job」，触发时机是**即将写这条分支**。这两件事 namespace 自己都看不见：

- 「当前运行时认识哪些」是 namespace 自己的内存，它知道。
- 「这条分支即将被延长」只有 orchestrator 知道——是它在做 resume、navigate、dispose、fork。

2.4 已经确认 harness 与 extension 层都没有可以借用的既有 hook，所以这条通道是新的，且只能建在 orchestrator 层。

**它现在不做成订阅机制。** 只有一个消费者，v1 就是 orchestrator 里的三个显式调用点。等第二个真实需要它的 namespace 出现，这三个点变成一次广播，接口形状从两个实现里抽，而不是照着一个实现编。

用 observer（`agent_resumed`、`agent_session_forked`）代替它是错的：那些是事后事件，保证不了闭合发生在 agent 变得可路由之前。

---

## 9. 顺序与失败

- **跨 namespace 不需要锁。** harness 的写入尾已经串行化了所有分支写入。
- **同一 namespace 内部的串行化归它自己。** 两条记录若都接在「上一条的根」上，就必须排队，否则两条各自成链、只有一条被 ref 指到。这是 namespace 的不变量，不是能力的。
- **`commit` 失败就抛。** 能力不替调用方决定「失败意味着回退还是降级」——那取决于失败发生在生命周期的哪一步，只有调用方知道。这与今天 journal 的 `append` 契约一致，保留。
- **失败之后链头不推进。** 分支没有这条记录，进程内的视图可以有（它对自己保持一致），但下一条记录必须仍然接在分支承认的那个根上。

---

## 10. background 落到这个形状上

`background/job-store.ts` 里的 `JobBranchPort` 就是这个能力的一个特化，需要按第 7 节收窄一处：

| 现在 | 改成 |
|---|---|
| `readBranch()` 返回整条分支，`SessionJobStore` 自己投影 | 能力直接回本 namespace 的投影，投影逻辑不重复实现 |
| `appendRef(data)` 由调用方构造 ref 数据 | `commit(stateRoot)`，ref 的构造（版本、namespace、大小上限）归能力 |

`SessionJobStore` 其余部分不变：它仍然自己决定写哪条记录、自己串行化、自己在失败时保持进程内一致。

第 8 节的下行通道对应 background 的三个闭合调用点（resume、dispose、navigate），第四个（fork）在新会话里发生，走 namespace 的 `fork` 钩子而不是这条通道。

background 走的是第 6 节里 core 模块那条通道，不是 extension 那条。它带有 extension 性质是真的——它注册一个 namespace、在自己的时机写自己的状态——但它今天在信任边界内，不需要经纪层。

---

## 11. 明确不做

- **v1 不做 extension 侧的注册与经纪。** 第 4 节描述的是这道入口该长什么样，不是现在就要造它：今天一个 extension 消费者都没有，内置 namespace 走第 6 节的 core 通道。真正被推迟的是经纪那一半——extension 卸载后已注册的 namespace 怎么办、同一个名字被两个 extension 争抢时如何裁决、名字如何由 extension id 派生。
- **不在 harness 里加 hook。** 上行不需要（2.2 已经有了），下行属于 orchestrator 的知识（2.4）。往 harness 加 hook 会把「哪些 namespace 注册过」这个 orchestrator 才有的事实推进一个看不见它的层。
- **不让能力代管对象写入。** 见 7.2。
- **不把投影做成可覆写的。** 见 7.1。
- **不做 ref 的撤销。** 分支是 append-only 的，要「取消」正确的动作是回退。
