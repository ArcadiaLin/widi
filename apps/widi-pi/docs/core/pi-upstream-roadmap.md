# Pi Upstream Roadmap

本文档集中记录 WIDI 未来可能需要回到 Pi 上游实现或协商的能力。它不是当前 `apps/widi-pi` 的实现承诺，而是避免把上游缺口硬塞进 WIDI core 的提醒清单。

## Session Metadata Extension

WIDI 需要在恢复 multi-agent runtime 时保存小型 recovery references，例如 profile reference、preset reference、extension declaration reference 或 subagent relation id。

当前原则是：不把大型快照、runtime object、API key、extension instance 写入 session metadata。未来如果 Pi session metadata 支持 typed/custom extension section，WIDI 可以减少自己的外层 metadata 适配。

## ExecutionEnv Locking

部分 tool 或 extension workflow 需要文件系统/运行时的互斥语义，例如写文件、应用 patch、沙箱提交或跨 tool 的 artifact mutation。

WIDI 不应在每个 tool 中私造锁协议。更理想的是 Pi `ExecutionEnv` 或其相邻 runtime capability 提供统一 lock/transaction/lease 语义，让 tool、extension 和 harness-adjacent 操作共享同一并发边界。

M2 的当前裁决是先显式声明 WIDI storage 的单进程写入假设，不在 WIDI 的 session/auth/config storage 中私自实现一套本地文件锁。限制来自 Pi `ExecutionEnv` 当前没有统一的 lock/transaction/lease primitive：WIDI 可以通过 `ExecutionEnv` 做 file I/O 和 shell execution，但不能对不同 backend 表达同一套跨进程互斥语义。

如果 pi-agent-core 的 harness/runtime 层长期不补这类文件锁或 transaction 能力，而 WIDI 后续需要支持多个进程安全地共享同一个 `agentDir` 或 `sessionsRoot`，WIDI 迟早需要 fork 相关 harness/runtime 模块并补上这个 capability。这个动作不属于 M2；应等 storage、tool、extension 和 adapter 边界稳定后再评估。

## Harness Queue Control

`AgentHarness` 当前能通过 `steer`、`followUp`、`nextTurn` 入队，并通过 `queue_update` 暴露队列状态。`abort()` 会清空 steer/followUp 并 abort 当前 run，但没有细粒度 queue item id，也没有单条取消或完整 queue control。

WIDI command layer 不应伪造第二套 queue。未来如果要支持 UI 取消单条 steer/followUp/nextTurn，Pi harness 需要先暴露稳定 queue item id，并提供类似 `clearQueuedInput`、`cancelQueuedInput(id)` 或按 queue 类型清理的 API。随后 WIDI 才能把这类能力作为 orchestrator command/client interaction 暴露。

## Notes

- 这些能力应优先在 Pi 层形成稳定语义，再由 WIDI orchestrator 包装。
- WIDI 可以先在 docs/tests 中标出缺口，但不应以私有状态模拟上游 queue 或 session metadata 行为。
- Extension dynamic workflow 应继续通过 orchestrator command/helper 编排；需要上游支持的仅是底层 harness/session/runtime 原语。

## TODO

Pi upstream 对齐任务集中维护在 [Milestones](../TODO.md) 与 [Backlog](../BACKLOG.md)。本文件只记录哪些底层原语不应长期硬塞进 WIDI core。
