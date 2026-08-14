# RPC 模式

代码位置：`apps/widi/src/rpc/`；入口 `apps/widi/src/cli.ts`（`--mode rpc`）。

本文是 RPC 协议的规范：帧格式、命令表、事件流、生命周期、版本策略，以及已知缺口与补全计划。外部客户端应当只依赖本文写下的内容；`src/rpc/types.ts` 是它的 TypeScript 表达，两者不一致时以本文为准，并且该不一致本身是缺陷。

## 0. 当前进度

`protocolVersion: 1`。**可以拿去驱动评测了**，但有几件事得先知道。

**已经可以依赖的**

- 协议骨架：`ready` 无条件首帧、JSONL 双向、命令按到达顺序并发派发、四条关闭路径统一（§2、§3）。
- 17 条命令，是 orchestrator 公开方法的投影（§4）。仍未投影的只剩 `isAgentIdle` 与 `agentHasPendingMessages`，两者都被 `wait_idle` / `wait_tree_idle` 覆盖了。
- 每条失败响应都带稳定的 `code`，并且区分"重试可能成功"与"永远不会"（§3.4）。
- 入向帧按 schema 校验，拒绝时指出出错路径并回显 `id`；契约以 JSON Schema 发布（§3.3）。
- `prompt` 与三条 wait 的 `deadlineMs`，以及命令级 `cancel`；`prompt` 超时保证 agent 已停稳才答复（§4.4）。
- 树级完成信号 `wait_tree_idle`，用来判样本边界——**不要用 `prompt` 的答复判**（§4.5、§4.6）。
- human request 的超时与撤回（§6）。
- stdout 独占：扩展的 `console.log` 不会撞进协议流（§7.1，有子进程级测试守着）。
- core 半扩展完整加载（§1.3）。

**还不行、需要客户端自己兜的**

| 缺口 | 客户端要做什么 | 详情 |
| --- | --- | --- |
| 没有 `run_summary` | 自己在事件流上聚合请求数/token/费用，注意维护工作（compaction）自带 provider 调用，不属于它后面那次 turn | §9.5 |
| 客户端 → 扩展方向不通 | 无须处理：扩展照常触发、照常汇报，缺的只是客户端主动推事件，已决定不做 | §9.6 |
| 没有生效配置快照 | 复现性靠自己记录 | §9.7 |
| `send` 没有 deadline | 目标处于维护相位时投递会无限期 defer | §9.8 |

**测试覆盖**：`tests/rpc/frames.test.ts`（入向校验与发布用 schema）、`tests/rpc/server.test.ts`（协议行为，进程内）、`tests/rpc/e2e.test.ts`（真子进程 + 真 provider 往返，§9.1）。落地顺序与后续计划见 §9。

## 1. 定位与三条不变量

RPC 是 core 的**第二个前端，与 TUI 平级**，不是它的下层。TUI 通过 `orchestrator.registerClient` 接入（`tui/application.ts`），RPC 走同一个接口（`core/client.ts` 的 `OrchestratorClient`）——因此这个模式没有为自己新增任何 core 接缝。

### 1.1 显式寻址：协议里没有"当前 agent"

每条涉及某个 agent 的命令都必须写明 `agentId`。理由：

1. core 里不存在"当前 agent"这个概念。`activeAgentId` 是 TUI 状态（`tui/state.ts`）。协议若引入它，等于在 core 之上发明一个 core 没有的状态。
2. agent 本来就是并发的。orchestrator 的存在理由就是多 agent 同时运行。
3. 事件已经带 `agentId`；命令不带就不对称，客户端收到 `agent_idle{agentId: X}` 却要先切换才能回复，中间有竞态。
4. 扩展的 `agentId` 是激活时由 core 注入的。显式寻址下客户端说的 agent 与扩展知道的 agent 是同一个。

### 1.2 作用域是 runtime 全域

RPC 客户端不是 agent，它站在 orchestrator 这一侧，与 TUI 同侧。命令映射到 `AgentOrchestrator` 的公开方法，**不映射到** `AgentToOrchestratorHost`（那是绑定了 agent 身份的窄面，作用域是"调用方那棵树"）。

### 1.3 core extension 完整支持，不是降级支持

双端契约（`tui/extension-host/types.ts`）把全部 UI 能力放在包的 `tui` 具名导出上，core 半在 default 导出。RPC 模式只加载 core 半，而 core 半能做的事（observer、interceptor、registerTool、registerProvider、appendSystemPrompt、publishMessage、setStatus、precede、跨 agent 方法）没有一样需要终端。

"没有 TUI 半"与"用户装的包本来就没写 `tui` 导出"是同一条降级路径，早已可预期。

## 2. 生命周期

### 2.1 启动次序（load-bearing）

1. 接管 stdout（见 §7），建立 human request 通道，挂上 stdin reader。**必须最早**：`createWidiRuntime` 在 orchestrator 存在之前就可能问人——"ask" 项目信任策略走的就是 human request broker（`core/runtime-service.ts`）。
2. `createWidiRuntime`。
3. 创建 root agent（除非 `--no-root`）。
4. 发出 `ready`。
5. 注册 client，然后执行启动期间攒下的输入。

### 2.2 `ready` 是无条件的第一帧

