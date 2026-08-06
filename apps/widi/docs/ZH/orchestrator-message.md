# Orchestrator message：进入模型上下文的唯一入口

面向 `apps/widi/src/core/message.ts`、`core/agent-orchestrator.ts` 与 `src/tui/`。前置阅读：`orchestrator-wiring-plan.md` §G。

> **状态：全部落地。** core、fork 放宽、TUI 渲染都已完成，`npm run check` 与全量测试通过（1163 passing）。正文描述的是正在跑的代码。
>
> 本文举例用到的 multi-agent 工具与 human-request，两者都在重做中，例子不代表它们当前或将来的形状。见 §10。

---

## 1. 决定

**所有会进入某个 agent 模型上下文的文本，都经过 orchestrator 的同一个投递方法。**

三条直接推论：

- orchestrator 不再为任何 runtime 保留私有的投递包装方法。`_deliverBackgroundResult`、`steerAgent`/`followUpAgent`、`_sendShellMessage`、`_withExtensionInputPresentation`、三处 `harness.appendMessage` 通告，全部消失。`harness.appendMessage` 现在零调用点。
- 条目自带来源与原文，UI 不靠猜。今天运行时替模型写的话和用户自己打的字在会话里是同一种条目，分不出来。
- 模型看到的仍然是纯 user 文本。带类型是给存储和 UI 的，不是给模型的。

### 两条正交的轴

这是本文最容易读错的地方，先分清楚：

| 轴 | 谁定 | 决定什么 | 持有者能不能改 |
|---|---|---|---|
| **source** | 持有者（sink 给默认值） | 渲染、追溯 | **能，随便填** |
| **投递策略** | orchestrator 发 sink 时绑定 | 唤醒方式、拦截、重试、合并 | 不能 |

`source` 不参与任何行为判断。它是一条"这段话是谁写的"的记录，用途只有两个：UI 怎么画，以及事后查这条是从哪来的。所以它可以是自由文本，也可以由 extension 自己填成任何东西——包括 `human`。

这样安排的理由：`content` 由持有者的 `render` 闭包产出（§5），所以一个持有者本来就能渲染出与用户输入逐字相同的文本。既然 kind 拦不住这件事，就不该为它付约束的代价；反过来，投递策略是真会改变运行时行为的东西，它必须跟着"你实际是谁"走。

---

## 2. 对外的技术方案

```ts
// message.ts —— 依赖图的叶子，任何模块都可以依赖它

/** 一条消息的来源。只用于渲染与追溯，不参与任何行为判断。 */
export interface MessageSource {
    /** 自由文本。core 认识 human / agent / background_job / runtime，其余按未知处理。 */
    readonly kind: string;
    /** 人读的一行，UI 在不认识 kind 时显示它。 */
    readonly label?: string;
    /** 来源自己的载荷，orchestrator 只存不解释。 */
    readonly details?: unknown;
}

export interface MessageRequest {
    readonly targetAgentId: AgentId;
    /** 语义正文，不含任何来源标记。 */
    readonly body: string;
    /** 盖过 sink 的默认 source。渲染与追溯，仅此而已。 */
    readonly source?: MessageSource;
    /** 不给就用这个 source 的默认渲染。 */
    readonly render?: (body: string) => string;
    readonly images?: readonly ImageContent[];
    readonly mode: MessageDeliveryMode;   // next_turn | interrupt | precede
}

export interface MessageSender {
    send(request: MessageRequest): Promise<MessageSendOutcome>;
}

export interface MessageSink extends MessageSender {
    prompt(request: MessageRequest): Promise<PromptOutcome>;
}
```

orchestrator 只暴露一个工厂：

```ts
messageSinkFor(binding: MessageSinkBinding): MessageSink

export interface MessageSinkBinding {
    readonly source: MessageSource;          // 默认 source，请求可覆盖
    readonly policy: MessageDeliveryPolicy;  // 投递策略，请求不可覆盖
    /** 请求不自带 render 时用它。属于 sink 而不属于 source：改了 source 只是换标签。 */
    readonly render?: (body: string) => string;
    /** 落成裸 `role:"user"` 条目。只有外壳是 true，见 §6。 */
    readonly plainEntry?: boolean;
}
```

内置生产者不各自拼 binding，走同一个函数、同一个 switch：

```ts
export type BuiltInMessageProducer =
    | { kind: "human" }
    | { kind: "agent"; senderAgentId: AgentId }
    | { kind: "background_job"; ownerAgentId: AgentId; jobId: string; mode: MessageDeliveryMode }
    | { kind: "runtime"; notice: string }
    | { kind: "extension"; extensionId: string };

export function messageBindingFor(producer: BuiltInMessageProducer): MessageSinkBinding
```

三样东西放在一个 switch 里是有意的：它们回答的是同一个问题——"这个生产者说话是怎么回事"——拆成一张 source 表、一张 policy 表、一个 render switch，就是它们开始各走各的方式：新加一个生产者只补了其中两处，读起来就像第三处有 bug。

