# Background 设计

代码位置：`apps/widi/src/core/background/`。

本文说明后台任务机制的设计：伪异步生命周期、运行时状态机与边界、输出流、以及基于 persistence 层（见 `persistence.md`）的可恢复任务历史。

## 1. 模型：伪异步工具结果

LLM 协议没有 deferred tool_result：一个工具调用一旦结案，就再也没有渠道把结果补交给模型。可后台化的工具调用恰恰要求这样做——调用先结案，工作继续跑，结果后补。background 模块用一个由两个时刻定义的伪异步生命周期解决这个矛盾：

- **t0**：调用与一个 deadline 赛跑。deadline 赢了，调用以 job 句柄结案——给模型的文本必须明说"这不是真实输出，结果稍后作为独立消息到达"，模型才不会阻塞等待。
- **t1**：真实结果作为一条普通 user message 注入。协议不许 deferred tool_result，所以 t1 只能是普通消息，由运行时交给 host，按目标当前的投递相位裁定注入方式。

两段文本都必须是自描述的：被读到的时候，会话早已走远。

**它刻意不是一个 lane**：一次操作、一次尝试、没有会话树，所以没有 leaf、没有导航、没有 per-job 模型配置、没有尝试计数。

两个贯穿设计的不等于：

- **候选不是 job。** 在 deadline 前结案的调用从未被观察到，不留任何痕迹。只有从 `backgrounded` 起，job 才是别人可以指名的东西——也从那一刻起，它欠下恰好一个终局结果和一次 t1 投递尝试。
- **执行状态不是持久化健康。** 一份 `degraded` 的历史不阻止 job abort、settle 或投递结果；写不下记录和跑不完任务是两件事。

## 2. 运行时：BackgroundJobRuntime

`background.ts` 的 `BackgroundJobRuntime` 是整个生命周期的唯一 owner：job 状态唯一的变化点、谁可以改变状态的唯一权威、每一条排序规则的持有者。构造注入端口 `BackgroundJobRuntimePorts`：

- `openOwnerStore(owner)`：打开 owner 的持久化任务存储；
- `messageSinkFor(binding)`：进入模型上下文的唯一通道（orchestrator 消息中枢，见 `orchestrator.md` §3）；
- `publish(event)` / `diagnose(diagnostic)`。

端口里刻意没有"agent 是否可达"——投递策略归 host 与 binding。

### 三条边界

1. **永不读 agent 记录或任何 host 表。** 生命周期只以 attach/detach 到达运行时；一次 attachment 回答的是"这个句柄还是不是当前那一个"（按 `(agentId, generation)` 解析），永远不是"这个 agent 还活着吗"。
2. **永不决定 owner 能否收消息。** t1 的投递策略——拦截、合并、prompt 还是 steer——归 `deliverResult` 的实现方（orchestrator 侧）。
3. **活着的 job 永远不让 owner 变忙。** 否则后台化就失去了意义。

### 能力对象

agent 经 `attachAgent({ agentId, sessionId })` 附着，得到 `OwnerAttachment`（`generation` 单调递增；`persistenceHealth` 可在运行中从 `durable` 降为 `degraded`），其上挂两个能力：

- `BackgroundJobHost`：`startLocal` / `createExternal` / `list` / `read` / `watch` / `abort`。attachment 失效统一返回 `stale_attachment`。
- `BackgroundJobSettler`：`settle({ ownerAgentId, jobId, outcome })`，供外部执行者回报结果。授权是 job 上记录的 `origin.settlerId` 与 `settlerGeneration` 双匹配——模型参数无法伪造调用者身份。

`detachAgent` 是同步摘除：对自己拥有的每个 job 强制取消（`abort` + `settle(cancelled)` 一步到位），对自己欠账的 job 同样取消（owner 的作业照走正常 t1）。store 打开失败或历史截断只把 health 置为 `degraded` 并发诊断——作业继续跑，只是不再可跨重启恢复。

### 状态机

`BackgroundJobLifecycleState = "foreground" | "accepting" | "backgrounded" | "abort_requested" | "completed" | "failed" | "cancelled"`。前两个是候选态（不可观测），后三个是终态（恰好到达一个，至多一次）。

- 创建：本地执行 → `foreground`；外部执行者 → `accepting`（等待 settler 回报）。
- `foreground` → `backgrounded`：执行句柄调 `acceptBackground()`（deadline 输了的时刻）。
- `accepting` → `backgrounded`：started 记录落盘后提交；落盘失败则 job 置 `cancelled` 并降级。
- `backgrounded` → `abort_requested`：`abortJob` 或输出熔断触发；只发信号，确认以 settlement 的形式后到。
- 任意非终态 → 终态：`_settle`，最多一次。候选态结算返回 `inline`（从未可观测）；可观测态走 settlement 流程。

