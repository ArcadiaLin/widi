# Extensions

Extension 是 `widi-pi` 的高自由度扩展机制。它应能像 Pi coding-agent extension 一样深度参与 runtime，但不能绕过 core 的可观察边界。

当前目标不是实现完整 extension runtime，而是把 extension loader/runner、Orchestrator 与 `ToolRegistry` 的边界整理清楚。第一版 loader 支持 Pi 风格的 activation + `registerTool`，runner 将当前 agent/profile 的 loaded scope 注入 scoped registry overlay。`ToolRegistry` 继续负责 source、diagnostics、patch、visibility、active tools 和最终 wrap-to-`AgentTool`。

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

这层能力用于“当前 session 可恢复 extension 状态”，不是 extension 私有数据库。大型 artifact、多 session index、产品模式状态仍属于 extension-owned storage。WIDI-owned tools 的可恢复数据走 Pi tool call arguments、tool result `content` 和 typed `details`。

Extension 可以修改既有 tools。

WIDI extension 不只注册新 tool，也可以对 core/product tool 注册 patch。Patch 必须进入 tool registry 的 resolved pipeline，而不是直接改写某个 runtime object。允许的修改包括：

- 改写 `description`、`parameters` 或 `strict` metadata。
- 包装 execute，例如审计、确认、沙箱转发、远程执行。
- 替换 execute，例如让 `write` 写到不同 backend。

这种设计让 active tool name 保持稳定。例如 extension 可以修改 `write` 的执行行为，但最终 resolved tool 仍叫 `write`，session 中的 active tools 和历史 tool call 仍可解释。

Extension 不拥有 core tool 状态接口。Core 不提供共享的 tool preview 或状态 API；展示数据应由 UI 或 extension host 基于 orchestrator `tool_lifecycle_event`、tool arguments 和 tool result 派生。

当前 `ToolRegistry` 已支持 `defineTool(tool, source)` 与 `patchTool(targetToolName, patch, source)`。Extension loader/runner 的职责是把 extension declaration 激活为当前 agent/profile 的 loaded scope，再由 Orchestrator 在 resolve 边界把该 scope 写入 scoped registry overlay；registry 不直接加载 extension、不执行 activation hook，也不决定 missing extension policy。

Patch 执行时的 `context.extension` 按当前 patch source 绑定；调用 `next()` 时会恢复内层 tool source 的 context。这样 extension 可以安全地在 `aroundExecute` 中使用自己的权限、storage 和 diagnostics 上下文，同时不会把自身身份泄漏到 core/base execute。

需要继续设计的细节：

- extension patch 是否需要 permission，例如能否替换 execute、能否只允许 `aroundExecute`。
- 多个 extension patch 同一字段时，只按注册顺序决定最终值；extension loader 需要让加载顺序可解释、可诊断。
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

### Product Tool Definition

Extension patch 机制需要真实的 WIDI-owned product tools 来验证。否则 extension runner 只能接入抽象 registry，无法证明 `defineTool`/`patchTool`、tool context、human request 和 diagnostics 的完整链路。

开发 extension runner 前建议至少落地一个低风险 product tool definition：

- 由 core 通过 `defineTool` 注册为 `ToolDefinition`。
- 通过 ToolRegistry resolve 后 wrap 成 Pi `AgentTool`。
- 使用 `context.human` 或 execution env 中至少一个 runtime capability。
- 产生 Pi 风格 tool result `content` 和 typed `details`。
- 通过 orchestrator `tool_lifecycle_event` 暴露执行事实，而不是在 tool definition 中维护 state/reducer。

`write`、`read` 和 `bash` 的 historical `ToolDefinition` examples 已经移到 `apps/widi-pi/examples/coding/` 并记录在 `core-tools.md`，用于理解 registry、Pi 风格 result/details、文件 I/O 和阻塞式 shell 执行语义。它们当前是 frozen legacy examples：不再位于 core，不再由 core barrel 导出，后续不继续补 Pi parity、sandbox/backend patch 或新 coding 能力，也不把 coding backend ownership 作为 extension runner 的前置条件。

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

## Pi Extension 对比

Pi coding-agent extension 已经支持注册 tool/command/provider、拦截 input/tool/system prompt/provider request、发起 UI 交互、注入消息、写扩展状态、定制渲染和触发 session 操作。

Pi 的 extension model 是 runtime-first：

- Extension 是 TypeScript factory，接收 `ExtensionAPI`。
- `pi.registerTool(tool)` 注册 LLM-callable tool。
- `pi.on(event, handler)` 订阅 lifecycle、session、message、tool、input、provider 等事件。
- `pi.registerCommand()`、`registerShortcut()`、`registerFlag()`、`registerProvider()` 把扩展能力接入 CLI/TUI/model runtime。
- Extension runner 管理 auto-discovery、project trust、reload、stale context、extension errors、UI context 和 command context。
- 同名 extension tools 在 runner 内 first registration wins；合成到 session tool registry 时 extension/custom tools 可以覆盖 built-in tools。

WIDI 的当前形态更偏 core-first：