`MessageDeliveryPolicy` 就是今天散在 `_routeMessage` 里、按 `source.kind` 分支算出来的那几个字段，现在改成绑定时给定：

```ts
export interface MessageDeliveryPolicy {
    /** 触发 _humanInterrupts 的协调。只有外壳的 sink 是 true。 */
    readonly humanInterrupt: boolean;
    /** block 是终止还是降级成诊断。 */
    readonly blockPolicy: MessageBlockPolicy;   // enforce | ignore
    /** 投递失败后留在队列里重试，而不是把错误抛回调用方。 */
    readonly retryOnFailure: boolean;
    /** 相邻同键消息合并成一条 user 消息。 */
    readonly mergeKey?: string;
}
```

### 谁拿到什么

| 持有者 | 默认 source | policy | 拿到什么 |
|---|---|---|---|
| TUI 外壳 | `{kind:"human"}` | `humanInterrupt`，`enforce`，`plainEntry` | `MessageSink`（`application.messages`） |
| agent（经 `AgentToOrchestratorHost`） | `{kind:"agent", label:senderAgentId}` | `enforce` | host 的 `sendMessage`，绑住"谁在问" |
| extension runner（每个 extension 一个） | `{kind:"extension:<name>", label:<name>}` | `enforce` | `MessageSink`（`ExtensionCoreActions.messageSinkFor`） |
| background runtime（每次结算一个） | `{kind:"background_job", details:{ownerAgentId, jobId}}` | `ignore`、`retryOnFailure`、`mergeKey` | `MessageSender`（端口 `messageSinkFor`） |
| orchestrator 自身的通告 | `{kind:"runtime", details:{notice}}` | `ignore` | `_sendRuntimeNotice` 内部自取 |

background runtime 拿的是 `MessageSender` 而不是 host：它不是 agent 作用域的模块，它服务所有 agent，说话时的身份是一个 job 而不是一个 agent。host 的每个方法都少一个"谁在问"的参数，而 background 根本没有那个"谁"。

**没有例外，source 全部可覆盖。** 包括 tool adapter：模型填的是 tool schema 里的参数，而 `source` 不在任何 tool 的 schema 里，所以选 source 的是写 tool 的人，不是模型。内置 tool 用默认值就好；extension 提供的 tool 自己填，和 extension runner 同一个信任层级：作者 API 是 `actions.prompt` / `steer` / `followUp` 的第二个参数 `ExtensionSendOptions`（`{images, source?, render?}`），三个字段原样透传进 `MessageRequest`，见 §5。

`source.details` 必须可 JSON 序列化——它要原样落进 jsonl。**目前没有运行时校验**：内置生产者填的都是字面量对象，而 extension 填的东西一旦不可序列化，会在写会话时炸在 harness 里，位置不理想但不静默。真要加，加在入队处而不是投递处。

**`prompt` 与 `send` 的区别是等不等，不是谁能用。** `prompt` 带 `requiresIdle`：调用方要拿这一轮的 assistant 结果，所以 target 忙时当场拒绝而不是排队。外壳和 extension 都拿得到它——extension 的 `actions.prompt` 语义正是"现在就跑一轮"，忙时报错是它要的行为。要"排进去"的用 `send`。能力大小的差别用一个 `extends` 表达：`MessageSender` 只有 `send`，`MessageSink` 多一个 `prompt`。

---

## 3. 三个档位与四种投递方法

`mode` 是**意图**，由生产者填；`method` 是**方法**，由队列在投递前按 target 的 live phase 推出来。两者不是一回事，混用是这个文件里迟早出事的地方。

| mode | 语义 | 可能推出的 method |
|---|---|---|
| `interrupt` | 打断当前这一轮，现在就读 | `steer`（忙）/ `prompt`（idle） |
| `next_turn` | 这一轮结束时读 | `follow_up`（忙）/ `prompt`（idle） |
| `precede` | 不唤醒，附在下一次输入之前 | `append` |

`precede` 不叫 `prompt`：`harness.prompt()` 是"立刻起一轮"，同一个词两个意思。它描述的是 resume 通告今天的实际行为——写进分支然后等着被读到。

`precede` 与其它两档走同一条队列，但它是唯一没有 phase 闸门的：`decideMessageDelivery` 在 `requiresIdle` 与 compaction 两道检查之前就返回 `append`。理由是 append 不驱动 agent loop 也不进 harness 的任何队列——harness 会把这次写入缓冲在当前操作后面，落在那一轮的保存点，所以没有哪个 phase 需要拒绝它。

harness 的 `nextTurn` 队列不能用来做这件事：它只在内存里，重启就没了，而 resume 通告必须能被第二次中断的 resume 找到。`appendCustomMessageEntry` 落在分支上，跨进程存活。

---

## 4. 图