客户端可以依赖：**`ready` 之前不会有任何其它帧**，包括错误响应。

启动期间到达的命令被**持有**而不是拒绝：管道客户端（`echo ... | widi --mode rpc`）在任何人能读到 `ready` 之前就已经把命令写完了，拒绝等于丢命令。连格式错误的回答也一起持有——"ready 永远第一"是客户端能照着写的规则，"第一，除非你发了坏 JSON"不是。

反方向的唯一例外是 human request：它立即发出、答复立即受理，因为发问的可能就是启动过程本身。

### 2.3 关闭

`shutdown` 命令、stdin 结束、`SIGINT`/`SIGTERM`、stdout 写失败，四条路都进同一个关闭流程：摘掉 reader、释放 stdin、终止全部挂起的 human request、注销 client、`disposeAll`、排空 stdout、还原 stdout。

两条保证：

- **`shutdown` 命令自己就会结束进程**，不需要客户端再关掉管道。交互式客户端与批量驱动通常都保持自己那端开着，等管道关闭才退出的实现会把它们全都挂住。
- **stdin 结束意味着"不会再发了"，不是"立刻停"**。管道客户端（`printf ... | widi --mode rpc`）在 runtime 还没启动完时就已经 EOF，它写的东西还全在持有队列里。所以流关闭只被记下，等启动完成**且已接受的命令全部答复完毕**才真正关闭。否则 §2.2 的持有规则等于不存在。

第二条同时决定了一件事：**一条 `prompt` 可以整个跑在管道模式下**——写命令、关 stdin、等进程退出，答复与事件都在 stdout 上。

## 3. 帧格式

JSONL：一行一个 JSON 对象，UTF-8，`\n` 分隔（读取端容忍 `\r\n`）。空行忽略。流结束时未终结的残片被丢弃——未完成的行是写入方没写完的帧，猜它就是开始对半条命令采取行动。

**出向（stdout）**

| `type` | 含义 |
| --- | --- |
| `ready` | 首帧，见 §2.2 |
| `response` | 某条命令的答复 |
| `event` | 一条编织后的 orchestrator 事件，见 §5 |
| `human_request` | 需要人答复，见 §6 |
| `human_request_withdrawn` | 一条 human request 不再等答复了，见 §6.2 |

**入向（stdin）**

| 判别 | 含义 |
| --- | --- |
| 有 `cmd` 字段 | 命令 |
| `type: "human_response"` | human request 的答复或撤回 |

### 3.1 `ready`

```json
{
  "type": "ready",
  "protocolVersion": 1,
  "rootAgentId": "widi-dev-q485",
  "cwd": "/root/projs/widi",
  "agentDir": "/root/projs/widi/.widi",
  "diagnostics": []
}
```

`rootAgentId` 只是第一个被创建的 agent，**没有任何其它 agent 没有的特权**；协议里刻意没有只有它接受的命令。`--no-root` 时该字段缺席。

### 3.2 `response`

成功：

```json
{ "type": "response", "id": "1", "cmd": "spawn", "ok": true, "data": { "agentId": "..." } }
```

失败：

```json
{ "type": "response", "id": "2", "cmd": "inspect", "ok": false,
  "error": "Unknown agent: nope", "code": "unknown_agent" }
```

`id` 原样回显；客户端不关联时可以省略。**被校验拒绝的帧同样回显它自己写的 `id` 与 `cmd`**——一个手上有若干条在飞命令的客户端，收到"其中某条格式不对"是没法处理的。只有在帧连 `cmd` 都没写明（JSON 都解不开、或者压根没有 `cmd`）时 `cmd` 才是 `"parse"`。

成功响应的 `data` 由 `cmd` 决定，类型上按命令名分发，客户端在 `ok` 与 `cmd` 上收窄之后即可直接读取 `data`，无需断言。

### 3.3 入向校验

**每条入向帧都按 schema 校验**（`src/rpc/schema.ts`），失败答 `invalid_command`，`error` 指出具体位置：

```json
{ "type": "response", "id": "3", "cmd": "send", "ok": false, "code": "invalid_command",
  "error": "Invalid send frame at /mode: must be one of \"next_turn\", \"interrupt\", \"precede\"." }
```

**未知属性会被拒绝。** 入向严格、出向宽容是刻意的不对称：客户端多写的字段几乎总是拼错（`deadlinems` 静默等于没有 deadline，样本就永远挂着），而出向多出来的字段是新版 runtime 在照顾旧客户端。新客户端配旧 runtime 由 `protocolVersion` 负责（§8）。

字面量集合（`mode`、`thinkingLevel`、`scope`、`origin.kind`）逐个校验。这是这层校验存在的首要理由：`decideMessageDelivery` 没有"未知 mode"这一支，所以在有校验之前，一个拼错的 `precede` 打到空闲 agent 上会被当成普通投递、**起一整轮 turn**——不报错，而且只是有时候。

属于 core 的复合形状（`profileOverride`）只校验到"是个对象"。core 是那些形状的事实来源，在这里复述一遍等于每次 core 变动都要跟着改。

可发布的 JSON Schema 见 [`rpc-inbound.schema.json`](./rpc-inbound.schema.json)，由同一份定义生成，测试保证不漂移。它只覆盖入向：客户端不需要校验 runtime 发给它的东西，而出向 payload 包的是 core 类型。

