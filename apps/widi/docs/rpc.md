# RPC 模式

代码位置：`apps/widi/src/rpc/`；入口 `apps/widi/src/cli.ts`（`--mode rpc`）。

本文是 RPC 协议的规范：帧格式、命令表、事件流、生命周期、版本策略，以及已知缺口与补全计划。外部客户端应当只依赖本文写下的内容；`src/rpc/types.ts` 是它的 TypeScript 表达，两者不一致时以本文为准，并且该不一致本身是缺陷。

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

`shutdown` 命令、stdin 结束、`SIGINT`/`SIGTERM`、stdout 写失败，四条路都进同一个关闭流程：摘掉 reader、终止全部挂起的 human request、注销 client、`disposeAll`、排空 stdout、还原 stdout。

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

`id` 原样回显；客户端不关联时可以省略。

成功响应的 `data` 由 `cmd` 决定，类型上按命令名分发，客户端在 `ok` 与 `cmd` 上收窄之后即可直接读取 `data`，无需断言。

### 3.3 失败码

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

只有 `prompt` 与 `wait_idle` 可以无限等待，因此也只有这两条接受 `deadlineMs`、只有这两条能被 `cancel` 撤下。其余命令要么立即返回，要么被单次 harness 调用界定。

`deadlineMs` 是**这条命令的** deadline，不是 agent 的；到期时 agent 会怎样按命令而定：

| 命令 | 到期/被取消后 | 答复 |
| --- | --- | --- |
| `prompt` | **abort 该 agent，并等它真正停下**，然后才答复 | `timeout` / `aborted` |
| `wait_idle` | 停止等待，**agent 一动不动**——这条命令从头到尾只是在看 | `timeout` / `aborted` |

`prompt` 那条"等它真正停下"是刻意的保证：**答复到达时该 agent 已经 idle，属于它的事件也已经全部在流上**，批量驱动可以直接进入下一个样本，不必和上一个的尾巴赛跑。放弃 run 提前答复会留下一个仍在写事件的模型循环，而客户端已经认为那条命令结束了。

`cancel` 按 `id` 撤下在飞命令，因此**没有 `id` 的命令不可取消**——`id` 是唯一的把手。`commandId` 找不到（包括已经答复过的）返回 `{ cancelled: false }`，不算失败。复用一个仍在飞的 `id` 会被拒（`invalid_command`）：接受它的代价是两条不同命令共用一个关联 id。

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

取舍是刻意的：回压传到模型循环是想要的性质（否则内存无界），"全部一起慢下来"是安全的失败模式。要真正解耦得给每个 agent 独立写队列加各自水位，等于在协议里引入多路复用。对并发批量场景的影响见 §9.8。

## 8. 版本与兼容策略

`ready.protocolVersion` 是协议版本，当前为 `1`。

- **不 bump**：新增命令、在帧或结果中新增可选字段、新增事件类型、新增出向帧类型、放宽校验、**在 §3.3 表里新增失败码**。客户端必须忽略不认识的字段、事件类型与帧类型，并把不认识的失败码当作 `internal`。
- **bump**：删除或重命名字段、收紧既有字段的取值、改变既有命令的语义或既有事件的含义、**改变既有失败码的含义或它映射的失败集合**。

客户端应当检查 `protocolVersion` 并在大于自己所知时拒绝运行或降级，不要假设向前兼容。

## 9. 落地顺序与剩余缺口

排序标准是"什么会让一次评测产出错的数或者产不出数"，不是"什么阻塞契约"。一个挂住的样本会挂住整批，一个分不了类的失败会让整批结果无法归因——这两条先做；校验过浅伤的是写客户端时的调试成本，是一次性的，往后放。

| 组 | 内容 | 状态 |
| --- | --- | --- |
| 一 | 失败码分类（§3.3）、deadline 与命令级取消（§4.4）、human request 超时与撤回（§6.1、§6.2） | **已落地** |
| 二 | 子进程级端到端测试（§9.3） | 待做 |
| 三 | typebox schema：运行时校验 + 可发布 JSON Schema（§9.1、§9.2） | 待做 |
| 四 | 并发模型定案（§9.8 后半），然后 `run_summary`（§9.6） | 待做，需决定 |
| 五 | 客户端 → 扩展方向（§9.7） | 待做，条件项 |
| 六 | 生效配置快照（§9.8 前半） | 待做 |

第一组为什么是一组：deadline 到期要答一个 `timeout`、取消要答一个 `aborted`，两者都得先有码表；反过来码表如果不含这两个码，也没有任何东西会产生它们。它们是一件事的两半。

第二组紧接其后，是因为它之后是其余各组的测试台架——`run_summary`、schema 拒绝、stdout 洁净都只有在真进程里才验得准。第三组往后放的理由在上面。第五组是条件项：客户端只用 `prompt` + 事件流的话可以完全不做；要用双端扩展注入任务或收结构化结果，它就得提到第二位。

### 9.1 边界校验过浅

`frames.ts` 只校验信封：帧是对象、`cmd` 是字符串、`id` 是字符串、human response 有必要字段。其余 payload 直接 cast——错误的 `agentId`、`origin`、`mode`、`images`、`thinkingLevel` 结构得不到稳定、可分类的校验错误。

