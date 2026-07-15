# Sessions And Runtime

Session 保存单个 Pi `AgentHarness` 的历史；runtime boundary 提供 agent 执行所需的 filesystem、shell、model/auth 与外部能力。

## Session ownership

WIDI 不重写 Pi session tree，也不增加应用专属 session envelope。每个 harness 继续使用 Pi `Session` 与 `SessionTreeEntry` 表达：

- messages 与 tool calls/results。
- model、thinking level 和 active tools changes。
- compaction 与 branch summary。
- custom/custom message entries。
- label 与 leaf navigation。

Session body 保存 harness 运行产物，不保存 agent lifecycle、command/client log、pending human request、extension runner instance 或跨 session 产品关系。

## JSONL 与 metadata

Persistent session 使用 Pi `JsonlSessionRepo`：首行为 versioned session header，后续每行是一个 session tree entry。WIDI 使用 header 的 opaque `metadata` 保存小型 recovery reference，目前写入 profile reference：

```json
{
  "profile": {
    "id": "main",
    "label": "Main Agent"
  }
}
```

Profile id 用于 resume lookup；label 只用于展示或诊断快照。Metadata 不保存 API key、OAuth token、system prompt、resource body、runtime object、function 或 extension instance。

持久 session 的目录布局由 Pi repo 决定。WIDI 只承诺 `JsonlSessionMetadata.path` 可以重新打开文件，不承诺编码后的目录形状长期稳定。

## SessionManager

`SessionManager` 协调 orchestrator 与 Pi session repo：

- Persistent agent 使用 `JsonlSessionRepo`。
- Ephemeral agent 使用 `InMemorySessionRepo`。
- 已打开 session 按 `agentId` 缓存。
- Create 写入 profile metadata。
- Resume 按 `JsonlSessionMetadata` open。
- Fork 复制目标 leaf 的 path-to-root，并继承 header metadata。

Resume 时 storage 不解释 profile metadata。Orchestrator 收窄 profile reference，调用 registry 解析当前 profile，再从 `session.buildContext()` 恢复 messages、model、thinking level 和 active tools。

## Tool result persistence

Built-in tool 不使用额外 session state facade。可恢复上下文进入 Pi 已有记录：

- 输入正文和参数进入 tool call arguments。
- 模型需要看到的结果进入 result `content`。
- 路径、截断、diff、计数等机器事实进入 typed `details`。

ToolRegistry 不解释或写入 custom entry。

## Extension custom entry

`context.session.appendEntry()` / `findEntries()` 是 core 提供的 extension session-local storage 通道，也是 API v1 契约的一部分。

- Namespace：local type 落库为 `extension:<extensionId>:<localType>`，extension 只能读取自己的 namespace。
- 写入：append-only，不提供 update/delete。
- 读取：current branch path，按 root-to-leaf 顺序返回。
- Fork：custom entry 是 branch fact；fork 点 path-to-root 上的条目随新 session 复制，分叉后的条目留在源分支。
- Compaction：零影响。Custom entry 不进入 model context，compaction 不删除它。
- Missing/incompatible extension：条目原样保留并可经 session tree inspect，只有对应 consumer 不再运行。
- Export：core 不定义 renderer/export API；client 可以从 session tree facts 派生呈现。

Custom entry 适合与当前 session 强相关的小型状态，不是 extension 私有数据库。大型 artifact、多 session index 和产品模式状态由 extension 在受信边界内管理自己的文件。

WIDI 不收编 extension `custom_message` 通道。Extension 可以根据需求使用 prompt/followUp、custom entry 或 context interceptor；需要“持久 + 进入 context + extension 归因”的独立通道时，必须由真实 consumer 重新举证。

Core 还使用 `core:command_expansion` 与 `core:input_transform` custom entries 保存人类原文和模型可见文本之间的差异；它们不是 extension namespace。

## Human request

Pending human request、timeout、abort 与 cancellation 属于 runtime-local state，不进入 session。只有 request 发生在 tool execution 内并成为 tool result 时，其 response 才自然进入 session history。

## Runtime boundary 与 settings

`ExecutionEnv` 表达 filesystem 与 shell 能力，可由本地、sandbox 或远程 backend 实现。它不是 tool 本身，也不包含所有 runtime policy。

`SettingManager` 负责 global/project settings、project trust、runtime override 和 flush。Orchestrator、model/auth、resource loader 与 extension runtime 应消费同一个 settings service，不各自读取配置文件。

## Persistence 支持边界

当前 WIDI persistence 明确支持单进程写入。Session JSONL、auth 与 settings 可以在一个进程内串行化；多个 WIDI 进程并发写同一个 agent dir、project config 或 sessions root 的结果未定义。

Core 不在各 storage backend 中分别发明文件锁协议。统一 lock/transaction/lease 能力应优先进入 Pi runtime boundary，见 [Pi Upstream Roadmap](pi-upstream-roadmap.md)。

## 非职责

- 不把 command/client log 当作 session。
- 不把 pending human request 当作可恢复 state。
- 不把 extension database 当作 core persisted state。
- 不在 metadata 中保存 secret 或大型 snapshot。
- 不引入通用多 session storage。
