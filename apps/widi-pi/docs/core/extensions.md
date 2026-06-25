# Extensions

Extension 是 `widi-pi` 的高自由度扩展机制。它应能像 Pi coding-agent extension 一样深度参与 runtime，但不能绕过 core 的可观察边界。

## 核心理念

Extension declaration 不是 extension instance。

Profile、preset 或 config 中声明的 extension 是可恢复、可解析的 dependency declaration。运行时激活后的 extension instance 属于 runtime state，不能写入 session metadata。

Extension 通过 hook 插入 core 能力。

Orchestrator 执行每个关键能力时，都应有 extension 观察、拦截、补充或改写的机会。包括 agent lifecycle、profile/resource/tool 解析、command dispatch、client interaction、model/runtime 请求、diagnostics 和 adapter interaction。

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

Custom entry 是 extension-owned 恢复通道。

Extension-owned storage 之外，future extension API 可以暴露 Pi `custom` entry，用于写入和当前 session tree 强相关的小型 extension state。Core 不提供共享 state layer，也不解释 `custom` entry 的 data shape。写入格式、恢复顺序、branch/fork/compaction/export/debug policy 都应由 extension API 明确定义。

这层能力用于“当前 session 可恢复 extension 状态”，不是 extension 私有数据库。大型 artifact、多 session index、产品模式状态仍属于 extension-owned storage。Core built-in tools 的可恢复数据走 Pi tool call arguments、tool result `content` 和 typed `details`。

Extension 可以修改既有 tools。

WIDI extension 不只注册新 tool，也可以对 core/built-in tool 注册 patch contribution。Patch 必须进入 tool registry 的 resolved pipeline，而不是直接改写某个 runtime object。允许的修改包括：

- 改写 prompt metadata 或 availability。
- 包装 execute，例如审计、确认、沙箱转发、远程执行。
- 替换 execute，例如让 `write` 写到不同 backend。
- 补充或替换 tool state reducer，让 UI-facing state 反映 extension 注入的行为。

这种设计让 active tool name 保持稳定。例如 extension 可以修改 `write` 的执行行为，但最终 resolved tool 仍叫 `write`，session 中的 active tools 和历史 tool call 仍可解释。

当前 `ToolRegistry` 已支持 `define` 与 `patch` contribution，但 extension lifecycle 仍未落地。后续 extension loader/runner 的职责是把 extension declaration 解析为 contribution 集合，再交给 registry resolve；registry 不直接加载 extension、不执行 activation hook，也不决定 missing extension policy。

需要继续设计的细节：

- extension patch 是否需要 permission，例如能否替换 execute、能否只允许 `aroundExecute`。
- 多个 extension patch 同一字段时，priority 的来源是 extension declaration、profile policy，还是 extension 自身声明。
- `aroundExecute` 内部需要的 extension context 是否按 patch source 绑定；当前 registry adapter 只提供 resolved tool 级 context。
- patch 失败、restore 失败、permission denied 应如何进入统一 diagnostic。

Extension 可以实现 tool tracking。

Tool tracking 不进入 core primitive。它应作为 extension pattern：通过 `aroundExecute` 包装目标 tool，在 execute 前 start，在 `context.onUpdate` 中 update，在成功或抛错时 finish/fail。

`apps/widi-pi/examples/tool-tracker-extension.ts` 保留了一个未接入 runtime 的示例骨架，用于展示这种模式。Extension 开发需要注意这个语义：观察、审计、耗时统计和轻量 run tracking 适合 `aroundExecute`；真正改变 tool 行为时才替换 `execute`。

## Extension Runner 前置工作

以下 TODO 比普通远期规划更特殊：它们是正式开发 extension runner 之前应先压实的 core 边界。否则 extension runner 会过早承担 session、tool、diagnostics 或 command 的未定语义。

### SessionManager 与 Custom Entries

Session 语义应先收口到 `SessionManager` 附近，而不是散在 tool runtime 中。WIDI core 保留 Pi session tree 行为：message、tool result、active tools、model/thinking change 和 `custom` entry 都由 session storage 原样保存。

开发 extension runner 前应先明确：

- extension-owned custom entry API 是否由 `SessionManager` 暴露，还是由 extension runner 封装。
- custom entry 读取 scope：整棵 session tree、当前 branch path、还是由 query 显式选择。
- fork、branch move、compaction、export 和 debug view 如何处理 extension custom entries。
- extension 缺失、版本不兼容或恢复失败时，custom entry 是否只保留原始数据并产生 diagnostics。
- payload 的 JSON serializable、大小限制、schema validation 和敏感信息 policy。

### Built-in Tool Definition

Extension patch 机制需要一个真实的 WIDI-owned built-in tool 来验证。否则 extension runner 只能接入抽象 registry，无法证明 `define`/`patch`、tool context、human request 和 diagnostics 的完整链路。

开发 extension runner 前建议至少落地一个低风险 built-in tool definition：