```
                        message.ts（依赖图的叶子）
                   ┌──────────────────────────────────┐
                   │ MessageSender.send(request)      │
                   │ MessageSink.prompt(request)      │
                   └────────────────┬─────────────────┘
生产者（各持一个绑好 source + policy 的实例）
════════════════════════            ▼
                          ┌─────────────────────────────────────┐
TUI 人类输入 ────────────►│ orchestrator                         │
                          │   messageSinkFor({source, policy})   │
tool adapter ────────────►│        └──► _routeMessage            │
                          │                                      │
                          │   没有 per-runtime 的包装方法         │
extension runner ────────►│   source 全部可覆盖，policy 全部不可  │
                          │                                      │
                          │                                      │
background runtime ──────►│                                      │
  t1 / carried-over 通告   │                                      │
                          │                                      │
orchestrator 自身 ───────►│                                      │
  spawn tree / orphan t0  └──────────────────┬───────────────────┘
                                             │
                                             ▼
                              transformMessage(extension input pipeline)
                                block 按 policy.blockPolicy 处理
                                             │
                                             ▼
                              request.render?.(body) ?? 默认渲染(source, body)
                                content      = 模型读的最终文本
                                details.body = 原文，人读的
                                details.source = 谁写的
                                             │
                                             ▼
                              MessageDeliveryQueue.enqueue
                                per-target FIFO，只持有到 harness 接手
                                decideMessageDelivery(live phase, mode)
                                             │
                    ┌────────────────────────┼────────────────────────┐
                    ▼                        ▼                        ▼
              method=prompt            method=steer             method=append
              harness.prompt(msg)      method=follow_up         harness
                                       harness.steer(msg)       .appendCustomMessageEntry
                                       harness.followUp(msg)
                    │                        │                        │
                    │   ← fork 放宽：两个队列收 AgentMessage           │
                    └────────┬───────────────┘                        │
                             ▼                                        ▼
                    agent loop ─► session.appendMessage      条目 {type:"custom_message",
                             │                                     customType, content,
                             ▼                                     display, details}
              条目 {type:"message",                                   │
                    message:{role:"custom", customType, details}}     │
                             │                                        │
                             └──────────────┬─────────────────────────┘
                                            ▼
                               sessionEntryToContextMessages
                                 两条路收敛成同一个 CustomMessage
                                            │
                              ┌─────────────┴─────────────┐
                              ▼                           ▼
                     convertToLlm                  TUI hydrator / projector
                     role:"user"，content 原样       按 details.source.kind 分派
                     （模型看不出区别）              （人看得出这不是自己打的）
```

---

## 5. body / content 模型

一条消息有三份文本，各有各的读者：

| 字段 | 谁读 | 内容 |
|---|---|---|
| `MessageRequest.body` | 生产者交出来的 | 语义正文，不含任何来源标记 |
| `content` | **模型** | `render(body)` 的结果，落盘的就是它 |
| `details.body` | **人**（TUI） | 原样的 `body` |

`render` 是持有者的闭包，orchestrator 只提供缺省实现。三条约束，其余随便：

1. **只跑一次，在入队时。** 队列会因为 phase 变化重试投递，每次重跑会让同一条消息有两个版本。
2. **`details.body` 存原文，`content` 存结果。** UI 因此不用反向解析，也不用重跑闭包——闭包活不过这个进程，条目要活很久。
3. **它改不了 `customType`，也改不了 policy。** 它只负责一件事：这段话最后长什么样。

### 缺省渲染

**只在"读者需要知道这段话不是自己写的、而正文里没有这个信息"时才加前缀。**

| source.kind | 缺省渲染 |
|---|---|
| `human` | 无 |
| `agent` | `[Message from <label>]\n\n` |
| `background_job` | 无——正文自带 job header |
| `runtime` | 无——正文自带标记，且 carried-over 必须保持 job result 的形状 |
| `extension:<name>` | `[Input from extension <name>]\n\n` |
| 其它（手工搭的 sink） | 无——core 不替一个它没定义过的来源发明署名 |

### 各来源实际长什么样

以下是缺省渲染的输出，也就是落盘 `content` 的原文。

**human**——`body` 与 `content` 相同。

```
帮我看看 list_agents 现在的输出
```

**agent，普通消息**——`worker-qj7z` 向 `main-5yhi` 发。

```
[Message from worker-qj7z]

目录扫描完了，三个文件里有重复的 profile id。
```

**agent，任务指派**——`body` 由 `formatAgentTaskMessageBody` 产出，再套 agent 前缀。

```
[Message from main-5yhi]

Task job-7 assigned to you.

扫描 src 下所有 .ts，列出重复导出的符号。

When the work is complete, settle task job-7 for main-5yhi. An ordinary
message does not complete it.
```

**background_job，t1**——`body` 由 `formatBackgroundJobResultMessageText` 产出，无前缀。

```
Background job 3 (started by tool call call_a1b2, tool bash) completed:

src/core/host.ts
src/core/message.ts
```

