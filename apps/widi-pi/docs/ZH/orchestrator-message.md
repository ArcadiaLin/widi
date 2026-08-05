# Orchestrator message：进入模型上下文的唯一入口

面向 `apps/widi-pi/src/core/message.ts`、`core/agent-orchestrator.ts` 与 `src/tui/`。前置阅读：`orchestrator-wiring-plan.md` §G。

> **状态：设计，未落地。** 本文是 `orchestrator-wiring-plan.md` 批次 5（G）的设计说明，落地前可改。
>
> 本文举例用到的 multi-agent 工具与 human-request，两者都在重做中，例子不代表它们当前或将来的形状。见 §10。

---

## 1. 决定

**所有会进入某个 agent 模型上下文的文本，都经过 orchestrator 的同一个投递方法。**

三条直接推论：

- orchestrator 不再为任何 runtime 保留私有的投递包装方法。`_deliverBackgroundResult`、`steerAgent`/`followUpAgent`、`_withExtensionInputPresentation`、三处 `harness.appendMessage` 通告，全部消失。
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
    readonly presentation?: ExtensionInputPresentation;
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
messageSinkFor(binding: {
    readonly source: MessageSource;      // 默认 source，持有者可覆盖
    readonly policy: MessageDeliveryPolicy;  // 投递策略，持有者不可覆盖
}): MessageSink
```

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

| 持有者 | 默认 source | policy | 接口 |
|---|---|---|---|
| TUI / RPC 外壳 | `{kind:"human"}` | `humanInterrupt`，`enforce` | `MessageSink` |
| tool adapter（每个 agent 一个） | `{kind:"agent", label:agentId}` | `enforce` | `MessageSender` |
| extension runner（每个 extension 一个） | `{kind:"extension:<name>"}` | `enforce` | `MessageSender` |
| background runtime（每次结算一个） | `{kind:"background_job", details:{jobId}}` | `ignore`、`retryOnFailure`、`mergeKey` | `MessageSender` |
| orchestrator 自身的通告 | `{kind:"runtime", details:{notice}}` | `ignore` | `MessageSender` |

**没有例外，source 全部可覆盖。** 包括 tool adapter：模型填的是 tool schema 里的参数，而 `source` 不在任何 tool 的 schema 里，所以选 source 的是写 tool 的人，不是模型。内置 tool 用默认值就好；extension 提供的 tool 自己填，和 extension runner 同一个信任层级。

`source.details` 必须可 JSON 序列化，入队时校验（`assertJsonSerializable`）。晚于这一刻发现，消息已经过了 transform 正要投递，失败点就落在了错的地方。

**为什么 `prompt` 只给外壳。** `prompt` 带 `requiresIdle`：调用方要等这一轮的 assistant 结果，所以 target 忙时当场拒绝而不是排队。tool 和 extension 调它只会拿到"agent 忙"的失败，而它们要的是"排进去"。这不是路径不统一，是能力大小不同，一个 `extends` 表达得了。

---

## 3. 三个档位与四种投递方法

`mode` 是**意图**，由生产者填；`method` 是**方法**，由队列在投递前按 target 的 live phase 推出来。两者不是一回事，混用是这个文件里迟早出事的地方。

| mode | 语义 | 可能推出的 method |
|---|---|---|
| `interrupt` | 打断当前这一轮，现在就读 | `steer`（忙）/ `prompt`（idle） |
| `next_turn` | 这一轮结束时读 | `follow_up`（忙）/ `prompt`（idle） |
| `precede` | 不唤醒，附在下一次输入之前 | `append` |

`precede` 不叫 `prompt`：`harness.prompt()` 是"立刻起一轮"，同一个词两个意思。它描述的是 resume 通告今天的实际行为——写进分支然后等着被读到。

`precede` 不需要队列。`appendCustomMessageEntry` 直接落在当前 leaf 上，天然排在下一次用户输入之前，而且跨进程存活。harness 的 `nextTurn` 队列不能用——它只在内存里，重启就没了，而 resume 通告必须能被第二次中断的 resume 找到。

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
| 其它（含 `extension:<name>`） | `[Input from <label ?? kind>]\n\n` |

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

**extension，缺省渲染**——`{kind:"extension:mcp"}`。

```
[Input from extension:mcp]