- 已有 `ToolDefinition`、`ToolDefinitionPatch`、`ToolSource` 和 `ToolRegistry`。
- `ToolRegistry.defineTool(tool, source)` 使用 first registration wins；后续同名 define 只产生 diagnostic。
- `ToolRegistry.patchTool(targetToolName, patch, source)` 按注册顺序应用；后注册的 `aroundExecute` 包在外层。
- Patch 可以修改 model-facing contract，也可以包装或替换 execute；contract risk 和 field conflict 会进入 `CoreDiagnostic`。
- Orchestrator 已能把 resolved tools wrap 成 Pi `AgentTool`，并发布归一化 `tool_lifecycle_event`。

因此 WIDI 已经具备开发 extension 的 tool registry 底座，但还没有具备 Pi coding-agent 那种可交付 extension runtime。

### Extension Readiness

当前结论：**还没有准备好正式开发 extension；已经准备好继续开发 extension runner 的下层支撑。**

已具备：

- Tool definition/patch 的稳定 core API，不再暴露 contribution DSL 或 priority。
- Tool source provenance，可用于 diagnostics、debug view 和未来 extension context。
- Patch composition、`aroundExecute` context 绑定、human request 和 execution env adapter。
- Tool lifecycle facts，可供 UI 和未来 extension host 观察 tool call/run。
- CoreDiagnostic 管道已能承载 tool/profile/model/session 等模块的结构化问题。

仍缺：

- Extension declaration、identity、version/compatibility、source metadata 和 missing policy。
- Extension loader：路径/package 解析、trust gate、activation、reload、error isolation。
- Extension API：已具备 `registerTool`、activation-time `patchTool`、`observe` 和 MVP `intercept`；后续仍需设计 `registerCommand`、resource/provider registration 等入口。
- Hook event matrix：已落地 observer 与四个 MVP interceptor；provider/session hook、mutate 权限、更多返回值合成和 permission 仍需继续设计。
- Extension-owned storage 与 session `custom` entry API。
- Permission model：尤其是 patch `execute` replacement、filesystem/shell/model/session/orchestrator capability。
- Debug/inspection command：查看 loaded extensions、registered hooks、resolved tools、patches、diagnostics。

下一步不应直接写业务 extension。应继续加固 loader/runner：通过 diagnostics/debug view 展示 extension activation、registered hooks、defined tools、patches 和 resolved tools。Hook event matrix、command/provider registration 和 session custom entry API 应在 permission 与 diagnostics 规则明确后再开放。

## 非职责

- 不私有维护 agent lifecycle。
- 不私有维护 A2A 通信。
- 不直接修改持久 profile/session 文件。
- 不把 extension runtime state 当作可恢复 core state。
- 不把 extension-owned storage 升格为 core persisted state。
- 不绕过 tool registry 直接替换产品内置 tool runtime object。
- 不把 Pi `custom` entry 用作大型 extension 数据库。

## TODO

### Extension Runner 前置 TODO

- [ ] 定义 extension-owned custom entry API：append/read 权限、branch scope、fork、compaction、export、debug view 和 diagnostics policy。
- [ ] 定义 extension custom entry payload 的 JSON serializable、大小、schema validation 和敏感信息 policy。
- [x] 通过 historical `bash/read/write` examples 验证过 registry、tool context、tool result details 和 diagnostics 链路；这些 examples 现已移出 core。
- [x] 将 legacy `bash/read/write` 移出 core，作为 `apps/widi-pi/examples/coding/` 参考实现保留；不再为它们补 Pi parity 或 backend patch 示例。
- [ ] 设计最小 debug/inspection command，展示 resolved profile/resources/tools/session metadata/custom entries，后续扩展到 extension state。
- [ ] 确认 profile、resource、tool、settings、auth、model、session manager diagnostics 都已接入 `CoreDiagnostic` 和 orchestrator event。

### Extension Runner TODO

- [x] 将 tool tracking 明确为 extension pattern，并保留未接入 runtime 的示例骨架。
- [x] 让 tool registry 支持 extension-style `defineTool`/`patchTool` registration。
- [x] 让 `aroundExecute` / patch `execute` 的 runtime context 按 patch source 绑定，并在 `next()` 时恢复内层 context。
- [ ] 定义 extension declaration 的 identity、source、version/compatibility 和 missing policy。
- [ ] 设计 extension registry/loader/activation lifecycle。
- [x] 为 MVP hook 点区分 observe 与 intercept；`before_agent_start`、`context`、`tool_call`、`tool_result` 已桥接到 `AgentHarness.on(...)`。
- [ ] 继续为 provider/session hook 点列出 permission：observe、intercept、mutate、invoke capability。
- [ ] 定义 extension-contributed resources/commands/diagnostics 如何进入对应 registry。
- [ ] 定义 extension tool patch 的权限、加载顺序和 runtime context 绑定。
- [ ] 实现 extension 使用 custom entry API 的写入、读取、恢复和错误 diagnostics。
- [ ] 定义 extension-owned storage 的边界、路径授权和 diagnostics。
- [ ] 区分 missing extension、activation failed、runtime diagnostic 三类问题。
