# Channels

Channel 是 core 通信语义，用来描述消息从哪里来、要去哪里、何时呈现给目标 agent 或 human-facing adapter。

本文不讨论 Channel 的具体数据结构。

## 核心理念

Channel 负责消息呈现时机，而不仅是消息传输。

对 agent 来说，消息并不是“来了就立刻塞进上下文”。不同来源和不同状态下的消息需要不同策略：立即呈现、排队、延后到下一轮、作为 steering 插入当前流程、只进入可观察日志，或者被拒绝。

Channel 负责来源可见性。

消息来源可能是 human、agent、extension、system policy 或外部 transport。目标 agent 需要在合适的抽象层感知来源，否则多 agent 协作会变成不可解释的上下文污染。

Channel 负责异步语义。

当 agent 正在 streaming、执行 tool、等待 human response 或处理其他 channel message 时，新消息需要明确的排序、中断、取消、超时和冲突策略。

## Human Request

`human-request` 是 Channel 的子集。它是目标为 human-facing adapter 的结构化请求，可能等待响应。

human-request 的响应通常不进入 session。只有当 human-request 是 tool call 的一部分时，响应才作为 tool result 自然进入 Pi session tree。除此之外，core 不应额外管理 session 写入。

## Mailbox

Mailbox 不是 core primitive。

如果需要 mailbox/team 语义，应由 extension 基于 Channel 实现。Core 只保证 channel routing、diagnostics、agent lifecycle 和必要的 persistence hook。

## 非职责

- 不定义最终消息数据结构。
- 不定义 mailbox 存储协议。
- 不替代 Pi session tree。
