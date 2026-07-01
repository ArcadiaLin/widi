# WIDI 下一阶段 TODO

本文档是当前阶段唯一的集中 TODO 链。分机制文档只记录边界和当前事实；新增任务先落到这里，避免 checklist 分散、过期。

## 当前判断

`widi-pi` 已经完成了 core runtime 的若干底座：profile registry、settings/auth/model registry、JSONL session adapter、orchestrator command/client/human-request、ToolRegistry、extension loader/runner MVP、observer/interceptor MVP、extension tool define/patch，以及 extension `custom` entry 的 session-local state MVP。

项目仍处于“core demo 可跑，product harness 未完整”的阶段。主要缺口不是单点 API，而是 runtime composition、extension discovery/trust/reload、agent record、coding tools、debug view、权限和多 agent 协作语义尚未收口。

## 依赖主线

1. Runtime composition 先把 settings、profile roots、resource roots、extension roots、model/auth、session root 和 default profile/model 接成一个稳定入口。
2. Agent record 再替代 `Map<AgentId, AgentHarness>`，承载 status、profile/source、session metadata、resolved resources/tools/extensions 和 diagnostics。
3. Extension loader/runner 基于 agent record 补齐 file/module loader、trust、reload、permission、diagnostics 和 debug view。
4. Coding extension 在 extension 机制稳定后提供 read/write/edit/bash/grep/find/ls 等产品工具；core 不再把这些当成 primitive。
5. Agent collaboration tools 通过 orchestrator command/helper 实现，所有 agent lifecycle、A2A、human request 和 diagnostics 仍经过 orchestrator。

## P0: Runtime Composition

- [x] 设计并实现应用级 runtime service，统一创建 `ExecutionEnv`、`SettingManager`、`ConfigValueResolver`、`AuthStorage`、`ModelRegistry`、`AgentProfileRegistry`、`ResourceLoader`、`SessionManager`、`ToolRegistry`、`ExtensionLoader` 和 `AgentOrchestrator`。
- [x] 将 `SettingManager.getProfilePaths()` 接入真实 profile roots，组合 settings paths、project `.widi/profiles`、agent dir profiles 和 builtin default profile。
- [x] 将 settings 中的 `skills`、`prompts`、`extensions` paths 接入 resource/extension discovery，而不是只停留在 typed getters。
  - Runtime composition 阶段边界：`skills`/`prompts` 接入 `ResourceLoader` roots；`extensions` 接入 `ExtensionLoader.discover()`，只产出 discovery candidates 和 diagnostics，不执行 file/module load 或 activation。完整 extension declaration、file/module loader、trust/reload/permission/activation diagnostics 留在 P0 Extension 完善阶段。
- [x] 明确 default profile/model 的来源：settings、CLI/runtime override、builtin fallback 的优先级和 diagnostics。
  - Default profile 优先级：runtime override > settings `defaultProfile` > builtin `default` fallback。Default model 优先级：runtime override > settings `defaultProvider`/`defaultModel` > first available configured model fallback。Default thinking level 优先级：runtime override > settings `defaultThinkingLevel` > builtin `medium` fallback，并按 resolved model capability clamp。Runtime service 暴露 resolved source facts，并为成功解析与 fail-fast 错误提供 diagnostics。
- [x] 为 runtime service 增加 focused tests，覆盖损坏 settings、缺失 profile root、project trust 和 builtin default source。

## P0: Agent Record And Lifecycle

- [x] 将 `AgentOrchestrator.agents: Map<AgentId, AgentHarness>` 收敛为 agent record。
- [x] Agent record 至少包含：`agentId`、status、profile reference/source、session metadata、model、harness、tool snapshot、extension runner、resource diagnostics、extension diagnostics。
- [x] 定义 status：`creating`、`ready`、`running`、`idle`、`unavailable`、`disposed`。
- [x] 实现 status query command/debug API。
- [x] 实现 dispose lifecycle：unsubscribe harness events/interceptors、invalidate extension runner、清理 pending human requests、释放 runtime resources。
- [x] 定义 unavailable agent：subagent 或恢复分支失败时保留 agent record 和 diagnostics，但不创建 broken harness。
- [x] 增加 unavailable/resume failure tests。