**extension，缺省渲染**——`messageBindingFor({kind:"extension", extensionId:"mcp"})`，source 是 `{kind:"extension:mcp", label:"mcp"}`。

```
[Input from extension mcp]

工具目录已刷新，新增 4 个工具。
```

**extension，自带 render 与自选 source**——一个 Slack 网关，把远端的人如实记下来。作者 API 是 `actions.prompt` / `steer` / `followUp` 的 `ExtensionSendOptions`，`source` 与 `render` 透传进 `MessageRequest`，盖过 sink 的默认值。

```ts
actions.followUp(text, {
    source: { kind: "human", label: "Slack @arcadia", details: { via: "slack-bridge" } },
    render: (body) => `[Slack @arcadia]\n\n${body}`,
});
```

```
[Slack @arcadia]

帮我看下 CI 为什么红了
```

它也可以把 `render` 写成 `(body) => body`，产出与用户输入逐字相同的 `content`；`details.source` 里仍然留着它自己填的那份记录。**这是有意允许的**：`render` 归持有者之后，绑定 kind 本来就拦不住这件事，见 §1。

两条边界。覆盖 `source` 只是换 label，不是换能力：投递策略仍由 binding 固定，把 source 填成 `human` 不会让它触发 human interrupt，也躲不开 input 拦截。`render` 替换的是缺省的 `[Input from extension <id>]` 前缀，入队时跑一次；只覆盖 `source` 不覆盖 `render` 时，label 是作者填的，模型侧仍然带缺省前缀。

**runtime / `carried_over_jobs`**——`mode:"precede"`，无前缀。正文必须保持 job result 的形状，模型靠它匹配自己手上的 t0 handle。

```
Background job 3 (started by tool call call_a1b2, tool bash) cancelled:

The job was still running when the runtime exited. It did not survive the
restart and produced no result; start it again if its work is still needed.
```

**runtime / `orphaned_job_handles`**——同上形状，`stopReason` 不同。

```
Background job 5 (started by tool call call_c3d4, tool bash) cancelled:

This part of the conversation never recorded the job, so nothing here can
report its outcome. Start it again if its work is still needed.
```

**runtime / `spawn_tree_closed`**——正文自带方括号标记。

```
[Spawn tree closed] Every agent you created before this resume has been
closed. Spawn new ones if you still need them.
```

### 三条不变量

1. **模型侧零变化。** 上面每一段，`convertToLlm` 之后都是 `role:"user"`，`content` 原样。带类型的是条目，不是 LLM 请求。
2. **`display` 不是上下文开关。** `CustomMessage.display` 只是 UI 提示，`convertToLlm` 不看它。`display:false` 的消息照样进模型。
3. **`render` 在 transform 之后跑。** extension 的 input 管线看到的是语义 `body`；渲染是最后一步，管线改不到它。

---

## 6. 落盘形态

**决定条目形态的是唤没唤醒，不是 kind。**

| 路径 | 条目 | 写入方式 | 进上下文 |
|---|---|---|---|
| 外壳人类输入 | `{type:"message", message:{role:"user"}}` | agent loop 的 `session.appendMessage` | 是 |
| `prompt` / `steer` / `follow_up` | `{type:"message", message:{role:"custom", customType, content, display, details}}` | 同上 | 是 |
| `append` | `{type:"custom_message", customType, content, display, details}` | `harness.appendCustomMessageEntry` | 是 |
| 对照：`appendCustomEntry` | `{type:"custom", customType, data}` | `harness.appendCustomEntry` | **否** |

第 2 行是唤醒路径的必然结果，不是选择：steer / follow_up / prompt 的消息最后由 agent loop `emit(message_start/message_end)`（`agent-loop.ts:112`、`:184`），`handleAgentEvent` 收到就 `session.appendMessage(message)`，产出的只能是 `message` 条目。loop 里没有产 `custom_message` 条目的路径。所以同一个 source 的消息会落成第 2 或第 3 行中的任意一种，取决于投递当时 agent 忙不忙。

第 4 行是今天 `core:input_transform` 与 `core:extension_message` 用的那种，`custom` 条目没注册 entry projector，投影出空数组——extension 的 `publishMessage` 有自己的渲染但模型看不见，就是这个原因。这一批不动它。

第 2、3 行在 `sessionEntryToContextMessages` 里收敛成同一个 `CustomMessage`（`session.ts:105-123`），但 hydrator 仍然需要两个分支，因为它读的是条目而不是投影后的消息。

### customType 只有一个

```
core:orchestrator_message
```

分派键是 `details.source.kind`，不是 `customType`。理由：`kind` 现在是开放字符串，用它铸造 customType 等于让持有者往类型空间里写任意值；而且 UI 无论如何都要有"不认识这个 kind"的兜底分支，那就让它从一开始就是分派的正常路径。

`details` 的形状：

