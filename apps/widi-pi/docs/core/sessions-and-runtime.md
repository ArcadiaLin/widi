# Sessions And Runtime

Sessions 保存单 agent 的对话历史。Runtime 提供 agent 执行时所需的 filesystem、shell、model、auth 与外部能力边界。

## 核心理念

Pi session tree 仍是单 agent 历史。

`widi-pi` 不重写 Pi session tree。每个 `AgentHarness` 仍然使用 Pi `Session` 表达消息、工具结果、model change、thinking level 和 branch。

Session body 不保存 WIDI agent state。

Session body 只保存 Pi `AgentHarness` 的运行产物。Agent status、command/client history、extension lifecycle、多 session 关系和产品交互模式状态不进入 session body。

Tool result 保存 WIDI-owned tool 的可恢复上下文。

WIDI-owned tools 不引入额外的 session persistence facade。可恢复数据应进入 Pi 已有 session entries：tool call arguments、tool result `content` 和 typed `details`。例如 `write` 的正文来自 tool call arguments，结果只需要短文本和路径 details；`read` 的文件内容进入 result content；`edit` 的 patch/diff 信息进入 details。

这不改变“session body 不保存 WIDI agent state”的边界：agent lifecycle、多 session 编排、command/client history 和 extension 私有数据库仍不进入 session body。Tool result 是 Pi harness 运行产物，不是 WIDI runtime state。

Historical `write`、`read` 和 `bash` examples 已从仓库删除（`read`/`write`/`edit` 现为 `src/core/tools/coding/` 下的真实 core 实现）。Coding tools 的可恢复数据仍应通过 Pi tool call/result 表达：正文或输出进入 tool call/result，结构化信息进入 typed `details`，不通过 core tool state 或 custom entry 写入额外恢复数据。

Pi `custom` entry 仍由 storage 原样保留，但 WIDI core 不解释它。当前 extension runner 已暴露 `ctx.session.appendEntry()` / `findEntries()` MVP，用于和当前 session tree 强相关的小型扩展状态。MVP 只支持当前 extension namespace、current branch path、append-only state；fork、compaction、export、`custom_message` 和 restore diagnostics policy 后续再定。

`SessionManager` 仍决定当前 agent 使用 persistent JSONL session 还是 ephemeral in-memory session。普通 tool result、assistant message、active tools change、model change 和 thinking level change 都由 Pi `AgentHarness` 自己写入 session。

Session metadata 保存 Recovery Reference。

Session metadata 可以保存恢复 harness 所需的小型、稳定、可 JSON 序列化的 recovery references，例如 profile reference。Profile 正文、API key、extension instance、runtime object、tool function 和大型 resource content 不进入 session metadata。

Human-request response 通常不进入 session。

只有当 human-request 作为 tool call 的结果发生时，它才自然作为 tool result 进入 session。其他 human interaction 属于 orchestrator runtime 层，不是 session 管理重点。

Runtime 能力由 Runtime Boundary 注入。

Shell、filesystem、sandbox、远程 runtime、MCP、auth、model provider 和 external transport 都应通过明确 runtime boundary 注入。`ExecutionEnv` 是重要 runtime boundary，但不是全部概念。

Model/Auth 也是 dependency。

Model provider/model id 与 auth credentials/headers 都属于 dependency resolution。缺失或不可用时应产生 diagnostics，而不是只在 harness callback 中抛普通异常。

Settings 是 runtime policy 输入。

`SettingManager` 负责 global/project settings 的加载、合并、project trust gate、runtime override 和 flush 边界。它参考 Pi coding-agent settings manager 的语义，但在 WIDI 中通过 `ExecutionEnv` 进行文件 I/O。Orchestrator、model/auth、resource loader、extension runner 和 TUI 都应消费同一个 settings runtime，而不是各自读取配置文件。

当前 multi-agent 相关 settings 只放入明确的 profile 入口：`defaultProfile` 表达未显式指定 profile 时的默认 profile id/name，`profiles` 表达额外 profile 文件或目录来源。Subagent 创建策略、workflow concurrency、agent recovery policy 等仍属于 profile、orchestrator 或 extension policy，不提前固化为 settings 字段。

## Persistence

持久 agent 使用 JSONL session。临时 agent 使用 in-memory session。多 session 的组合、恢复和存储属于 extension 或 preset 的编排边界，但不能破坏 Pi session tree 的单 agent 语义。

当前 WIDI persistence 只声明单进程写入支持。Session JSONL、auth storage 与 settings/config storage 可以在同一个 WIDI 进程内串行化写入，但多个 WIDI 进程同时写同一个 `agentDir`、project config 或 `sessionsRoot` 暂时处于支持边界外，结果未定义。

这个限制不是产品目标，而是当前 runtime capability 的事实边界：Pi `ExecutionEnv` 尚未提供统一的 lock/transaction/lease primitive，WIDI 不在各 storage backend 中私造互不兼容的本地文件锁协议。多进程写入安全未来可能支持，但应等整体项目边界稳定后，通过 Pi upstream 能力或必要的 harness/runtime fork 统一实现。

Subagent 缺失 profile/resource/extension 时，应标记为 `unavailable`，让上层 extension 或 preset 能继续恢复其他可用 agents。

Extension-owned storage 不等于 core persisted state。

Extension 或 preset 可以用自己的 storage 管理多个 sessions 和产品交互模式状态。Core 可以提供路径、权限、diagnostics、lifecycle hook 或 recovery references，但不解释这些 storage 的内部语义。

## 非职责

- 不把 command/client log 等同于 session。
- 不把 extension state 等同于 core persisted state。
- 不在 session 中保存 API key 或 runtime capability object。
- 不引入通用多 session storage。
- 不把 Pi `custom` entry 当作大型 artifact 或 extension 私有数据库。
- 不为 WIDI-owned tool 引入替代 Pi tool result 或 message history 的写入通道。

## TODO

Session/runtime 后续任务按 milestone 维护在 [Milestones](../TODO.md) 与 [Backlog](../BACKLOG.md)。模块执行顺序见 [Runtime Lifecycle](./runtime-lifecycle.md)。本文件只保留 Pi session tree、metadata、runtime boundary 和 persistence 边界。