### 3.4 失败码

`code` **在每一条失败响应上都存在**，是协议的一部分；`error` 是给人读的自由文本，不稳定，客户端可以记录但不得据以分支。

| `code` | 含义 | 同一条命令重试 |
| --- | --- | --- |
| `invalid_command` | 帧本身不对：未知 `cmd`、参数不合法、`id` 与在飞命令冲突 | 无意义 |
| `unknown_agent` | 这个 runtime 从来没有这个 id | 无意义 |
| `agent_busy` | 目标当下被占用（含正在创建） | **可能成功** |
| `agent_unavailable` | 目标存在过，但再也不能接受了（已 dispose、harness 已关停） | 永远不会成功 |
| `model_unavailable` | 模型引用格式对，但没注册 | 无意义 |
| `timeout` | 命令的 deadline 到了，见 §4.4 | 视情况 |
| `aborted` | 被 `cancel`、`abort` 或 dispose 撤下 | 视情况 |
| `shutting_down` | runtime 正在关闭，不再接受新工作 | 不会 |
| `internal` | 未分类。客户端只能上报 | 未知 |

`agent_busy` 与 `agent_unavailable` 的区分是这张表存在的理由：一个批量驱动唯一要问的问题是"这次失败对下一次尝试意味着什么"。

**core 自己的错误码不上线**。`OrchestratorError` 带的是诊断码（`orchestrator.agent_busy`），`MessageError` 是第二套词汇（`target_unavailable`），`AgentHarnessError` 是第三套（`busy`），三者都属于 core、随 core 变，且都不覆盖"不属于这三类"的失败。映射在 `src/rpc/errors.ts` 一处完成。

## 4. 命令表

命令是 orchestrator 公开方法（`docs/orchestrator.md` §6）的机械投影。新增一个 orchestrator 方法就是新增一个 case，不为每个方法发明新动词。

| `cmd` | 参数 | `data` | 对应方法 |
| --- | --- | --- | --- |
| `spawn` | `origin`, `parent?`, `cwd?`, `model?`, `thinkingLevel?` | `{ agentId }` | `spawnAgent` |
| `send` | `agentId`, `body`, `mode`, `images?` | `MessageSendOutcome` | 人类 sink 的 `send` |
| `prompt` | `agentId`, `body`, `images?`, `deadlineMs?` | `PromptOutcome` | 人类 sink 的 `prompt` |
| `abort` | `agentId` | `AbortResult` | `abortAgent(id, "human")` |
| `dispose` | `agentId`, `scope?`, `reason?` | `{ agentIds }` | `disposeAgent` |
| `compact` | `agentId`, `customInstructions?` | `CompactResult` | `compactAgent` |
| `wait_idle` | `agentId`, `deadlineMs?` | `{}` | `waitForAgentIdle` |
| `wait_stop` | `agentId`, `deadlineMs?` | `AgentStop` | `waitForAgentStop` |
| `wait_tree_idle` | `agentId`, `quietMs?`, `deadlineMs?` | `{ agentIds }` | §4.6 |
| `read_report` | `agentId` | `{ report? }` | `readAgentReport` |
| `list_agents` | — | `{ agents: AgentSnapshot[] }` | `listAgents` |
| `inspect` | `agentId` | `AgentSnapshot` | `inspectAgent` |
| `set_model` | `agentId`, `model` | `RuntimeModel` | `setAgentModelByReference` |
| `set_thinking_level` | `agentId`, `level` | `{}` | `setAgentThinkingLevel` |
| `cancel_human_request` | `requestId`, `reason?` | `{ cancelled }` | `cancelHumanRequest` |
| `cancel` | `commandId` | `{ cancelled }` | §4.4 |
| `shutdown` | `reason?` | `{}` | §2.3 |

命令**按到达顺序派发，不互相排队**：对一个 agent 的 `wait_idle` 不得挡住对另一个 agent 的 `send`。因此响应顺序与命令顺序无关，客户端必须靠 `id` 关联。

### 4.1 `spawn` 的 origin

```
{ "kind": "new",    "profileId"?: string, "profileOverride"?: {...} }
{ "kind": "resume", "reference": string }
{ "kind": "fork",   "sourceAgentId": string, "entryId"?: string }
```

比 orchestrator 自身的 origin 窄一处：`resume` 的 `reference` 只接受地址字符串。进程内形式还接受已解析的 `PersistedSessionInfo`，那是线这一侧无法诚实获得的对象。

`model` 是 `provider/id` 引用，解析不到即拒绝。

### 4.2 `send` 与 `prompt` 的区别（重要）

`mode` 三态直接暴露，投递方法留在 core 决定（`decideMessageDelivery` 按相位算成 `prompt | follow_up | steer | append`）——客户端猜不准也不该猜。

- `next_turn`：不打断在飞的 turn。打到 idle 的目标会直接起一轮。
- `interrupt`：打断在飞的 turn。
- `precede`：不唤醒目标，落在分支上等下次输入一起读。

`send` 不要求目标空闲。`prompt` **要求目标空闲，忙碌时拒绝而不是排队**，批量驱动必须处理这一点。