```ts
{
    source: MessageSource,   // 持有者填的，原样存
    body: string,            // render 之前的原文
    transformedBy?: string[] // extension input 管线改写过的话
}
```

**`source` 落盘，下次 rehydrate 时照它渲染。** 两种条目形态都带得动：`CustomMessageEntry.details` 直接进 jsonl；`role:"custom"` 消息的 `details` 随整条 `{type:"message", message}` 落盘。读回来时 `sessionEntryToContextMessages` 对前者调 `createCustomMessage(..., details, ...)`、对后者原样返回，两条路的 `details` 都在；而 hydrator 读的是 `SessionTreeEntry` 本身，看到的是 `entry.details` 与 `entry.message.details`。所以一个持有者今天自己定的 kind，明天重开会话仍然按它渲染，不需要额外的登记机制——代价是 UI 必须容忍它不认识的 kind，见 §7。

**外壳的人类输入是唯一的例外**：它落成裸的 `role:"user"` 条目，没有 customType 也没有 details。既有会话和 prompt 行为一行不变，而且"没有类型"本身就是"这是从外壳进来的用户输入"的判据。

一个持有者把 source 填成 `{kind:"human"}` 时，它拿到的是**渲染上的等同**，不是条目上的等同——条目仍然是 `core:orchestrator_message`，`details.source` 里留着它填的那份记录。追溯因此不会被伪装擦掉。

> 这是本文的一处判断，不是推导。真要 bit 级等同于用户输入的话，把这一条去掉即可，代价是那条消息事后无法追溯。

唤醒路径需要 fork 放宽 harness 的两个队列类型，见 §8。

### 一条分支的实际样子

场景：`main-5yhi` 正在跑一轮。以下是落在 `session.jsonl` 上的原文，assistant 与 tool 条目省略。

**① 外壳人类输入——唤醒（prompt）**

```json
{"type":"message","id":"af4de9c8","parentId":"3b21c0de",
 "timestamp":"2026-08-05T09:14:02.113Z",
 "message":{"role":"user",
            "content":[{"type":"text","text":"帮我扫一下 src 下重复的导出"}],
            "timestamp":1785663242113}}
```

今天已经在跑的形态，一个字段不改。`role:"user"` 且没有 `customType`，这本身就是"从外壳进来的人类输入"的判据。

**② background t1——唤醒（agent 在忙，走 steer）**

```json
{"type":"message","id":"c07f1a92","parentId":"af4de9c8",
 "timestamp":"2026-08-05T09:14:11.880Z",
 "message":{"role":"custom",
            "customType":"core:orchestrator_message",
            "content":[{"type":"text","text":"Background job 3 (started by tool call call_a1b2, tool bash) completed:\n\nsrc/core/host.ts\nsrc/core/message.ts"}],
            "display":true,
            "details":{"source":{"kind":"background_job","label":"job 3",
                                 "details":{"ownerAgentId":"main-5yhi","jobId":"3"}},
                       "body":"Background job 3 (started by tool call call_a1b2, tool bash) completed:\n\nsrc/core/host.ts\nsrc/core/message.ts"},
            "timestamp":1785663251880}}
```

条目类型仍然是 `message`，只是里面的 `role` 是 `custom`。这里 `content` 与 `details.body` 恰好相同，因为 job 结果的缺省渲染不加前缀。

**③ agent 消息——唤醒（走 follow_up）**

```json
{"type":"message","id":"1d4e5f60","parentId":"c07f1a92",
 "timestamp":"2026-08-05T09:15:33.201Z",
 "message":{"role":"custom",
            "customType":"core:orchestrator_message",
            "content":[{"type":"text","text":"[Message from worker-qj7z]\n\n扫完了，三个文件有重复的 profile id。"}],
            "display":true,
            "details":{"source":{"kind":"agent","label":"worker-qj7z"},
                       "body":"扫完了，三个文件有重复的 profile id。"},
            "timestamp":1785663333201}}
```

这条能看出 `content` 与 `details.body` 为什么要分开：模型读带前缀的那份，TUI 显示不带前缀的那份，前缀承载的信息由样式表达。

**④ 运行时通告——不唤醒（precede / append）**

```json
{"type":"custom_message","id":"7a9b0c11","parentId":"1d4e5f60",
 "timestamp":"2026-08-05T09:31:44.002Z",
 "customType":"core:orchestrator_message",
 "content":[{"type":"text","text":"[Spawn tree closed] Every agent you created before this resume has been closed. Spawn new ones if you still need them."}],
 "display":true,
 "details":{"source":{"kind":"runtime","label":"spawn tree closed",
                      "details":{"notice":"spawn_tree_closed"}},
            "body":"[Spawn tree closed] Every agent you created before this resume has been closed. Spawn new ones if you still need them."}}
```

条目类型不同：`custom_message`，没有 `message` 包壳，四个字段直接长在条目上，也没有内层 `timestamp`。

### 字段各自干什么

