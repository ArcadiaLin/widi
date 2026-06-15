# Extensions

Extension 是 `widi-pi` 的高自由度扩展机制。它应能像 Pi coding-agent extension 一样深度参与 runtime，但不能绕过 core 的可观察边界。

## 核心理念

Extension declaration 不是 extension instance。

Profile、preset 或 config 中声明的 extension 是可恢复、可解析的 dependency declaration。运行时激活后的 extension instance 属于 runtime state，不能写入 session metadata。

Extension 通过 hook 插入 core 能力。

Orchestrator 执行每个关键能力时，都应有 extension 观察、拦截、补充或改写的机会。包括 agent lifecycle、profile/resource/tool 解析、channel routing、model/runtime 请求、diagnostics 和 adapter interaction。

Extension hook permission 必须可描述。

每个 hook 点应明确 extension 能 observe、intercept、mutate，还是 invoke controlled core capabilities。Extension 的自由度来自这些权限，而不是绕过 core state ownership。

Extension 可以组合 core 能力。

`/team`、`/flow`、`/goal`、MCP、sandbox、remote worker 等都应作为 extension 或 preset 组合出现，而不是进入 core primitive。

Extension missing policy 只处理缺失声明。

声明引用解析不到时，按 declaration 的 missing policy 决定 ignore、warning 或 error。找到 extension 但 activation failed 是另一类 diagnostic，不应和 missing policy 混在一起。

Extension 不能直接拥有已存储 core state。

已经存储好的 profile、session、resource registry、agent registry 不能由 extension 私下接管。Extension 可以通过受控 API 请求变更、贡献资源、注册能力或响应 hook，但 core state 的所有权仍属于 core registry/orchestrator。

Extension 可以拥有自己的 storage。

Extension-owned storage 用于 extension/preset 的产品交互模式和多 session 组合。Core 可以提供路径、权限、diagnostics、lifecycle hook 或 capability API，但不解释其中的数据模型。

## Pi Extension 参考

Pi coding-agent extension 已经支持注册 tool/command/provider、拦截 input/tool/system prompt/provider request、发起 UI 交互、注入消息、写扩展状态、定制渲染和触发 session 操作。

WIDI extension 应至少保留这种自由度，并扩展到 multi-agent runtime。但跨 agent 操作必须经过 orchestrator/channel/diagnostics。

## 非职责

- 不私有维护 agent lifecycle。
- 不私有维护 A2A 通信。
- 不直接修改持久 profile/session 文件。
- 不把 extension runtime state 当作可恢复 core state。
- 不把 extension-owned storage 升格为 core persisted state。

## TODO

- [ ] 定义 extension declaration 的 identity、source、version/compatibility 和 missing policy。
- [ ] 设计 extension registry/loader/activation lifecycle。
- [ ] 为 hook 点列出 permission：observe、intercept、mutate、invoke capability。
- [ ] 定义 extension-contributed tools/resources/channels/diagnostics 如何进入对应 registry。
- [ ] 定义 extension-owned storage 的边界、路径授权和 diagnostics。
- [ ] 区分 missing extension、activation failed、runtime diagnostic 三类问题。