**计划**：用 typebox 给每个命令写 schema（项目已依赖 typebox，工具参数就用它），在分类之后做边界校验。一份 schema 同时产出运行时校验、TS 类型和给外部客户端的 JSON Schema，不手写三份。失败返回 `{ ok: false, code: "rpc.invalid_command", error, path }`。

### 9.2 缺少可发布的 JSON Schema

本文与 `types.ts` 是当前仅有的契约表达，外部客户端只能照着读。§9.1 的 schema 落地后从同一份定义导出 JSON Schema 并随文档发布。

### 9.3 缺少子进程级端到端测试

现有 `tests/rpc/` 38 例覆盖分帧、入向分类、stdout 保序与回压、命令派发、失败码分类、deadline 与取消、human request 往返与撤回、事件投影，但**没有真正启动 `--mode rpc` 进程**。端到端只手工验证过。

**计划**：spawn 真进程，驱动 ready → spawn → prompt → 事件 → abort → shutdown，并断言 **stdout 只含协议帧**（这是 §7.1 唯一有效的验证方式）、诊断落在 stderr。

### 9.4 `send` 没有 deadline

§4.4 只给了 `prompt` 与 `wait_idle`。`send` 在目标处于维护相位（compaction、branch summary）时会在投递队列里无限期 defer，而队列没有对外的取消入口——`MessageDeliveryQueue.cancel` 只在 dispose 时按 agent 整体调用。

给它加 deadline 需要先决定语义：`send` 在**被接受**时就返回，超时能保证的只是"还没被接受"，不是"没有送到"。一个没有干净保证的超时不如没有，所以这条挂着，等 §9.6 定口径时一起解决。

### 9.5 已落地：deadline、取消、human 超时

规范见 §3.3、§4.4、§6.1、§6.2。当时列的四项：`prompt` deadline（做了，并且保证答复时 agent 已 idle）、命令级取消（做了，按 `id`）、human request 默认超时（做了，`--human-timeout`）、超时后 agent 状态的明确保证（做了，写进 §4.4 的表）。`send` 的 deadline 拆出去成了 §9.4。

顺带修掉了一个当时没被算作缺口的实际缺陷：core 撤回一条 human request 时（agent 被 dispose）客户端从来收不到通知，会永久挂着提问界面。现在有 `human_request_withdrawn`（§6.2）。

### 9.6 缺少运行摘要

原始事实已经全部在线上：`before_provider_request` / `after_provider_response`、`retry_scheduled` / `retry_attempt_start` / `retry_finished`、`tool_execution_start` / `tool_execution_end`、每条 assistant message 的 usage 与 cost。**缺的不是可见性，是口径**——总数由谁按什么规则算。

**计划**：由 RPC 层聚合它已经看到的事件，发一帧 `run_summary`：LLM 请求数、retry 次数、工具调用数、token 与费用分项、缓存命中、分阶段时延、终止原因。口径在服务端定义并实现一次；让每个客户端自己算必然漂移。

**不在范围内**：扩展内部的 API 调用（例如某个检索扩展自己发出的 HTTP 请求）core 没有钩子，也不应该有；这类计数由扩展自报。

### 9.7 客户端与扩展之间只通了一半

扩展 → 客户端已通：`extension_message_published`、`extension_output`、`extension_notification`、`extension_status_changed` 都是 `OrchestratorEvent`。

客户端 → 扩展不通：扩展事件总线（`emitExtensionEvent` / `registerExtensionEventSubscriber`）不走 `OrchestratorEvent`，RPC 客户端既收不到也发不出。

**计划**：新增 `emit_extension_event` 命令与 `extension_event` 出向帧。补上之后 RPC 客户端就能扮演双端扩展的"第二半"——与 TUI 半同等地位，与 core 半经总线对话。结构化结果的传输与关联因此由扩展自己定义（用 `publishMessage` 发自己的 kind，用客户端先发的关联 id 串起来），RPC 不需要理解任何领域结构。

### 9.8 缺少生效配置快照，以及并发模型未定

`ready` 有 `protocolVersion` / `cwd` / `agentDir` / `diagnostics`，`inspect` 有 profile / model / tools / extensions / thinkingLevel，`AssistantMessage.responseModel` 有实际响应的模型。缺一份统一快照，且两项字段并不存在：

- **widi revision**：需要在 build 时注入 package version + git sha。
- **extension 版本**：widi 没有这个概念，只有 `declaredApiVersion`（扩展声明的 API 版本）与源路径。要保证可复现，只能新造源文件内容 hash。

**并发模型是一个待决定项**，且与 §9.6 想要的"分阶段时延"直接冲突：按 §7.3，同一进程内并发跑多个 agent 时，一个慢读者造成的回压停顿会污染其它 agent 的时延测量。两条路——每个样本一个进程（真隔离，时延互不污染，失败互不牵连，实现成本为零），或给每个 agent 独立写队列（协议引入多路复用）。**倾向前者**，但要显式决定并写进本文。

## 延伸阅读

- `docs/orchestrator.md`：命令表所投影的公开方法、事件语义、跨 agent 规则。
- `docs/extensions.md`：双端契约与 core 半的能力面。
- 上游参照：`reference/pi/packages/coding-agent/src/modes/rpc/`（单 session 模型，扩展 UI 在 RPC 下降级），以及 `modes/json-event.ts`（`partial` 剥离的来源）。