| 字段 | ② ③ 在哪 | ④ 在哪 | 模型看得到 | 干什么 |
|---|---|---|---|---|
| `type` | 条目 | 条目 | 否 | `message` / `custom_message`，决定投影规则 |
| `id` / `parentId` | 条目 | 条目 | 否 | 分支树。navigate、fork 靠它 |
| `timestamp`（外层） | 条目 | 条目 | 否 | 写入时刻，TUI 排序 |
| `message.role` | 消息 | — | 否 | `user` = 外壳人类；`custom` = 其它来源 |
| `customType` | 消息内 | 条目上 | **否** | UI 分派第一层。本设计只有一个值 |
| `content` | 消息内 | 条目上 | **是，逐字** | 模型唯一读到的东西 |
| `display` | 消息内 | 条目上 | 否 | UI 提示。**不是上下文开关**，`false` 也照样进模型 |
| `details.source` | 消息内 | 条目上 | 否 | 渲染分派 + 追溯 |
| `details.body` | 消息内 | 条目上 | 否 | render 之前的原文，TUI 显示这个 |
| `message.timestamp` | 消息 | — | 否 | provider 转 API 请求时不发 |

### 积压的 precede 遇到唤醒消息会怎样

**它不会转化，也不会被合并进别的消息。** `precede` 和唤醒消息排同一条 per-target FIFO，但轮到它时 `appendCustomMessageEntry` 把条目挂到当前 leaf 上，写完就结束。"等着被读到"是指它躺在分支上等下一轮构建上下文时一起读进去，不是躺在队列里等着被拼进某条用户消息。

所以用户接着输入时，只是多了一条 `parentId` 指向 ④ 的普通条目：

```json
{"type":"message","id":"e2f3a4b5","parentId":"7a9b0c11",
 "timestamp":"2026-08-05T09:40:12.556Z",
 "message":{"role":"user","content":[{"type":"text","text":"那把重复的列出来"}],
            "timestamp":1785665412556}}
```

这一轮 `convertToLlm` 出来的请求体，末尾是几条相邻且平级的 `role:"user"`：

```jsonc
[ /* ... 更早的上下文 ... */
  { "role":"user", "content":[{"type":"text","text":"帮我扫一下 src 下重复的导出"}] },   // ①
  /* assistant + tool 若干 */
  { "role":"user", "content":[{"type":"text","text":"Background job 3 (started by tool call call_a1b2, tool bash) completed:\n\n..."}] },  // ②
  { "role":"user", "content":[{"type":"text","text":"[Message from worker-qj7z]\n\n扫完了，三个文件有重复的 profile id。"}] },  // ③
  { "role":"user", "content":[{"type":"text","text":"[Spawn tree closed] Every agent you created before this resume has been closed..."}] },  // ④
  { "role":"user", "content":[{"type":"text","text":"那把重复的列出来"}] }               // ⑤
]
```

模型看不出 ①–⑤ 的区别，全是 user 文本。这是设计目标，不是妥协——区别只存在于条目里，给存储和 UI 用。

两个附带的事实：

- **没有合并。** 合并要求相邻两条带同一个 `mergeKey`，而 runtime binding 不带 mergeKey（只有 background t1 带），所以 ④ 和 ⑤ 是两条独立的 user 消息，不会拼成一条。
- **跑轮期间写的 precede 会被缓冲。** harness 在运行操作时 buffer 自己的写入，条目落在那一轮的保存点，排在那一轮的消息之后。它的位置取决于 flush 时 leaf 在哪，不是调用 `send` 的那一刻。

---

## 7. UI 层如何区分渲染

今天 TUI 只有两种输入形态：`user-message`（用户打的字，也包括运行时冒名写的）和 `extension-message`（`core:extension_message` 自定义条目，有自己的渲染但不进模型上下文）。改造后多出一类：**进了模型上下文、但不是从外壳进来的用户输入**。

### 两条读取路径

- **hydrate**（`tui/session-hydrator.ts`）：加两个分支——`custom_message` 条目，以及 `message` 条目里 `message.role === "custom"` 的。两者都读 `customType` 与 `details`。
- **实时**（`tui/event-projector.ts`）：`applyMessageStart` 今天只认 `user` 和 `assistant`，要加 `custom`。`queue_update` 载荷里的消息也可能是 custom，`queuedMessageText` 要跟着改。

两条路径产出同一个新的 timeline item：

```ts
export interface OrchestratorMessageItem {
    readonly type: "orchestrator-message";
    readonly id: string;
    readonly durability: TimelineDurability;
    readonly createdAt: string;
    readonly source: MessageSource;   // 分派与显示都看它
    text: string;                     // details.body，人读的原文
    modelText?: string;               // content，与 text 不同时才带
}
```

**没有 `details` 的条目会被丢掉，不会退化成 user message。** 无法追溯是谁写的时候，把它显示成用户自己打的字，比什么都不显示更糟。