## P0: Extension 完善

- [x] 内存 factory loader：`registerExtensionFactory()`。
- [x] Activation-time `registerTool()` / `patchTool()`。
- [x] Runtime `observe()` / `intercept()` MVP：`before_agent_start`、`context`、`tool_call`、`tool_result`。
- [x] Extension `ctx.session.appendEntry()` / `findEntries()` MVP：当前 extension namespace、current branch path、append-only custom state。
- [ ] 定义 extension declaration：id、source、version/compatibility、missing policy、permission request。
- [ ] 实现 file/module loader：path/package resolution、`package.json` manifest、direct file、directory index、cache busting。
- [ ] 接入 project trust gate；project-local extension 默认需要 trust。
- [ ] 实现 reload：重新 discover/load extension，替换 runner，旧 context stale，刷新 scoped tool registry。
- [ ] 将 extension missing/activation/runtime/handler/custom-entry diagnostics 全部纳入 orchestrator event，并补齐 source/phase/disposition。
- [ ] 增加 debug view：loaded extensions、registered hooks、tool contributions、patches、diagnostics、stale state。
- [ ] 定义 permission model：metadata patch、aroundExecute、replace execute、session custom entry、human request、dispatch、model/provider、filesystem/shell。
- [ ] 增加 `registerCommand()` MVP，并让 extension command 通过 orchestrator command/client 边界执行。
- [ ] 设计 provider/resource contribution：extension 如何注册 provider、skills、prompt templates 或动态 resources。
- [ ] 明确 provider/session hook matrix，决定 observe/intercept/mutate 的最小开放集。

## P0: 基础 Coding Tools

当前 `apps/widi-pi/examples/coding/{bash,read,write}.ts` 是 frozen legacy examples，不属于 core runtime composition。

- [ ] 决定 built-in coding extension 的包/目录形态，例如 `extensions/coding` 或 app preset 内置 factory。
- [ ] 从 Pi coding-agent 对齐 product tool set：`read`、`write`、`edit`、`bash`、`grep`、`find`、`ls`。
- [ ] 先实现 read/write/edit 的最小可交付版本：path resolution、binary/image policy、truncation、typed details、mutation queue、错误文本。
- [ ] 再实现 search tools：优先使用 `rg`/`fd` 或可注入 backend；缺失依赖时产生清晰 diagnostic。
- [ ] 设计 bash backend：短期可用阻塞式 `ExecutionEnv.exec()`；长期等 interactive shell session 原语。
- [ ] 所有 coding tools 都以 extension `registerTool()` 贡献，ToolRegistry 负责 visibility、active tools、patch 和 diagnostics。
- [ ] 增加 tool result compatibility tests，验证 Pi-style `content`/`details` 可从 session 恢复。
- [ ] 明确 sandbox/local/remote backend 的选择不进入 `ToolDefinition` 通用 contract，而由 extension activation 闭包捕获。

## P0: Agent 协作 Tools

- [ ] 定义 agent collaboration facade：spawn/resume child agent、prompt/steer/followUp、wait/abort、inspect status、collect summary。
- [ ] 实现最小 built-in/extension tools：`agent_spawn`、`agent_prompt`、`agent_wait`、`agent_status`、`agent_handoff`。
- [ ] 所有协作 tool 只能通过 orchestrator dispatch/helper 操作 agent，不直接持有 raw harness。
- [ ] 明确 session 记录策略：协作请求/结果作为 tool call/result 进入调用 agent session；被调用 agent 使用自己的 Pi session。
- [ ] 定义 A2A human-request 策略：被调用 agent 请求人类时如何路由 source、target 和 timeout。
- [ ] 定义 subagent unavailable 恢复路径：父流程可继续，diagnostics 可见。
- [ ] 增加 multi-agent tests：spawn、失败恢复、并发、abort、tool visibility、diagnostics。

## P1: Diagnostics And Debug