### Settlement 顺序与串行化

可观测态的结算在 owner 的 `tail` promise 链上串行执行，`settled` 是屏障：冲刷 report → 冲刷进度增量 → 写 `settled` 记录（含确切 t1 文本与输出尾部）→ 发布 `settled` 事件 → t1 投递（binding 为 `background_job` 生产者：`blockPolicy: "ignore"`、失败重试、按 mergeKey 相邻合并）。tail 串行保证 `abort_requested` 可观测地先于 `settled` 到达任何观察者。进度与 report 各自以 100ms 节流（leading + trailing），report 是 latest-value register（revision 单调，burst 合并）。

输出熔断是协作式的：单 job 总输出超过 16 MiB（`DEFAULT_BACKGROUND_JOB_OUTPUT_CEILING_BYTES`）时触发 abort——两个窗口已有界，这条防的是失控生产者空烧 CPU，它限制不了从不写入这股流的输出。

## 3. 输出流：BackgroundJobOutput

`output.ts` 是一条 append-only 字节流加两个独立的有界窗口。后台化的工具没有别处可放输出——它的工具调用已经结案——而两个消费者对这股流要的都不是无界的东西：

- **滚动尾部**（`read()`）：最后 1 MiB（`DEFAULT_BACKGROUND_JOB_OUTPUT_MAX_BYTES`），即席查看用，head drop 允许在字符中间切断。
- **增量缓冲**（`drainIncrement()`）：尚未转发给订阅者的进度，上限 1 MiB（`DEFAULT_BACKGROUND_JOB_INCREMENT_MAX_BYTES`）。溢出从头部丢弃并累计 `progressDroppedBytes`，消费者在 `startByte` 跳过上一次 `endByte` 处能看到可检测的空洞。

增量以 base64 携带：一个 UTF-8 字符可以横跨两个增量，消费方必须按序解码拼接。`BackgroundJobOutputIncrement = { chunk, startByte, endByte, totalBytesSeen, progressDroppedBytes }`，经 `job_progress` 事件（带 per-job 单调 `sequence`）转发。

## 4. t0/t1 文本契约

`messages.ts` 拥有 job 放在模型面前的全部文本：

- `createBackgroundJobStartedResult(...)`：t0 工具结果，details 含 `{ jobId, toolCallId, toolName, name?, backgrounded: true }`——`backgrounded: true` 标记这是句柄而不是真实输出。文本指明结果将稍后作为独立消息到达、不要阻塞等待、可用 `read_job` / `wait_for_jobs` / `kill_job`。
- `formatBackgroundJobResultMessageText(settlement)`：t1 正文。header 形如 ``Background job <jobId> (started by tool call <toolCallId>, tool <toolName>) <status>:``——jobId 是进程局部的（每个 runtime 从 1 重启），所以持久身份必须带 `toolCallId`（session 内唯一）才能在 resume 时与会话历史匹配。
- `formatInterruptedBackgroundJobResultText(...)`：runtime 退出时仍在跑的 job 的固定措辞（"未挺过重启，没有产出结果；如仍需其工作请重新发起"）。
- `carriedOverJobResultText(entry)`：reconcile 时逐条告知的文本——本 runtime 亲眼看完结的 job 保留原结算文本，完全无结果的才用 interrupted 形式。

正文推导规则：`outcome.result` 存在则拼接其中全部 text part；否则合并 stopReason 与 error 文本；`cancelled` 且无 error 用固定句。

## 5. 公开面

orchestrator 面向调用方的入口（`AgentOrchestrator` 上）：`listAgentBackgroundJobs`、`readAgentBackgroundJobOutput`、`abortAgentBackgroundJob`、`agentBackgroundJobHistory`。模型侧的工具（`read_job` / `wait_for_jobs` / `kill_job` 等）经 host 能力对象路由到同一运行时，调用者身份由 orchestrator 绑定。

## 6. 持久化机制

任务历史挂在 `core:jobs` namespace 下（`job-persistence.ts`），接入 persistence 框架的全部规则：状态由分支上的 ref 命名，回退失效、分叉带走（`persistence.md` §5-6）。

### 记录与归约

`JobRecord` 三种，key 是 `toolCallId`：