- 由 core 注册为 `ToolDefinition` contribution。
- 通过 ToolRegistry resolve 后 wrap 成 Pi `AgentTool`。
- 使用 `context.human` 或 execution env 中至少一个 runtime capability。
- 产生 Pi 风格 tool result `content` 和 typed `details`，并有可测试的 tool state。

`read`、`write`、`edit`、`bash` 这类核心 built-in tools 应优先完整参考 Pi coding-agent 的参数、结果内容、details 和上下文恢复方式，再决定 WIDI 是否需要额外 policy 包装。`write` 更能验证真实边界，但风险更高；可以先用低风险工具压实 contribution/context/test，再进入文件写入类工具。

### Core Diagnostics 接通

暂不设计更复杂的 diagnostics runtime 汇总。当前要求只是各 WIDI-owned module 产出统一 `CoreDiagnostic`，并能通过 orchestrator `diagnostic` event 发布。

Extension runner 开发前需要确认：

- profile、resource、tool、settings、auth、model、session manager 都已经能产出或转接 `CoreDiagnostic`。
- extension missing、activation failed、permission denied、hook failed、patch rejected、custom entry restore failed 的 code/source/disposition 预留清楚。
- runtime 汇总策略等 extension runner 设计出来后再定，不提前抽象。

### Orchestrator Commands 与 Debug View

Extension runner 会增加更多不可见的 runtime composition。开发前应考虑最小 debug/inspection command，帮助 UI/RPC/CLI 观察当前 agent 的 resolved state。

候选信息包括：

- resolved profile reference。
- loaded resources 和 resource diagnostics。
- resolved tools、active tool names 和 tool diagnostics。
- session metadata、Pi session entries 和 extension custom entries 摘要。
- 后续 extension declarations、activation state 和 extension diagnostics。

这不是 extension runner 的硬依赖，但越晚补，调试 extension activation 和 patch 合成越困难。

### 暂缓项

以下内容不作为 extension runner 前置阻塞：

- `profile.capabilities` 到 `canSpawn`、`canRequestUser`、`acceptsUserInput` 等 core agent policy 的映射。它们属于 orchestrator 管理 AgentHarness/user/agent 协作的能力，不是 extension 机制本身。
- extension settings schema。extension lifecycle 和 storage 边界稳定后再固化 settings 字段。
- diagnostics runtime 的复杂汇总和 UI policy。runner 出来后再根据实际事件流设计。

## Pi Extension 参考

Pi coding-agent extension 已经支持注册 tool/command/provider、拦截 input/tool/system prompt/provider request、发起 UI 交互、注入消息、写扩展状态、定制渲染和触发 session 操作。

WIDI extension 应至少保留这种自由度，并扩展到 multi-agent runtime。但跨 agent 操作必须经过 orchestrator command/helper 和 diagnostics。

## 非职责

- 不私有维护 agent lifecycle。
- 不私有维护 A2A 通信。
- 不直接修改持久 profile/session 文件。
- 不把 extension runtime state 当作可恢复 core state。
- 不把 extension-owned storage 升格为 core persisted state。
- 不绕过 tool registry 直接替换 built-in tool runtime object。
- 不把 Pi `custom` entry 用作大型 extension 数据库。

## TODO

### Extension Runner 前置 TODO

- [ ] 定义 extension-owned custom entry API：append/read 权限、branch scope、fork、compaction、export、debug view 和 diagnostics policy。
- [ ] 定义 extension custom entry payload 的 JSON serializable、大小、schema validation 和敏感信息 policy。
- [ ] 落地至少一个 WIDI-owned built-in `ToolDefinition`，用于验证 registry、tool context、human request、tool result details 和 diagnostics 链路。
- [ ] 设计最小 debug/inspection command，展示 resolved profile/resources/tools/session metadata/custom entries，后续扩展到 extension state。
- [ ] 确认 profile、resource、tool、settings、auth、model、session manager diagnostics 都已接入 `CoreDiagnostic` 和 orchestrator event。

### Extension Runner TODO

- [x] 将 tool tracking 明确为 extension pattern，并保留未接入 runtime 的示例骨架。
- [x] 让 tool registry 支持 extension-style `define`/`patch` contribution。
- [ ] 定义 extension declaration 的 identity、source、version/compatibility 和 missing policy。
- [ ] 设计 extension registry/loader/activation lifecycle。
- [ ] 为 hook 点列出 permission：observe、intercept、mutate、invoke capability。
- [ ] 定义 extension-contributed resources/commands/diagnostics 如何进入对应 registry。
- [ ] 定义 extension tool patch contribution 的权限、priority 来源和 runtime context 绑定。
- [ ] 实现 extension 使用 custom entry API 的写入、读取、恢复和错误 diagnostics。
- [ ] 定义 extension-owned storage 的边界、路径授权和 diagnostics。
- [ ] 区分 missing extension、activation failed、runtime diagnostic 三类问题。