**`prompt` 返回的是整个 run 跑完之后的最终 assistant message**，不是第一个 turn 的。链路是 `promptAgent` → `harness.prompt()` → `executeTurn` → `runAgentLoop`，工具调用的所有轮次都在里面。这是编写评测驱动时最要紧的一条语义。

**但"这个 run"只是目标 agent 自己的 run，不是它那棵树的。** 详见 §4.5。

binding 固定为人类 binding（可打断、enforce、plainEntry），请求不可覆盖投递策略——这是 orchestrator 的既定规矩：policy 在发放 sink 时绑定。

### 4.3 结果形状

```
MessageSendOutcome = { kind: "accepted" }
                   | { kind: "blocked", inputId, reason?, blockedBy }

PromptOutcome      = { kind: "completed", message: AssistantMessage }
                   | { kind: "blocked", inputId, reason?, blockedBy }

AbortResult        = { clearedSteer: AgentMessage[], clearedFollowUp: AgentMessage[] }
CompactResult      = { summary, firstKeptEntryId?, tokensBefore, usage?, retainedTail?, details? }
```

`AssistantMessage` 带 `usage`（input/output/cacheRead/cacheWrite/reasoning?/totalTokens/cost）、`stopReason`、`responseModel`（实际响应的模型）。

### 4.4 deadline 与取消

可以无限等待的命令只有 `prompt` 和三条 wait，因此也只有它们接受 `deadlineMs`、只有它们能被 `cancel` 撤下。其余命令要么立即返回，要么被单次 harness 调用界定。

`deadlineMs` 是**这条命令的** deadline，不是 agent 的；到期时 agent 会怎样按命令而定：

| 命令 | 到期/被取消后 | 答复 |
| --- | --- | --- |
| `prompt` | **abort 该 agent，并等它真正停下**，然后才答复 | `timeout` / `aborted` |
| `wait_idle` / `wait_stop` / `wait_tree_idle` | 停止等待，**agent 一动不动**——这些命令从头到尾只是在看 | `timeout` / `aborted` |

`prompt` 那条"等它真正停下"是刻意的保证：**答复到达时该 agent 已经 idle，属于它的事件也已经全部在流上**，批量驱动可以直接进入下一个样本，不必和上一个的尾巴赛跑。放弃 run 提前答复会留下一个仍在写事件的模型循环，而客户端已经认为那条命令结束了。

`cancel` 按 `id` 撤下在飞命令，因此**没有 `id` 的命令不可取消**——`id` 是唯一的把手。`commandId` 找不到（包括已经答复过的）返回 `{ cancelled: false }`，不算失败。复用一个仍在飞的 `id` 会被拒（`invalid_command`）：接受它的代价是两条不同命令共用一个关联 id。

### 4.5 多 agent 协作：`prompt` 答复不等于这棵树跑完

agent 之间的协作工具（`spawn_agent` / `send_message` / `watch_agent` / `dispose_agent`）在 RPC 下**完全正常**，与 TUI 下无差别：它们绑定 `AgentToOrchestratorHost`，那一层不知道前端是什么。客户端还可以用 `spawn` 的 `parent` 参数直接搭出拓扑——那条边进 `_spawnParent`，于是新 agent 就在 parent 的树里，parent 的 `list_agents` 能发现它、能给它发消息、能 watch、能 dispose。agent 之间的消息经 agent binding 投递，带 `[Message from <id>]` 归属，客户端在事件流上全程可见。

**要小心的是完成语义。** `prompt` 在**目标 agent 自己的 run 结束**时答复，而一个把活交出去的 agent 正是靠结束自己这一轮来等下级的。于是：

- 下级慢：根 agent 的 run 先结束，`prompt` 答复，**协作还在进行**；下级报告到达后 watch 通知把根唤醒，跑第二轮——这一轮已经在 `prompt` 的答复之外。
- 下级快：报告在根的 run 还在飞时就到了，以 `interrupt` 折进同一个 run，`prompt` 答复时协作已经结束。

**两种都会发生，取决于时序。** 这比"总是提前返回"更危险：一个把 `prompt` 答复当作"样本结束"的驱动，在下级快的时候看起来完全正确。两条路径都由 `tests/rpc/e2e.test.ts` 实测过。

要判断一轮协作真正结束，用 `wait_tree_idle`（§4.6），不要用 `prompt` 的答复。

### 4.6 完成信号：`wait_idle` / `wait_stop` / `wait_tree_idle`

三条 wait 回答的是三个不同的问题，用错一条就是样本边界判错。

| 命令 | 问题 | 触发方式 |
| --- | --- | --- |
| `wait_idle` | 这个 agent **现在**闲着吗 | 电平。已经 idle 就立刻答复 |
| `wait_stop` | 这个 agent **下一次**停在哪 | 边沿。已经 idle 也要等下一次 `agent_idle` |
| `wait_tree_idle` | 这**棵树**跑完了吗 | 见下 |

`wait_idle` 与 `wait_stop` 的差别是把活交出去的人最容易踩的坑：`send` 之后紧跟 `wait_idle`，投递还在队列里、目标还没动，`wait_idle` 立刻返回，驱动就把起点当成了终点。交出工作后要等它的那次停止，用 `wait_stop`；它答复的 `AgentStop` 带 `reason`（`settled` / `aborted` / …）与 `abortedBy`。

`wait_tree_idle` 是给批量驱动判样本边界用的，做两件事：