- `started`：链头，含 `jobId, ownerAgentId, toolName, origin, startedAt, outputFile`；
- `settled`：执行者的答案，含 `status, stopReason?, endedAt, messageText`（确切 t1 文本，写入前截断到 64 KiB）、`outputTail?`（≤32 KiB 的模型向摘要）；
- `closed`：runtime 宣告答案不会来了，`cause: "resume" | "navigate" | "dispose" | "fork" | "abort"`。

历史是一条转换链而不是快照：`appendRecord(record, previousRoot)` 把新记录以 `dependencies: [previousRoot]` 链接成单链，`reduceJobRecords` 从旧到新归约出每个 job 的当前形态（`open | settled | closed`）。归约规则：`started` 幂等；terminal 记录只作用于 `open` 的 job 且**第一个 terminal 获胜**（closure 与 settlement 竞争时不能改写已到的答案）；无链头的 terminal 记录被丢弃（回退过 job 起点的分支看不到这个 job）。被回退的分支因此 reduce 到它见过的状态，而不是后来发生的事。

### SessionJobStore 与 JobHistoryStorage

- `JobHistoryStorage implements CustomStorage`：namespace 级物理存储，包装 `JsonlObjectStore`，另管 `output/` 目录下的输出文件。`resolveState` 从链头反向走链（防环、超长或缺失标记 `truncated`）再正序归约；`copyReachable` 复制对象链时连同 `started` 记录引用的输出文件一起复制，保证 fork 后的会话能读到它引用过的字节。
- `SessionJobStore`：一个 agent 的历史，绑定到拥有它的分支（经 `JobBranchPort`：`projection()` + `commit(stateRoot)`，即 orchestrator 的 ref 写入通道）。`append` 严格两步：先写不可变对象，再让分支携带新 ref——顺序不可交换（ref 指向未写对象是悬指针；无 ref 的对象是可回收垃圾），追加经 promise 链串行化。`_carriedOver` 记录打开时分支上 `open` 的 job——本 runtime attach 时继承的 t0 句柄，冻结，后续导航不改变其语义。

### Fork 策略

`createJobsNamespace()` 声明 `forkPolicy: "degrade"`：历史值得带走，活执行者不值得。`forkJobHistory` 先复制闭包（含输出文件），再对新分支上每个 `open` 的 job 写入 `cause: "fork"` 的 closed 记录——fork 不继承任何执行者，源会话的作业继续跑。有 closure 时新 ref 的 `origin` 为 `fork_degraded`，否则为 `fork`，调用方据此决定如何呈现这份历史。

### 回退调和：reconcile

resume / navigate / dispose 延长或切换分支之前，runtime 经 `reconcileBranch(agentId, { cause })` 调和 carried-over job（`SessionJobStore.rebind`）：

1. 重新读分支投影；分支上 `open` 且本 runtime 不持有执行者的 job 分三类——runtime 仍持有执行者的（不动）、runtime 亲眼看完结的（重放 settled 记录，recovered）、其余（写 closed 记录）。成员测试依据 runtime 内存而非分支：**导航不杀进程**。
2. announce 先于记录落盘：先把 closure 归约出每条 job 实际得到的答案，用 `carriedOverJobResultText` 措辞、以 `precede` 模式发给 owner，再逐条追加记录——崩溃只会重复消息，不会丢消息。`cause === "dispose"` 时跳过发送。

### 输出文件

`output/` 目录存全量输出，文件名 `jobOutputFileName(toolCallId)` = `<sanitize 后截 64 位>-<contentHash 末 8 位>.log`——hash 无条件附加，因为仅 sanitize 会让只差路径非法字符的两个 id 撞同一文件。文件与记录解耦：无输出则无文件；`settled` 记录里的 `outputTail` 是模型向摘要，与磁盘全量并存；文件随 `copyReachable` 跨 fork 复制。

## 7. 模块地图

- `background.ts` — 运行时：状态唯一的变化点与排序规则的持有者。
- `types.ts` — 领域词汇：生命周期、能力、端口、记录。
- `output.ts` — 字节流与两个有界窗口。
- `job-persistence.ts` — 记录、`core:jobs` namespace、绑定分支的单 agent 历史。
- `messages.ts` — t0/t1 文本。

刻意在别处的东西：决定一个调用是否后台化的 deadline 赛跑在工具适配器里；t1 的投递策略在 `deliverResult` 的实现方（orchestrator 侧）。

## 延伸阅读

实现期设计文档在 `notes/develop/`（scratch）：`ZH/background-job-persistence.md`；早期方案在 `notes/plan/background-runtime.md`。
