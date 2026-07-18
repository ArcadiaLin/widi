# Pi Upstream Roadmap

本文集中记录 WIDI 需要由 Pi 上游提供或统一的底层原语。它不是当前 WIDI milestone，也不收录应用侧重构。

## ExecutionEnv lock / transaction / lease

Session、auth、settings、tool 与 extension workflow 最终可能需要跨进程互斥。WIDI 当前只声明单进程写入支持，不在每个 backend 中分别实现不兼容的文件锁。

理想形态是 Pi `ExecutionEnv` 或相邻 runtime capability 提供统一 lock/transaction/lease，使本地、sandbox 和远程 backend 能表达同一并发语义。

## Interactive shell session

长时间运行或交互式 shell 需要独立于一次性 `exec()` 的原语：

- start 与 session identity。
- poll/output cursor 与 truncation。
- write stdin。
- cancel/terminate。
- yield timeout。
- descendant/pipe cleanup。

WIDI 不应在多个 coding/collaboration tools 中分别模拟 shell session lifecycle。出现真实交互 consumer 时，优先推动 Pi runtime 形成共享契约。

## Harness queue control

`AgentHarness` 支持 steer、followUp、nextTurn 与 queue updates，但没有稳定 queue item id 或单项 cancellation。

WIDI 不建立第二套 queue。若 client 需要取消特定 queued input，Pi 应先提供 item identity 和按 id/type 清理能力，再由 orchestrator 暴露受控入口。

## Compaction settings passthrough

`AgentHarness.compact()` 只接受 `customInstructions`，切点计算内部硬编码 `DEFAULT_COMPACTION_SETTINGS`。WIDI 的 auto-compaction 触发侧消费 `enabled` 与 `reserveTokens`，但 `keepRecentTokens` 无法到达上游 cut-point 计算：用户修改该配置不影响 compaction 后的实际保留量（当前两侧默认值一致，行为上不可见）。

理想形态是 `compact()` 接受 `CompactionSettings` 参数或 harness 级配置，由 WIDI 透传。WIDI 不通过 `session_before_compact` hook 重新实现切点逻辑来绕过该缺口。

## Provider registration scope

已关闭。上游重构（`9993c969`，2026-07）移除了 process-global OAuth registry（`registerOAuthProvider`/`resetOAuthProviders`）：auth 作为 `Provider.auth` 挂在 provider 上，由每个 pi-ai `Models` 实例持有，instance ownership 已经明确。WIDI 不再依赖全局 reset 协调独立 runtime，本条目不再是开放缺口。

## Version fact source

WIDI package 可以声明 npm Pi 版本，同时通过 workspace/submodule 实际解析本地源码。两条轨道长期并存会让 compatibility、diagnostic 和 release audit 缺少单一事实来源。

应在 upstream tracking/release 流程中明确版本锚点：本地 workspace revision、published package version 以及二者的一致性检查。

## 原则

- 先在 Pi 层形成底层语义，再由 WIDI orchestrator/registry 包装。
- WIDI 可以写 characterization tests 暴露缺口，不用私有状态伪装上游能力。
- 只有真实 consumer 出现时才推进新原语。
- 短期内 Pi 的 agent harness 模块可能不接受社区 PR。在上游语义落地前，WIDI 使用自己的补丁或功能相对不完善的版本开发；由此产生的已知残缺（例如无法透传的配置）是可允许的代价，按本文条目记录，不掩盖也不绕过。