**它和 user message 一样开启一个 turn。** `groupTurns` 两种都认：模型读到哪一种都会作答，只数用户打的字会让一个全靠 agent / job 消息驱动的会话变成一个永不裁剪的巨型 turn。

### 渲染分派

当前实现是统一的一种块，不按 kind 分形态：所有 `orchestrator-message` 条目都渲染成 `↳ 标题 + body`，body 只做截断（`maxLines: 24`、`maxCharacters: 8_000`）。`background_job` 不折叠，`runtime` 也不降出对话流的主视觉层次——这两种更精细的形态是未实现的后续方向，不是现状。

标题按 `source.kind` 经 `orchestratorMessageTitle` 得出，**必须有兜底**：

| 条目 / source.kind | 渲染 |
|---|---|
| 条目是裸 `role:"user"` | 用户消息，与今天一致 |
| `human`（来自非外壳的 sink） | `↳ from <label>` |
| `agent` | `↳ agent <label>` |
| `background_job` | `↳ <label>`（label 即 `job <id>`） |
| `runtime` | `↳ runtime · <label>` |
| `extension:<name>` | `↳ extension <name>` |
| 其它 / 未知 | 标题取 `source.label ?? source.kind` |

落地的标题行（`orchestratorMessageTitle`）：`↳ agent worker-7` / `↳ job 3` / `↳ runtime · spawn tree closed` / `↳ extension mcp` / 未知 kind 直接用 label。

最后一行不是补丁，是常态：kind 开放之后，UI 见到没听说过的 kind 是正常情况，不是数据损坏。

**渲染读 `details.body` 而不是 `content`。** 前缀是给模型的，人不需要在界面上再看一遍"[Message from worker-qj7z]"——那个信息应该由样式表达。想看模型实际读到什么，走已有的 `modelText` 机制（今天 `core:input_transform` 就是这么做的）。

---

## 8. 这一批要动的东西

### fork 改动（`packages/agent`）

唤醒路径要能带类型，放宽了 harness 的类型收窄：

- `steerQueue` / `followUpQueue`：`UserMessage[]` → `AgentMessage[]`（`nextTurnQueue` 本来就是宽的）
- `prompt` / `steer` / `followUp` / `nextTurn`：接受 `string | AgentMessage`
- `promoteFollowUpsToSteer`、`abort` 的返回类型、`queue_update` 的载荷跟着放宽

`agent-loop.ts` 那一侧早就是 `AgentMessage[]`（`packages/agent/src/types.ts:239/252`），`AbortResult` 与 `queue_update` 载荷本来就是宽的，所以这是纯类型放宽，对现有调用方零行为变化。传字符串的调用方拿到的还是原来那条 user message；`toInputMessage` 与 `toInputText` 两个 helper 就是全部实现。已记进 `docs/pi-fork.md` 的"The typed input widening"一节。

orchestrator 这一侧只有一个生产者构造这种消息：`toHarnessInput`，从 `MessageEntryPayload` 造 `CustomMessage`。外壳的人类输入仍然走裸字符串，落成裸 `role:"user"` 条目。

### 消失的东西

| 消失的 | 因为 |
|---|---|
| `_deliverBackgroundResult` | background 直接持 `MessageSender` |
| `BackgroundJobDelivery` / `BackgroundJobDeliveryReceipt` / `deliverResult` 端口 | 同上；`entryId` 本来就没人产没人读 |
| `reconcileBranch` 的 `announce` 回调 | background 自己发；`toCarriedOverJobResultText` 从 orchestrator 挪进 `background/` |
| `steerAgent` / `followUpAgent` | 收编进 `_routeMessage`，`mode` 表达同一件事 |
| `_withExtensionInputPresentation` | input presentation 整条通道删除，见下 |
| `_sendShellMessage` | 外壳持 sink，不需要 orchestrator 替它包一层 |
| `ExtensionCoreActions.promptAgent` / `steerAgent` / `followUpAgent` | 三者只差 `mode` 与等不等，收成一个 `messageSinkFor(extensionId)` |
| `sendMessage` / `promptAgent` 的第三个参数 | presentation 没了，直接调用与 sink 调用再无能力差 |
| 三处 `harness.appendMessage` 通告 | 变成 `mode:"precede"` |
| `_routeMessage` 里按 `source.kind` 分支算 policy 的代码 | policy 改成发 sink 时绑定 |
| `MessageSource` 的封闭联合类型 | kind 变成开放字符串 |
| `messageBlockPolicy(source)` | policy 改成绑定时给定，不再从 kind 反推 |
| `ExtensionInputPresentation` 及其 validate / clone | 见下 |
| `core:extension_input_presentation` 条目、`extension_input_presented` 事件 | 同上 |
| `_pendingExtensionInputPresentations` 及配套的六个方法 | 同上 |

### input presentation 整条删除

