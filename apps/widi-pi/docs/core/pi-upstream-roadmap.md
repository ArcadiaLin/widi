# Pi Upstream Roadmap

本文档集中记录 WIDI 未来可能需要回到 Pi 上游实现或协商的能力。它不是当前 `apps/widi-pi` 的实现承诺，而是避免把上游缺口硬塞进 WIDI core 的提醒清单。

## Session Metadata Extension

WIDI 需要在恢复 multi-agent runtime 时保存小型 recovery references，例如 profile reference、preset reference、extension declaration reference 或 subagent relation id。

当前原则是：不把大型快照、runtime object、API key、extension instance 写入 session metadata。未来如果 Pi session metadata 支持 typed/custom extension section，WIDI 可以减少自己的外层 metadata 适配。

## ExecutionEnv Locking

部分 tool 或 extension workflow 需要文件系统/运行时的互斥语义，例如写文件、应用 patch、沙箱提交或跨 tool 的 artifact mutation。

WIDI 不应在每个 tool 中私造锁协议。更理想的是 Pi `ExecutionEnv` 或其相邻 runtime capability 提供统一 lock/transaction/lease 语义，让 tool、extension 和 harness-adjacent 操作共享同一并发边界。

## ExecutionEnv Interactive Shell Sessions

Pi `ExecutionEnv.exec(...)` 当前表达的是同步 shell execution：调用方等待 command 结束，再拿到 `stdout`、`stderr` 和 `exitCode`。这适合短命令和 Pi 风格 `bash` tool，但不足以表达 Codex 风格的 long-running shell session。

Codex 的 exec 语义是：初次调用可以在 `yield_time_ms` 到期时返回 partial output 和 session id，同时 runtime 保留仍在运行的进程；后续 tool call 可以通过 session id 写 stdin、空轮询输出或取消进程。这不是 provider 通用能力，而是 agent runtime 暴露给模型的 tool/resource 语义。

WIDI 不应长期在单个 `bash` tool 内私造这套 session/process manager。更理想的是 Pi `ExecutionEnv` 或相邻 shell capability 提供一等 interactive process/session API，例如 start、poll、write stdin 和 cancel。随后 WIDI 可以用薄 tool adapter 暴露 `exec_command` / `write_stdin` / `cancel_command`，并让 local shell、sandbox、SSH 或 extension backend 共享同一生命周期语义。

当前 WIDI `bash` 保留为阻塞式同步 tool。它可以通过 stdout/stderr streaming `onUpdate` 暴露已有输出，但不会在无新输出时定时返回 partial result，不会让 tool call 提前结束，也不会给模型提供可续跑 session id。

## Harness Queue Control

`AgentHarness` 当前能通过 `steer`、`followUp`、`nextTurn` 入队，并通过 `queue_update` 暴露队列状态。`abort()` 会清空 steer/followUp 并 abort 当前 run，但没有细粒度 queue item id，也没有单条取消或完整 queue control。

WIDI command layer 不应伪造第二套 queue。未来如果要支持 UI 取消单条 steer/followUp/nextTurn，Pi harness 需要先暴露稳定 queue item id，并提供类似 `clearQueuedInput`、`cancelQueuedInput(id)` 或按 queue 类型清理的 API。随后 WIDI 才能把这类能力作为 orchestrator command/client interaction 暴露。

## Notes

- 这些能力应优先在 Pi 层形成稳定语义，再由 WIDI orchestrator 包装。
- WIDI 可以先在 docs/tests 中标出缺口，但不应以私有状态模拟上游 queue 或 session metadata 行为。
- Extension dynamic workflow 应继续通过 orchestrator command/helper 编排；需要上游支持的仅是底层 harness/session/runtime 原语。

## TODO

Pi upstream 对齐任务集中维护在 [WIDI 下一阶段 TODO](../TODO.md)。本文件只记录哪些底层原语不应长期硬塞进 WIDI core。
