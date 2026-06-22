# Sessions And Runtime

Sessions 保存单 agent 的对话历史。Runtime 提供 agent 执行时所需的 filesystem、shell、model、auth 与外部能力边界。

## 核心理念

Pi session tree 仍是单 agent 历史。

`widi-pi` 不重写 Pi session tree。每个 `AgentHarness` 仍然使用 Pi `Session` 表达消息、工具结果、model change、thinking level 和 branch。

Session body 不保存 WIDI agent state。

Session body 只保存 Pi `AgentHarness` 的运行产物。Agent status、command/client history、extension lifecycle、多 session 关系和产品交互模式状态不进入 session body。

Session fact 保存当前 session 的可恢复扩展事实。

Tool 与 extension 可以通过 session fact 保存小型、可 JSON 序列化、和当前 session branch 强相关的事实。Session fact 应复用 Pi 的 `custom` entry。Tool-owned fact 的 `namespace` 直接使用 tool name，并在落盘时映射为 Pi `customType`；extension/core-owned fact 使用自己的稳定 namespace。Fact data 包含 source、sourceName、factType、version 和 payload。Pi storage 原样保留这些 entries；WIDI 只有在注册了对应 `SessionFactDefinition.restore` 时，才会在 resume 时恢复 typed state。没有定义恢复方案时，默认行为是原始 fact 保留和读回。

这不改变“session body 不保存 WIDI agent state”的边界：agent lifecycle、多 session 编排、command/client history 和 extension 私有数据库仍不进入 session body。

Session metadata 保存 Recovery Reference。

Session metadata 可以保存恢复 harness 所需的小型、稳定、可 JSON 序列化的 recovery references，例如 profile reference。Profile 正文、API key、extension instance、runtime object、tool function 和大型 resource content 不进入 session metadata。

Human-request response 通常不进入 session。

只有当 human-request 作为 tool call 的结果发生时，它才自然作为 tool result 进入 session。其他 human interaction 属于 orchestrator runtime 层，不是 session 管理重点。

Runtime 能力由 Runtime Boundary 注入。

Shell、filesystem、sandbox、远程 runtime、MCP、auth、model provider 和 external transport 都应通过明确 runtime boundary 注入。`ExecutionEnv` 是重要 runtime boundary，但不是全部概念。

Model/Auth 也是 dependency。

Model provider/model id 与 auth credentials/headers 都属于 dependency resolution。缺失或不可用时应产生 diagnostics，而不是只在 harness callback 中抛普通异常。

## Persistence

持久 agent 使用 JSONL session。临时 agent 使用 in-memory session。多 session 的组合、恢复和存储属于 extension 或 preset 的编排边界，但不能破坏 Pi session tree 的单 agent 语义。

Subagent 缺失 profile/resource/extension 时，应标记为 `unavailable`，让上层 extension 或 preset 能继续恢复其他可用 agents。

Extension-owned storage 不等于 core persisted state。

Extension 或 preset 可以用自己的 storage 管理多个 sessions 和产品交互模式状态。Core 可以提供路径、权限、diagnostics、lifecycle hook 或 recovery references，但不解释这些 storage 的内部语义。

## 非职责

- 不把 command/client log 等同于 session。
- 不把 extension state 等同于 core persisted state。
- 不在 session 中保存 API key 或 runtime capability object。
- 不引入通用多 session storage。
- 不把 session fact 用作大型 artifact 或 extension 私有数据库。

## TODO

- [x] 用 WIDI JSONL adapter 扩展 session header metadata，并写入 profile recovery reference。
- [x] 在 `SessionManager` 中区分 persistent JSONL session 与 ephemeral in-memory session。
- [x] 明确 non-tool human interaction 不进入 session；tool 可自行把 human response 编码进 tool result。
- [ ] 扩展 session metadata 中允许的 recovery references，覆盖 preset、extension/resource reference。
- [ ] 定义 session metadata schema migration 的边界，不把大型 snapshot 放入 metadata。
- [ ] 实现基于 Pi `custom` entry 的 session fact persistence、fact definition 和恢复诊断。
- [ ] 将 model/auth dependency diagnostics 接入 resume 和 harness build。
- [ ] 定义 extension-owned storage 的授权路径和与 session metadata 的引用关系。
- [ ] 为 human-request tool result 与非 tool interaction 的 session 行为增加测试或示例。