1. **在子树上做 join**：`agentId` 的 spawn 子树里每个活着的 agent 都 idle 才算数。走的是 spawn 边而不是活 agent 表，所以父 agent 已被 dispose 的孙 agent 仍然算在树里。这一半是决定性的——§4.5 那个"根 idle 而下级在跑"的场景由它排除。
2. **延后复核**：条件第一次成立时不采信，等一个静默窗口（`quietMs`，默认 250）后重新求值；期间任何 runtime 事件都会重新计时。

第 2 条是启发式，理由要说清楚：两个 agent 之间的交接不是原子的。下级停止到上级被唤醒之间，`AgentWatches` 要先从 session 读回报告再投递，这中间整棵树都读作 idle。**测试证明的是"延后复核"本身**（`tests/rpc/server.test.ts`），它挡掉所有在一个事件循环回合内完成的交接；**没有**测试能证明窗口的**长度**有用——只有那次 session 读真的落到磁盘时它才买到东西。设成非零而不是 0，是因为早答一次是样本被静默截断，晚答一次只损失一个窗口。想只要复核、不要猜，传 `quietMs: 0`。

彻底不猜需要 orchestrator 知道 watch 表，而 watch 表在 tool registry 之下。在那之前，窗口可调，并且由**任何**事件重新计时——这在"一个样本一个进程"（§7.4）下是安全的。

答复里的 `agentIds` 是**settle 那一刻**树里活着的 agent，根在前。整棵子树在等待期间被 dispose 光了会答 `agent_unavailable`；`agentId` 本身从来不是活 agent 则答 `unknown_agent`。

`read_report` 读回某个 agent 最后一轮说的话（扫到上一条 user message 为止），一个字都没说时 `report` 缺省。它读的是 session 分支，不是事件流的重放，因此和 watch 通知里带的报告是同一份文本。

## 5. 事件流

`event` 帧包一条 `OrchestratorEvent`。事件类型的完整清单见 `core/types.ts`；每条都带 `agentId`（少数运行时级事件除外）。

### 5.1 唯一的投影：`message_update`

除 `message_update` 外，所有事件原样过线。

`message_update` 在进程内携带**两份累积量**：`message`（到此为止的完整消息）和 `assistantMessageEvent.partial`（同上）。`AssistantMessageEvent` 的 12 个变体里有 10 个带 `partial`。进程内这是指针拷贝，TUI 拿引用重渲染；**过线就是每个 token 重传一遍整条消息**，一次 10k token 的回复是 O(n²) 字节，带图片时 base64 跟着每个 delta 重发。

因此线上形状是：

```json
{ "type": "message_update", "usage": {...}, "assistantMessageEvent": { "type": "text_delta", "contentIndex": 0, "delta": "o" } }
```

两份累积量都丢掉，只留 `usage`——它是唯一只有累积量才携带的事实，而它体积恒定。客户端自行累积 delta；`message_start` 与 `message_end` 仍各携带一次权威消息，所以这是无损的。

导出的 `WireOrchestratorEvent` 是投影后的类型，客户端应当照它写而不是照进程内类型写。

### 5.2 事件到达顺序不保证

与 `docs/orchestrator.md` §4 记的一致：观察者可能先看到某个陌生 id 的 `agent_status_changed` 或 `agent_idle`，再看到它的 `agent_spawned`。**客户端必须容忍陌生 id。**

### 5.3 客户端错过的事件

`ready` 之前发生的事（root agent 的创建）不会作为事件送达——client 那时还没注册。`ready` 陈述初始事实，其后每一帧描述对它的改变。root agent 的状态用 `inspect` 取。

## 6. Human request

core 的一等概念（`core/human-request.ts` 的 `HumanRequestBroker`），RPC 只是把它接到线上。

```
出向  { "type": "human_request", "request": { "id": "human-request-1", "kind": "confirm", "title": "...", ... } }
入向  { "type": "human_response", "requestId": "human-request-1", "response": { "kind": "confirm", "confirmed": true } }
入向  { "type": "human_response", "requestId": "human-request-1", "cancelled": true }
出向  { "type": "human_request_withdrawn", "requestId": "human-request-1", "reason": "..." }
```

`kind` 为 `confirm | select | multi-select | questions | input | custom`，答复的 `kind` 必须与之相符。请求生命周期另有四个事件（`human_request_pending | resolved | timeout | cancelled`）走普通事件流。

### 6.1 超时

`request.timeoutMs` 存在时由 core 计时并在超时后拒绝调用方；那是**提问方**设的。客户端也可以用 `cancel_human_request` 主动取消。

RPC 层自己的默认超时用 `--human-timeout <ms>` 设置，**默认不设**：对交互式客户端"一直等"是对的，对一条也不答的批量客户端则意味着 agent 会把整轮跑的时间耗在这里。做批量评测时应当设它。

### 6.2 撤回

`human_request_withdrawn` 说的是"这条请求不再等答复了"。它不是对客户端任何输入的答复，所以不带 `id`：客户端关掉 `requestId` 对应的界面，什么也不用回。

