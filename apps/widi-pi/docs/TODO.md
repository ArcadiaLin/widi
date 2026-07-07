# WIDI Milestones

本文档只记录当前与近期 milestone 的 blocking 项和验收标准。纪律：

- 完成项在 milestone 收尾时整段删除，不打勾堆积——git history 是账本。
- 入 milestone 的门槛是 consumer 举证：每一条都必须能回答"哪个已存在的 consumer/测试需要它"。答不出的进 [BACKLOG](BACKLOG.md)。
- 机制边界与设计裁决记录在各机制文档，本文档不复述。

## M1: Command 收编（当前）

目标：终结 command 伪可选层（review 问题 1/2），trigger-based command input 成为 orchestrator 自身的 input 能力。全部裁决与阶段切片见 [Command Experiment](core/command-experiment.md)。

阶段 1–4（文档修真、代码布局、`inputAgent` 收编 + gateway、dispatch 删除）已完成，账本见 git history。裁决补充：不建 `CommandRegistry` 类 / `AgentCommandSet`，解析与门控保持 orchestrator 私有惰性查询；built-in 绑定表迁 `command.ts` 但不做 runtime-service 构建期注入（裁决与复议条件见 command-experiment.md 解析归属节）。

阶段 5+ 按依赖排定的 commit 切片（细节见 command-experiment.md 阶段 5+ 节）：

- [x] built-in 绑定表迁至 `command.ts`（零行为变化布局 commit，先于一切新 command）。
- [x] `setAgentThinkingLevel(agentId, level)` 原子方法。
- [x] `/model` + `/thinking` settings commands（候选来自 modelRegistry / thinkingLevelMap，无参返回候选列表）。
- [x] argumentsCompletion human request（替换参数缺失直接 reject 的过渡行为；gateway 补参后复查、`allowFreeInput`、Client 渲染契约随本切片落地）。
- [x] inline 扫描与 expand 管线 + `<prompt:...>` 首个消费者。
- [x] `<skill:...>`（候选来自 profile skills；正文加载随 M2 read 就绪）。

验收：不存在两个事件语义不同的 command 入口；每条"不让 X 做 Y"（保留字、gateway、fall-back 禁止、expand 无副作用）都能指到一行强制它的代码。

## M2: 边界收敛 + 第一个真实 consumer

对应 review M1/M2 中 command 与 extension 之外的部分（extension 相关条目已收编进 ME）。前半是减法，后半是第一个产品消费者：

- [ ] `src/core/tools/` 占位清理：删除 `coding/` 七个空文件；`tools/types.ts` 与 `tools/index.ts` 重复 re-export 二留一。
- [ ] `agents` map 与 `getAgentHarness()` 私有化，对外只留 snapshot 查询；`spawnAgentHarness` 改名 `spawnAgent`，只返回 `agentId`。
- [ ] Agent status 收敛：删除 `ready` 或补消费者（当前事件路径只产 `running`/`idle`，`ready` 仅创建瞬间出现）。
- [ ] 显式声明单进程写入假设（session/auth/config storage 共用此裁决），或实现文件锁。
- [ ] package.json 修真：删除虚假入口（`main`/`bin`/`cli` 指向不存在的文件）与未使用依赖；README 写明 bootstrap 顺序（submodule → build pi → test）。
- [ ] Core built-in coding tools 第一版（裁决见 [DESIGN.md](DESIGN.md#coding-tools)）：read/write/edit 最小集复刻 pi-coding-agent，`source: core` 进 ToolRegistry；`/skill` 依赖的 read 能力在此就绪。
- [ ] 最小 stdout/CLI adapter：只消费 orchestrator events + `inputAgent`，用真实调用压力反向检验 ToolRegistry、hook、diagnostics——当前所有 API 只被测试消费过。

## ME: Extension Surface（M2 之后、M3 之前）

目标公式、pi 能力对照表、裁决原则与切片细节见 [Extension Experiment](core/extension-experiment.md)。锚点 consumer：审计/策略 extension（consumer 举证均指向它，除注明者外）。原 M4 的设计条目全部收编于此，随对应切片落地：

- [ ] 切片 0：Tool 契约类型（`ToolDefinition`/`ToolDefinitionPatch`/`ToolSource`/`ToolExecutionContext`/`ToolLifecycleEvent`）从 `extension/types.ts` 迁 core 层（零行为变化布局，解依赖倒置）。
- [ ] 切片 1：Interceptor 失败语义定案 + 实施——合成类跳过失败者保留其余，`tool_call` 拦截 fail-closed；写进 extensions.md。
- [ ] 切片 2：`ExtensionActions` scope 化（own-agent 默认，agentId 由 context 注入，capabilities 接线）+ 在 scoped 前提下补齐动作/查询面（send/steer/followUp、setSessionName、exec、getCommands、setModel/thinkingLevel）。
- [ ] 切片 3：审计锚点 extension 落库为仓库内真实测试 consumer，反向检验切片 1/2。
- [ ] 切片 4：Hook matrix 第一批（observe 档）：`command_*`、`human_request_*`、diagnostics、session lifecycle、model/thinking select；每个 hook 标 observe/intercept/mutate 档位。
- [ ] 切片 5：`input` interceptor（拦截在 command 解析之前，改写后重走完整解析与 gateway）。
- [ ] 切片 6：Extension-owned storage 裁决 + custom entry policy（fork/compaction/export/`custom_message`）；extension inline `expand` 契约顺带接入。
- [ ] 切片 7：Resource contribution（skills/prompt templates 贡献，registration-with-provenance，ResourceLoader 所有权边界）。
- [ ] 切片 8：Provider contribution（ModelRegistry register/unregister provider；auth 所有权不移交；provider hook 视 pi harness 暴露评估）。
- [ ] 切片 9：API 面冻结：公开契约清单、版本兼容策略、`extension.version_incompatible`；第三方视角验收 extension。

验收：对照表每项归属落定（core 已落 / client 层含事实对应物 / backlog 含举证缺口）；每条"extension 能/不能做 X"有裁决 + 代码锚点；审计 extension 在他人抛错时不失防有回归测试；第三方视角 extension 只依赖公开契约完成 tool + command + observer 组合。

## M3: Multi-agent 最小闭环

- [ ] Collaboration facade（orchestrator helper），由 profile `capabilities.canSpawn` 门控。
- [ ] `agent_spawn` / `agent_prompt` / `agent_wait` / `agent_status` 四个 core tools（`agent_handoff` 语义未定义，不做）。
- [ ] `AgentRecord` 增加 `spawnedBy` lineage 事实，复核 command `scope: "user-facing"` 的 gateway 判据。
- [ ] Cross-agent human-request 路由：多 client 语义在此定义（此前维持 first-client-wins）。
- [ ] `/spawn` command。
- [ ] Multi-agent 测试：spawn、并发、abort、dispose、unavailable 恢复。

验收：spawn → collaborate → recover 有真实流程测试；"原生 multi-agent"的差异化声明第一次有代码背书。

（原 M4 "Extension Surface 收口" 已整体收编进 ME，2026-07-07 裁决；Product presentation——`agent.inspect` facts 的产品级 UI/RPC 呈现——移入 [BACKLOG](BACKLOG.md)，随 client adapter 工作举证。）