工具目录已刷新，新增 4 个工具。
```

**extension，自带 render 与自选 source**——一个 Slack 网关，把远端的人如实记下来。

```ts
sink.send({
    targetAgentId,
    body: text,
    source: { kind: "human", label: "Slack @arcadia", details: { via: "slack-bridge" } },
    render: (body) => `[Slack @arcadia]\n\n${body}`,
    mode: "next_turn",
});
```

```
[Slack @arcadia]

帮我看下 CI 为什么红了
```

它也可以把 `render` 写成 `(body) => body`，产出与用户输入逐字相同的 `content`；`details.source` 里仍然留着它自己填的那份记录。**这是有意允许的**：`render` 归持有者之后，绑定 kind 本来就拦不住这件事，见 §1。

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
                                 "details":{"jobId":"3","toolCallId":"call_a1b2"}},
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

**它不会积压，也不会转化。** `precede` 不进 `MessageDeliveryQueue`——`appendCustomMessageEntry` 当场把条目挂到当前 leaf 上，写完就结束。"等着被读到"是指它躺在分支上等下一轮构建上下文时一起读进去，不是躺在内存队列里等着被合并进某条用户消息。

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

- **没有合并。** 队列的 `mergeKey` 只作用于走队列的消息，`append` 不走队列，所以 ④ 和 ⑤ 是两条独立的 user 消息，不会拼成一条。
- **跑轮期间写的 precede 会被缓冲。** harness 在运行操作时 buffer 自己的写入，条目落在那一轮的保存点，排在那一轮的消息之后。它的位置取决于 flush 时 leaf 在哪，不是调用 `send` 的那一刻。

---

## 7. UI 层如何区分渲染

今天 TUI 只有两种输入形态：`user-message`（用户打的字，也包括运行时冒名写的）和 `extension-message`（`core:extension_message` 自定义条目，有自己的渲染但不进模型上下文）。改造后多出一类：**进了模型上下文、但不是从外壳进来的用户输入**。

### 两条读取路径

- **hydrate**（`tui/session-hydrator.ts`）：加两个分支——`custom_message` 条目，以及 `message` 条目里 `message.role === "custom"` 的。两者都读 `customType` 与 `details`。
- **实时**（`tui/event-projector.ts`）：`applyMessageStart` 今天只认 `user` 和 `assistant`，要加 `custom`。`queue_update` 载荷里的消息也可能是 custom，`queuedMessageText` 要跟着改。

两条路径产出同一个新的 timeline item：

```ts
interface OrchestratorMessageItem {
    type: "orchestrator-message";
    source: MessageSource;       // 分派与显示都看它
    text: string;                // details.body，人读的原文
    modelText?: string;          // content，与 text 不同时才带
    ...
}
```

### 建议的渲染分派

按 `source.kind` 分派，**必须有兜底**：

| source.kind | 渲染 |
|---|---|
| 条目是裸 `role:"user"` | 用户消息，与今天一致 |
| `human`（来自非外壳的 sink） | 同上样式，但角标注明 `source.label` |
| `agent` | 带发送方 agent id 的消息块，与用户消息不同的边框/颜色 |
| `background_job` | 折叠块，标题是 job id 与状态，正文默认收起 |
| `runtime` | 系统通告条，不进对话流的主视觉层次 |
| 其它 / 未知 | 通用"外部输入"样式，标题取 `source.label ?? source.kind` |

最后一行不是补丁，是常态：kind 开放之后，UI 见到没听说过的 kind 是正常情况，不是数据损坏。

**渲染读 `details.body` 而不是 `content`。** 前缀是给模型的，人不需要在界面上再看一遍"[Message from worker-qj7z]"——那个信息应该由样式表达。想看模型实际读到什么，走已有的 `modelText` 机制（今天 `core:input_transform` 就是这么做的）。

---

## 8. 这一批要动的东西

### fork 改动（`packages/agent`）

唤醒路径要能带类型，需要放宽 harness 的类型收窄：

- `steerQueue` / `followUpQueue`：`UserMessage[]` → `AgentMessage[]`（`nextTurnQueue` 本来就是宽的）
- `prompt` / `steer` / `followUp` / `nextTurn`：接受 `string | AgentMessage`
- `promoteFollowUpsToSteer`、`abort` 的返回类型、`queue_update` 的载荷跟着放宽

`agent-loop.ts` 那一侧早就是 `AgentMessage[]`（`packages/agent/src/types.ts:239/252`），所以这是纯类型放宽，对现有调用方零行为变化。**这是一处新的 fork 分叉，要记进 `docs/pi-fork.md`。**

### 消失的东西

| 消失的 | 因为 |
|---|---|
| `_deliverBackgroundResult` | background 直接持 `MessageSender` |
| `BackgroundJobDelivery` / `BackgroundJobDeliveryReceipt` / `deliverResult` 端口 | 同上；`entryId` 本来就没人产没人读 |
| `reconcileBranch` 的 `announce` 回调 | background 自己发；`toCarriedOverJobResultText` 从 orchestrator 挪进 `background/` |
| `steerAgent` / `followUpAgent` | 收编进 `_routeMessage`，`mode` 表达同一件事 |
| `_withExtensionInputPresentation` | presentation 变成 `MessageRequest` 的字段，走已有的 `onDeliveryStart` 配对 |
| 三处 `harness.appendMessage` 通告 | 变成 `mode:"precede"` |
| `_routeMessage` 里按 `source.kind` 分支算 policy 的代码 | policy 改成发 sink 时绑定 |
| `MessageSource` 的封闭联合类型 | kind 变成开放字符串 |

### 要承认的行为变化

1. **extension 的输入默认不再冒充人类。** 今天 `actions.promptAgent` 转手调 orchestrator 的 `promptAgent`，后者写死 `source:{kind:"human"}`，所以 extension 打的字在会话里、在 `_humanInterrupts` 协调里、在 TUI 里和用户完全一样。改造后它的默认 source 是 `{kind:"extension:<name>"}`。它仍然可以把 source 填回 `human`——那是 extension 作者的选择，也是本设计有意保留的能力——但 `humanInterrupt` 跟着 policy 走，填 source 改不了它。
2. **extension 的 steer / followUp 会被拦截。** 今天这两条完全绕过 input 管线，改造后会经过别的 extension 的 transform，也可能被 block。
3. **runtime 通告的 block 策略是 `ignore`。** 与 background t1 同理且更硬：`reconcileBranch` 的通告发完就写 job 记录，如果 extension 把它 block 掉，记录照写、模型永远不知道，那是静默丢失。block 降级成诊断。
4. **老会话不追溯。** 已经落成 `role:"user"` 的通告继续按用户消息渲染，不做迁移。

---

## 9. 不在本次范围

- **subagent 运行状态进上下文。** 机制上做完这一批就只是再发一个 sink，但它缺一条策略：哪些状态变化值得进父 agent 的上下文、要不要节流。子 agent 每次 idle/running 翻转都进上下文是 token 水龙头。等规则想清楚单开。
- **`_pendingExtensionInputPresentations` 的双记录并入。** 它确实是 orchestrator message 的一个特例（`details` 里放 presentation，`_observeSessionWrite` 能少一半），但它碰 extension 的公开面，范围比这一批大。等这一层有了真实用户，接口形状从两个实现里抽。
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