三条路径会发它：RPC 超时、提问方撤回（agent 被 dispose 等）、输入流结束时清空全部待答。这三条都是**handler 侧**放弃，core 自己的 `human_request_timeout` / `_cancelled` 事件只覆盖 core 决定的撤回，都到不了客户端——没有这一帧，客户端会一直挂着一个永远不会有人读答案的提问框。

## 7. stdout 独占与回压

### 7.1 stdout 被接管

启动时 `process.stdout.write` 被替换，**所有普通写入转到 stderr**；协议自己走私有通道写真 stdout。

任何一个 `console.log`——扩展的、依赖的、调试残留的——落进 stdout 就会插进 JSONL 帧中间，把流损坏成不可解析。RPC 模式下 core extension 全部照常加载，等于把第三方代码和协议流放在同一个管道上，而 `console.log` 是它们最自然的调试手段。因此这条是必需的，不是防御性的。

**诊断、栈、任何非协议输出都在 stderr。**

### 7.2 回压一路传到模型循环

帧写入串成保序队列，`EAGAIN`/`ENOBUFS`/`EWOULDBLOCK` 重试，其它写错误闭锁通道（消费方已经看到半条帧，没有可重新同步的状态）。

client 的 `receive` 在交出帧之后等待排空。链路上每一跳都是 `await`：

```
harness emitAny → await listener        packages/agent/src/harness/agent-harness.ts
  → await _handleHarnessEvent
    → await bus.publish
      → await client.receive            apps/widi/src/core/event-bus.ts
```

所以消费端读得慢会一路顶回模型循环，而不是在内存里堆事件。

### 7.3 代价：多 agent 共享命运

所有 agent 的事件经过同一条 bus、同一个 client、同一条写尾链。**客户端读得慢会把全部 agent 的模型循环一起堵住**，不只是它当时在读的那个。这是构造性的，不是概率问题。

取舍是刻意的：回压传到模型循环是想要的性质（否则内存无界），"全部一起慢下来"是安全的失败模式。要真正解耦得给每个 agent 独立写队列加各自水位，等于在协议里引入多路复用。

### 7.4 并发批量：每个样本一个进程

这是**已定的**运行方式，不是建议：批量评测时，**一个样本一个 widi 进程**，不要在一个进程里并发跑多个样本 agent。

§7.3 是直接原因——同进程内一个慢读者造成的回压停顿会污染其它 agent 的时延，而分阶段时延正是评测要报的数（§9.5）。除此之外还有三条：失败互不牵连（一个样本打爆进程不影响其余）、`cwd` 与 agent dir 天然隔离、`shutdown` 之后进程退出即是干净的资源边界。实现成本为零：客户端起进程、写命令、读 stdout，多进程与单进程是同一段代码。

一个进程里多 agent 的能力**并没有被取消**——`spawn` 的 `parent`、跨 agent 消息、agent 树都照常工作。不建议的只是"用多 agent 并发跑互不相关的样本"这一种用法。

## 8. 版本与兼容策略

`ready.protocolVersion` 是协议版本，当前为 `1`。

- **不 bump**：新增命令、在帧或结果中新增可选字段、新增事件类型、新增出向帧类型、放宽校验、**在 §3.4 表里新增失败码**。客户端必须忽略不认识的字段、事件类型与帧类型，并把不认识的失败码当作 `internal`。
- **bump**：删除或重命名字段、收紧既有字段的取值、改变既有命令的语义或既有事件的含义、**改变既有失败码的含义或它映射的失败集合**。

客户端应当检查 `protocolVersion` 并在大于自己所知时拒绝运行或降级，不要假设向前兼容。

## 9. 落地顺序与剩余缺口

排序标准是"什么会让一次评测产出错的数或者产不出数"，不是"什么阻塞契约"。一个挂住的样本会挂住整批，一个分不了类的失败会让整批结果无法归因——这两条先做；校验过浅伤的是写客户端时的调试成本，是一次性的，往后放。

| 组 | 内容 | 状态 |
| --- | --- | --- |
| 一 | 失败码分类（§3.4）、deadline 与命令级取消（§4.4）、human request 超时与撤回（§6.1、§6.2） | **已落地** |
| 二 | 子进程级端到端测试（§9.1） | **已落地** |
| 三 | 完成信号与两条漏掉的投影（§4.6、§9.9） | **已落地** |
| 四 | typebox schema：运行时校验 + 可发布 JSON Schema（§3.3、§9.2、§9.3） | **已落地** |
| 五 | `run_summary`（§9.5） | 待做 |
| 六 | 生效配置快照（§9.7） | 待做 |
| — | 客户端 → 扩展方向（§9.6） | **决定不做**，理由见该节 |
| — | `send` 的 deadline（§9.8） | 挂起，等第五组定口径 |

**下一步是第五组。**

第一组为什么是一组：deadline 到期要答一个 `timeout`、取消要答一个 `aborted`，两者都得先有码表；反过来码表如果不含这两个码，也没有任何东西会产生它们。它们是一件事的两半。

第二组紧接其后，是因为它之后是其余各组的测试台架——`run_summary`、schema 拒绝、stdout 洁净都只有在真进程里才验得准。

第三组插到 schema 之前，是第二组的直接产物：e2e 证明了 `prompt` 的答复和"这棵树跑完"是两回事，而**判错样本边界会静默产出错的数**。