- [ ] 增加 `agent.inspect` 或 debug command，展示 profile、resources、tools、active tools、extensions、session metadata、custom entries 摘要和 diagnostics。
- [ ] 定义 resource diagnostics severity：explicit missing、default dir missing、parse failed、duplicate identity。
- [ ] 将 resume 路径 diagnostics 测试补齐：profile missing/disabled、resource diagnostics、active tool missing、extension missing。
- [ ] 标准化 extension diagnostic code：`extension.missing`、`extension.load_failed`、`extension.invalid_manifest`、`extension.version_incompatible`、`extension.permission_denied`、`extension.activation_failed`、`extension.handler_failed`。
- [ ] 为 diagnostic event 增加 stable id 或 operation correlation，便于 UI/RPC 去重与回放。

## P1: Session And State

- [x] 本地 JSONL adapter 支持 header `metadata.profile`。
- [x] Storage 原样保存 Pi `custom` / `custom_message` entries。
- [x] Extension custom state MVP 使用 namespaced `custom` entry。
- [ ] 定义 custom entry fork、branch move、compaction、export、debug view policy。
- [ ] 定义 missing extension、version mismatch、restore failed 时如何展示已有 custom entries。
- [ ] 评估 custom message：是否进入 LLM context、是否显示、是否触发 turn、与 `sendMessage` 的关系。
- [ ] 设计 header metadata schema version/migration。
- [ ] 实现多进程文件锁或明确单进程写入假设。
- [ ] 与 Pi upstream 对齐 typed/custom session metadata，决定本地 adapter 是否长期保留。

## P1: Profiles And Resources

- [ ] 定义 profile `capabilities` 到 runtime policy 的映射：`acceptsUserInput`、`canSpawn`、`canRequestUser`。
- [ ] 评估是否需要 resource registry；当前 resource loader 只做轻量加载。
- [ ] 定义 duplicate skill/prompt template 的处理：diagnostic、覆盖、合并或保留全部。
- [ ] 决定 resolved resource source 是否进入 debug view、harness metadata 或 session custom entry。
- [ ] 梳理 profile frontmatter schema 文档和示例。

## P1: Model/Auth/Settings

- [ ] 梳理 `models.json` schema 文档和示例。
- [ ] 设计带多进程锁的 auth/config storage backend。
- [ ] 评估多 agent 场景下 auth/model/settings 是按 workspace 共享，还是按 profile/runtime 隔离。
- [ ] 将 provider registration 从 Pi global reset 模式收敛为更可控的 runtime scope，或记录当前全局副作用边界。

## P2: UI/RPC/Product Preset

- [ ] 明确第一版 WIDI product preset：默认 profile、默认 model policy、默认 coding extension、默认 tools、默认 extension set。
- [ ] 设计最小 CLI/TUI/RPC adapter 边界：只通过 orchestrator events/commands 交互。
- [ ] 增加 session selector、profile selector、model auth guidance、diagnostics panel 的 product TODO。
- [ ] 评估 `/team`、`/flow`、`/goal` 应作为 extension 还是 preset commands。

## Pi Upstream 对齐

- [ ] Session metadata typed/custom extension section。
- [ ] ExecutionEnv lock/transaction/lease。
- [ ] Interactive shell session：start、poll、write stdin、cancel、yield timeout、output cursor/truncation、cleanup。
- [ ] Harness queue item id 与 queued input cancellation。
- [ ] Provider registration scope，避免应用层频繁 reset global provider registry。

## Demo/原型状态清单

- `runtime-service.ts` 仍是 5 行占位，不能承担真实 runtime composition。
- `AgentOrchestrator` 仍以 `Map<AgentId, AgentHarness>` 为中心，缺少 agent record/status/dispose/unavailable。
- `ExtensionLoader` 只支持内存 factory，未做真实 discovery、trust、reload、version、permission。
- `ExtensionRunner` 已可运行 MVP hooks，但 command/provider/resource/session hook 面还窄。
- `ToolRegistry` 是较成熟底座，但缺少 debug facts 和 permission enforcement。
- `apps/widi-pi/examples/coding/*` 是参考实现，不是产品工具。
- `ResourceLoader` 仍是轻量 loader，不是 registry。
- `SessionManager` 已能管理 profile metadata 和 extension custom entries，但缺少 migration/lock/debug/export policy。
