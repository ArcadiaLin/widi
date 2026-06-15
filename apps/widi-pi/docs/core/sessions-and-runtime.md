# Sessions And Runtime

Sessions 保存单 agent 的对话历史。Runtime 提供 agent 执行时所需的 filesystem、shell、model、auth 与外部能力边界。

## 核心理念

Pi session tree 仍是单 agent 历史。

`widi-pi` 不重写 Pi session tree。每个 `AgentHarness` 仍然使用 Pi `Session` 表达消息、工具结果、model change、thinking level 和 branch。

Session 不保存 runtime object。

Session metadata 只保存恢复 harness 所需的小型引用，例如 profile reference。Profile 正文、API key、extension 实例、runtime object 和大型 resource snapshot 不进入 session metadata。

Human-request response 通常不进入 session。

只有当 human-request 作为 tool call 的结果发生时，它才自然作为 tool result 进入 session。其他 human interaction 属于 channel/runtime 层，不是 session 管理重点。

Runtime 能力由边界注入。

Shell、filesystem、sandbox、远程 runtime、MCP、auth 和 model provider 都应通过明确 runtime boundary 注入，优先围绕 `ExecutionEnv` 和 registry/adapter 设计。

## Persistence

持久 agent 使用 JSONL session。临时 agent 使用 in-memory session。未来 run/channel persistence 可以独立设计，但不能破坏 Pi session tree 的单 agent 语义。

Subagent 缺失 profile/resource/extension 时，应标记为 `unavailable`，不阻止整个 run restore。

## 非职责

- 不把 channel log 等同于 session。
- 不把 extension state 等同于 core persisted state。
- 不在 session 中保存 API key 或 runtime capability object。