第四组的重心是 §9.2 的运行时校验，不是 §9.3 的 schema 文件——理由同上，它防的同样是静默算错。§9.3 在 typebox 之上几乎零成本，顺手产出，只覆盖入向；出向帧不写 schema，客户端读事件流按原始 JSON 处理即可。

### 9.1 已落地：子进程级端到端测试

`tests/rpc/e2e.test.ts` 启动真进程，用临时 agent dir（自带 provider、profile、信任设置，不碰开发者的 `~/.widi`）与一个说 OpenAI completions 线格式的本地 HTTP 服务，因此有真实 provider 往返而不需要网络或密钥。每条断言各自对应一件单元测试够不着的事：

1. 管道输入被答复，且输入结束后进程退出——§2.2 的持有与 §2.3 的第二条保证。
2. 扩展的 `console.log` 落在 stderr，stdout 每一行都是可解析的帧——**§7.1 唯一有效的验证方式**。
3. 真实 `prompt` 跑通，一次 turn 恰好一次 provider 调用，且线上的 `message_update` 既无 `partial` 也无 `message`——§5 在真实流上验证，而不是在合成事件上。
4. provider 不回应时 deadline 生效，随后 `shutdown` 在客户端仍持有 stdin 的情况下结束进程——§4.4 与 §2.3 的第一条保证。
5. agent 用 `spawn_agent` 委派、下级带归属地收到任务、报告回来把上级唤醒跑第二轮，而 `prompt` **在这之前就答复了**——§4.5。
6. 同一场委派下 `wait_tree_idle` 等到了全部结束才答复，`prompt` 的答复排在它前面——§4.6，也是第 5 条那个坑的解法。

这轮测试直接暴露了两个缺陷，都已修复：

- **stdin EOF 会在启动中途触发关闭**，进而还原 stdout。之后加载的所有扩展的输出都直接落进协议流——§7.1 在管道模式下形同虚设，而这正是最常见的用法。同一个 bug 还让 `disposeAll` 被跳过。
- **`shutdown` 命令不结束进程**：读过 stdin 之后其句柄仍被引用，客户端不关管道进程就一直活着。

两条都有测试守住：把修复撤掉，对应的用例会失败。

### 9.2 已落地：入向校验

契约与实现见 §3.3。原来的状态是 `frames.ts` 只看信封、其余 payload 直接 cast，所以错的 `mode` / `origin` / `images` / `thinkingLevel` 得不到任何可分类的报错，其中 `mode` 那条还会静默改变行为。

`src/rpc/schema.ts` 现在是入向那一半的**唯一**事实来源：`RpcCommand` 与 `RpcHumanResponseFrame` 都由 schema 推出（`Static<>`），手写的 union 已经删掉，校验器和类型不可能各说各话。`types.ts` 只保留出向那一半，因为它引的是 core 的结果类型。

做的时候顺手发现并修掉的两处：

- **"人类什么都没选"没法表达**。core 把它写成必填属性上的 `value: string | undefined`，而 JSON 送不出 `undefined`（`{"type":"undefined"}` 也不是合法 schema）。线上它是**缺省的属性**，schema 现在这么写，TS 类型仍由 `Type.Unsafe` 保持为 core 的。`null` 刻意不接受——它会作为第三种状态漏进 core，而那些 union 没有对应分支。
- **被拒绝的帧不回显 `id`**。一个手上有若干在飞命令的驱动，收到"其中某条格式不对"是没法处理的。现在 `id` 与 `cmd` 都原样带回（§3.2）。

### 9.3 已落地：可发布的 JSON Schema

[`docs/rpc-inbound.schema.json`](./rpc-inbound.schema.json)，由 `src/rpc/json-schema.ts` 从 §9.2 那份定义生成。`tests/rpc/frames.test.ts` 断言签入的文件与生成结果一致，所以它不可能漂移；重新生成用：

```bash
UPDATE_RPC_SCHEMA=1 npm --workspace apps/widi run test -- tests/rpc/frames.test.ts
```

比较的是内容不是字节——文件在 `docs/` 下，排版归仓库 formatter 管，而生成器对排版没有发言权。

只覆盖入向。出向不做的理由见 §3.3。

### 9.4 已查清：一次 turn 就是一次 provider 调用

之前记的"一次 `prompt` 发出两次 provider 请求"是 e2e fixture 自己造成的：测试模型的 `contextWindow` 是 8192，而 compaction 的 `reserveTokens` 默认 16384，于是每次 settle 都触发一次 compaction，每次 compaction 又是一次 provider 调用。把 fixture 的 `contextWindow` 提到 20 万之后，一次 `prompt` 就是一次调用，测试现在断言的是精确值 `1`。

留下的口径结论仍然成立、且要写进 §9.5：**维护工作（compaction、branch summary）自己会发 provider 请求，不属于它后面那次 turn**。费用按 turn 归集时必须把它们分开，否则一次恰好触发了 compaction 的样本会凭空贵一截。

### 9.5 缺少运行摘要

原始事实已经全部在线上：`before_provider_request` / `after_provider_response`、`retry_scheduled` / `retry_attempt_start` / `retry_finished`、`tool_execution_start` / `tool_execution_end`、每条 assistant message 的 usage 与 cost。**缺的不是可见性，是口径**——总数由谁按什么规则算。

