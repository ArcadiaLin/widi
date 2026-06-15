# Extensions

Extension 是 `widi-pi` 的高自由度扩展机制。它应能像 Pi coding-agent extension 一样深度参与 runtime，但不能绕过 core 的可观察边界。

## 核心理念

Extension 通过 hook 插入 core 能力。

Orchestrator 执行每个关键能力时，都应有 extension 观察、拦截、补充或改写的机会。包括 agent lifecycle、profile/resource/tool 解析、channel routing、model/runtime 请求、diagnostics 和 adapter interaction。

Extension 可以组合 core 能力。

`/team`、`/flow`、`/goal`、MCP、sandbox、remote worker、mailbox team mode 等都应作为 extension 或 preset 组合出现，而不是进入 core primitive。

Extension 不能直接拥有已存储 core state。

已经存储好的 profile、session、resource registry、agent registry 不能由 extension 私下接管。Extension 可以通过受控 API 请求变更、贡献资源、注册能力或响应 hook，但 core state 的所有权仍属于 core registry/orchestrator。

## Pi Extension 参考

Pi coding-agent extension 已经支持注册 tool/command/provider、拦截 input/tool/system prompt/provider request、发起 UI 交互、注入消息、写扩展状态、定制渲染和触发 session 操作。

WIDI extension 应至少保留这种自由度，并扩展到 multi-agent runtime。但跨 agent 操作必须经过 orchestrator/channel/diagnostics。

## 非职责

- 不私有维护 agent lifecycle。
- 不私有维护 A2A 通信。
- 不直接修改持久 profile/session 文件。
- 不把 extension runtime state 当作可恢复 core state。
