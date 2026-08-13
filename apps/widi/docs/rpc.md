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
  "error": "Unknown agent: nope", "code": "orchestrator.agent_unknown" }
```

`id` 原样回显；客户端不关联时可以省略。`code` 在失败携带了 core 诊断码或消息错误码时出现，否则缺席（缺口见 §9.4）。

成功响应的 `data` 由 `cmd` 决定，类型上按命令名分发，客户端在 `ok` 与 `cmd` 上收窄之后即可直接读取 `data`，无需断言。

## 4. 命令表

命令是 orchestrator 公开方法（`docs/orchestrator.md` §6）的机械投影。新增一个 orchestrator 方法就是新增一个 case，不为每个方法发明新动词。

| `cmd` | 参数 | `data` | 对应方法 |
| --- | --- | --- | --- |
| `spawn` | `origin`, `parent?`, `cwd?`, `model?`, `thinkingLevel?` | `{ agentId }` | `spawnAgent` |
| `send` | `agentId`, `body`, `mode`, `images?` | `MessageSendOutcome` | 人类 sink 的 `send` |
| `prompt` | `agentId`, `body`, `images?` | `PromptOutcome` | 人类 sink 的 `prompt` |
| `abort` | `agentId` | `AbortResult` | `abortAgent(id, "human")` |
| `dispose` | `agentId`, `scope?`, `reason?` | `{ agentIds }` | `disposeAgent` |
| `compact` | `agentId`, `customInstructions?` | `CompactResult` | `compactAgent` |
| `wait_idle` | `agentId` | `{}` | `waitForAgentIdle` |
| `list_agents` | — | `{ agents: AgentSnapshot[] }` | `listAgents` |
| `inspect` | `agentId` | `AgentSnapshot` | `inspectAgent` |
| `set_model` | `agentId`, `model` | `RuntimeModel` | `setAgentModelByReference` |
| `set_thinking_level` | `agentId`, `level` | `{}` | `setAgentThinkingLevel` |
| `cancel_human_request` | `requestId`, `reason?` | `{ cancelled }` | `cancelHumanRequest` |
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
```

`kind` 为 `confirm | select | multi-select | questions | input | custom`，答复的 `kind` 必须与之相符。请求生命周期另有四个事件（`human_request_pending | resolved | timeout | cancelled`）走普通事件流。

`request.timeoutMs` 存在时由 core 计时并在超时后拒绝调用方。客户端也可以用 `cancel_human_request` 命令主动取消。**当前 RPC 层不设默认超时**——缺口见 §9.5。

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

- **不 bump**：新增命令、在帧或结果中新增可选字段、新增事件类型、放宽校验。客户端必须忽略不认识的字段与事件类型。
- **bump**：删除或重命名字段、收紧既有字段的取值、改变既有命令的语义或既有事件的含义。

客户端应当检查 `protocolVersion` 并在大于自己所知时拒绝运行或降级，不要假设向前兼容。

## 9. 已知缺口与计划

按依赖顺序排列。§9.1–9.3 一组，做完之后外部客户端才有稳定契约可写，且有测试守住它。

### 9.1 边界校验过浅

`frames.ts` 只校验信封：帧是对象、`cmd` 是字符串、`id` 是字符串、human response 有必要字段。其余 payload 直接 cast——错误的 `agentId`、`origin`、`mode`、`images`、`thinkingLevel` 结构得不到稳定、可分类的校验错误。

**计划**：用 typebox 给每个命令写 schema（项目已依赖 typebox，工具参数就用它），在分类之后做边界校验。一份 schema 同时产出运行时校验、TS 类型和给外部客户端的 JSON Schema，不手写三份。失败返回 `{ ok: false, code: "rpc.invalid_command", error, path }`。

### 9.2 缺少可发布的 JSON Schema

本文与 `types.ts` 是当前仅有的契约表达，外部客户端只能照着读。§9.1 的 schema 落地后从同一份定义导出 JSON Schema 并随文档发布。

### 9.3 缺少子进程级端到端测试

现有 `tests/rpc/` 27 例覆盖分帧、入向分类、stdout 保序与回压、命令派发、human request 往返、事件投影，但**没有真正启动 `--mode rpc` 进程**。端到端只手工验证过。

**计划**：spawn 真进程，驱动 ready → spawn → prompt → 事件 → abort → shutdown，并断言 **stdout 只含协议帧**（这是 §7.1 唯一有效的验证方式）、诊断落在 stderr。

### 9.4 错误分类不稳定

`code` 只在底层错误恰好是 `OrchestratorError` 或 `MessageError` 时出现，其余失败只有自由文本 `error`。客户端无法可靠地区分"超时""目标忙""agent 不存在""模型不可用"。

**计划**：定义稳定的 `code` 枚举（`timeout | aborted | busy | unknown_agent | invalid_command | model_unavailable | …`），每条失败路径映射到其中之一，并写明各自之后 agent 处于什么状态。

### 9.5 超时与取消语义不完整

已有 agent 级 `abort` 与 `cancel_human_request`；`HumanRequest.timeoutMs` 的机制也已在 core。缺的是：

- `prompt`/`send` 的 deadline
- 命令级取消（按 `id` 取消一条在飞的命令）
- RPC 层的 human request 默认超时（**当前不设**，客户端既不答复也不取消时会一直等）
- 超时后 agent 状态的明确保证

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