**计划**：由 RPC 层聚合它已经看到的事件，发一帧 `run_summary`：LLM 请求数、retry 次数、工具调用数、token 与费用分项、缓存命中、分阶段时延、终止原因。口径在服务端定义并实现一次；让每个客户端自己算必然漂移。

**不在范围内**：扩展内部的 API 调用（例如某个检索扩展自己发出的 HTTP 请求）core 没有钩子，也不应该有；这类计数由扩展自报。

### 9.6 客户端与扩展之间只通了一半（**决定不做**）

先说清楚范围，因为这条容易被读成比实际严重：**RPC 触发扩展没有问题，扩展影响 RPC 也没有问题**。core 半完整加载，observer / interceptor 照常触发，`registerTool` 的工具 agent 能调，`appendSystemPrompt`、`registerProvider` 全部生效；扩展 → 客户端方向也已经通了，`extension_message_published`、`extension_output`、`extension_notification`、`extension_status_changed` 都是 `OrchestratorEvent`，`publishMessage` 就是扩展往外送结构化结果的正路。

不通的只有一条独立通道：**扩展事件总线**（`core/extension/events.ts` 的 `emitExtensionEvent` / `registerExtensionEventSubscriber`）。它与 `OrchestratorEvent` 完全并行，用于扩展之间协调，也是双端扩展的另一半接进来的方式——TUI 正是这么接的（`tui/application.ts:702-704`）。`RpcServer` 没有接。

**唯一后果：RPC 客户端当不了双端扩展的 `tui` 那一半**，既不能主动给扩展推一条命名事件，也看不见扩展之间互发的事件。

**决定不做。** 评测场景下样本配置在启动时经 agent dir / profile / 环境变量交代即可，不需要在 run 中途往扩展里推东西。要做的话是新增 `emit_extension_event` 命令与 `extension_event` 出向帧，两端都只搬运 `ExtensionEventEnvelope`，RPC 不需要理解任何领域结构——但在有人真的需要之前不加这个面。

### 9.7 缺少生效配置快照

`ready` 有 `protocolVersion` / `cwd` / `agentDir` / `diagnostics`，`inspect` 有 profile / model / tools / extensions / thinkingLevel，`AssistantMessage.responseModel` 有实际响应的模型。缺一份统一快照，且两项字段并不存在：

- **widi revision**：需要在 build 时注入 package version + git sha。
- **extension 版本**：widi 没有这个概念，只有 `declaredApiVersion`（扩展声明的 API 版本）与源路径。要保证可复现，只能新造源文件内容 hash。

### 9.8 `send` 没有 deadline

§4.4 只给了 `prompt` 与 `wait_idle`。`send` 在目标处于维护相位（compaction、branch summary）时会在投递队列里无限期 defer，而队列没有对外的取消入口——`MessageDeliveryQueue.cancel` 只在 dispose 时按 agent 整体调用。

给它加 deadline 需要先决定语义：`send` 在**被接受**时就返回，超时能保证的只是"还没被接受"，不是"没有送到"。一个没有干净保证的超时不如没有，所以这条挂着，等 §9.5 定口径时一起解决。

### 9.9 已落地：树级完成信号与两条漏掉的投影

§4.5 的后果是客户端判断不了"这一轮多 agent 协作结束了"。补了三条命令，语义见 §4.6：

- **`read_report`** ← `readAgentReport`。运行时全域、不绑调用方身份，本来就符合 §4 的投影标准，是漏的。没有它，客户端要拿一个**不是自己 prompt 的** agent（某个 agent 自己 spawn 的下级）的最终输出，只能从事件流里自己重建 `message_end`。
- **`wait_stop`** ← `waitForAgentStop`。边沿触发，补上 `wait_idle` 的电平语义在"交出工作后等它停"这个场景下的错位。
- **`wait_tree_idle`**。做成命令而不是留给客户端自己算：这个判断做错一次整批样本的边界就都错，而它只该被实现一次。

顺带修的两处：

- `waitForAgentStop` 的 `waiterAgentId` 放宽成可选。它只用于"等待方自己被 dispose 就拒绝"，而 RPC 客户端站在 orchestrator 旁边，没有自己的 dispose。
- `AgentGoneError` 之前落到 `internal`。它是 wait 类命令的正常失败——等待所依赖的 agent 被拆了——现在分类成 `agent_unavailable`。

新增的 core 投影只有一个：`AgentOrchestrator.listAgentSubtree`（走 spawn 边、同步、只返回活着的）。`_listAgentTree` 回答的是更丰富的问题并且要读 session，不是这里要的东西。

剩下的不确定性在 §4.6 说清楚了：静默窗口的**长度**没有测试能证明其必要性，它是防御而不是对已观察故障的修复。要彻底不猜，得让 orchestrator 能看到 `AgentWatches` 的 pending 状态，而那张表在 tool registry 之下——目前不值得为它开这条依赖。

## 延伸阅读

- `docs/orchestrator.md`：命令表所投影的公开方法、事件语义、跨 agent 规则。
- `docs/extensions.md`：双端契约与 core 半的能力面。
- 上游参照：`reference/pi/packages/coding-agent/src/modes/rpc/`（单 session 模型，扩展 UI 在 RPC 下降级），以及 `modes/json-event.ts`（`partial` 剥离的来源）。