`ExtensionSendOptions.presentation` 这条通道**已经整体删除**：`ExtensionSendOptions` 上没有 `presentation` 字段，`ExtensionInputPresentation` 类型及其 validate / clone、`extension_input_presented` 事件、`core:extension_input_presentation` 条目、orchestrator 的 `_pendingExtensionInputPresentations` 配对队列全部不存在。删除前它就是一条只写不读的链路——TUI 既没有渲染过那个事件，也没有读过那种条目，从 extension 作者 API 一直到 orchestrator 的 per-target 配对队列都没有消费者。

删掉的理由不是"没人用所以砍掉"，是它放错了层：一条消息在界面上长什么样，属于 TUI 侧的 extension 宿主，不属于 core 的投递管线。core 该保证的是消息带着 `source` 和 `details` 完整落盘（§6 做到了），够 UI 层自己决定渲染。重建时它落在 TUI 层。

`ExtensionMessage` / `ExtensionStatus` / `emitOutput` / `notify` / `reportDiagnostic` 这些**保留**：它们和消息投递无关，是 extension 自己的展示面。

### 要承认的行为变化

1. **extension 的输入默认不再冒充人类。** 改造前 `actions.promptAgent` 转手调 orchestrator 的 `promptAgent`，后者写死 `source:{kind:"human"}`，所以 extension 打的字在会话里、在 `_humanInterrupts` 协调里、在 TUI 里和用户完全一样。现在它的默认 source 是 `{kind:"extension:<name>"}`。它仍然可以把 source 填回 `human`——`prompt` / `steer` / `followUp` 的 `ExtensionSendOptions.source` / `render` 就是这个用途，已落地，见 §5——但 `humanInterrupt` 跟着 policy 走，填 source 改不了它。
2. **extension 的 steer / followUp 会被拦截。** 今天这两条完全绕过 input 管线，改造后会经过别的 extension 的 transform，也可能被 block。
3. **runtime 通告的 block 策略是 `ignore`。** 与 background t1 同理且更硬：`reconcileBranch` 的通告发完就写 job 记录，如果 extension 把它 block 掉，记录照写、模型永远不知道，那是静默丢失。block 降级成诊断：任何 `blockPolicy:"ignore"` 的生产者被 block 时都记 `orchestrator.message_block_ignored`，不再只针对 background_job。
4. **老会话不追溯。** 已经落成 `role:"user"` 的通告继续按用户消息渲染，不做迁移。
5. **extension 的 `presentation` 参数消失。** 传了会是类型错误。见上一节。
6. **`precede` 与唤醒消息共用 per-target FIFO。** compaction / branch_summary 期间被 defer 的消息会挡住排在它后面的通告——是停顿不是死锁，phase 一变两条都走。要不要给 `precede` 单开一条道还没定。

---

## 9. 不在本次范围

- **subagent 运行状态进上下文。** 机制上做完这一批就只是再发一个 sink，但它缺一条策略：哪些状态变化值得进父 agent 的上下文、要不要节流。子 agent 每次 idle/running 翻转都进上下文是 token 水龙头。等规则想清楚单开。
- **input presentation 在 TUI 层的重建。** core 侧已经整条删除（§8）。重建时它读的是 `details.source` 与 `details.body`，不需要 core 再存第二份记录。
- **extension 的 transform 挂载点。** 同上，v1 只做投递侧。

---

## 10. 备忘：本文引用的两处正在重做

**multi-agent 工具方案会重做。** 本文里所有 `kind:"agent"` 的例子——`[Message from worker-qj7z]`、任务指派的正文、`send_message` 的调用形态——都是**例子，不是对当前 runtime 的描述**，也不该被当成将来的规格。那套工具（spawn / send_message / list_agents / dispose）的形状会变。

不变的是通道本身：**来自其它 agent 的消息一样从这个 sink 进来。** 工具层怎么改，都改不到下面这条——一条消息的落盘形态、渲染方式、可追溯性，由三样东西共同决定：

| | 谁给 | 决定 |
|---|---|---|
| `source.kind`（+ `label`） | 持有者，自由文本 | 渲染分派、追溯 |
| `render` 闭包 | 持有者，可缺省 | 模型逐字读到的 `content` |
| `source.details` | 持有者，任意 JSON | 追溯所需的一切额外事实 |

这三样是给 multi-agent 那一层留的全部自由度，也是它需要的全部。新的工具方案要表达什么——发送者是谁、是不是任务、属于哪棵树、经过了几跳中转——都往这三样里填，不需要 orchestrator 这一层配合改动。反过来说，如果新方案发现这三样不够用，那才是回来改本文的信号。

**human-request 未来也会重做。** `HumanRequestBroker` 今天是另一条"运行时替模型说话"的路径，本文没有依赖它，这一批也不动它。重做时要回答的问题是：它并入这个通道（一次请求就是一条 `kind:"human_request"` 的消息，回答是另一条），还是保持独立。本文不预判，只记下它是同一族的问题。
