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

Session facts 是共享恢复通道。

Extension-owned storage 之外，core 还应提供 session fact API。Tool 和 extension 都可以访问这层 API，用于把和当前 session tree 强相关的小型事实写入 Pi `custom` entry。Tool-owned fact 的 `namespace` 直接使用 tool name，并在落盘时映射为 Pi `customType`；extension/core-owned fact 使用自己的稳定 namespace。Pi storage 只负责保留原始 entry；如果没有注册 fact definition，WIDI 不会自动恢复 typed runtime state，只会把原始 fact 暴露给调用方。已注册的 fact definition 可以按 namespace、source、factType 和 version 恢复 typed state。

这层能力用于“当前 session 可恢复事实”，不是 extension 私有数据库。大型 artifact、多 session index、产品模式状态仍属于 extension-owned storage。

Extension 可以修改既有 tools。

WIDI extension 不只注册新 tool，也可以对 core/built-in tool 注册 patch contribution。Patch 必须进入 tool registry 的 resolved pipeline，而不是直接改写某个 runtime object。允许的修改包括：

- 改写 prompt metadata 或 availability。
- 包装 execute，例如审计、确认、沙箱转发、远程执行。
- 替换 execute，例如让 `write` 写到不同 backend。
- 补充或替换 tool state reducer，让 UI-facing state 反映 extension 注入的行为。
- 声明额外 session fact definition，用于恢复 extension 写入的 tool state。

这种设计让 active tool name 保持稳定。例如 extension 可以修改 `write` 的执行行为，但最终 resolved tool 仍叫 `write`，session 中的 active tools 和历史 tool call 仍可解释。

当前 `ToolRegistry` 已支持 `define` 与 `patch` contribution，但 extension lifecycle 仍未落地。后续 extension loader/runner 的职责是把 extension declaration 解析为 contribution 集合，再交给 registry resolve；registry 不直接加载 extension、不执行 activation hook，也不决定 missing extension policy。

需要继续设计的细节：

- extension patch 是否需要 permission，例如能否替换 execute、能否只允许 `aroundExecute`。
- 多个 extension patch 同一字段时，priority 的来源是 extension declaration、profile policy，还是 extension 自身声明。
- `aroundExecute` 内部需要的 extension context 是否按 patch source 绑定；当前 registry adapter 只提供 resolved tool 级 context。
- patch 失败、restore 失败、permission denied 应如何进入统一 diagnostic。

Extension 可以自定义 tool tracking。

Tool tracker 是 core 的 runtime-only 可观察状态，所有 resolved tools 默认以 minimal 模式被记录。Extension 不需要直接依赖 tracker API；如果只想改变记录内容，应通过 tool patch 修改 `tracking` policy，例如关闭某个 tool 的 tracking，或从 params/update/result/error 中抽取 metadata。只有需要改变实际执行行为时，才使用 `aroundExecute` 或替换 execute。

这让 extension 开发保持轻量：普通 extension 只贡献 tool 或 patch；需要可观察性时 patch `tracking`；需要执行控制时 patch execute pipeline。

## Pi Extension 参考

Pi coding-agent extension 已经支持注册 tool/command/provider、拦截 input/tool/system prompt/provider request、发起 UI 交互、注入消息、写扩展状态、定制渲染和触发 session 操作。

WIDI extension 应至少保留这种自由度，并扩展到 multi-agent runtime。但跨 agent 操作必须经过 orchestrator/channel/diagnostics。

## 非职责

- 不私有维护 agent lifecycle。
- 不私有维护 A2A 通信。
- 不直接修改持久 profile/session 文件。
- 不把 extension runtime state 当作可恢复 core state。
- 不把 extension-owned storage 升格为 core persisted state。
- 不绕过 tool registry 直接替换 built-in tool runtime object。
- 不把 session fact 用作大型 extension 数据库。

## TODO

- [ ] 定义 extension declaration 的 identity、source、version/compatibility 和 missing policy。
- [ ] 设计 extension registry/loader/activation lifecycle。
- [ ] 为 hook 点列出 permission：observe、intercept、mutate、invoke capability。
- [ ] 定义 extension-contributed tools/resources/channels/diagnostics 如何进入对应 registry。
- [ ] 定义 extension tool patch contribution 的权限、priority 来源和 runtime context 绑定。
- [ ] 定义基于 Pi `custom` entry 的 session fact API、fact definition 注册和恢复错误 diagnostics。
- [ ] 定义 extension-owned storage 的边界、路径授权和 diagnostics。
- [ ] 区分 missing extension、activation failed、runtime diagnostic 三类问题。
