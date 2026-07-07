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

对应 review M1/M2 中 command 之外的部分。前半全部是减法，后半是第一个产品消费者：

- [ ] `src/core/tools/` 占位清理：删除 `coding/` 七个空文件；`tools/types.ts` 与 `tools/index.ts` 重复 re-export 二留一。
- [ ] Tool 契约类型（`ToolDefinition`/`ToolDefinitionPatch`/`ToolSource`/`ToolExecutionContext`/`ToolLifecycleEvent`）从 `extension/types.ts` 迁到 core 层，解开 dependency 层对 extension 层的依赖倒置。
- [ ] `agents` map 与 `getAgentHarness()` 私有化，对外只留 snapshot 查询；`spawnAgentHarness` 改名 `spawnAgent`，只返回 `agentId`。
- [ ] `ExtensionActions` scope 化：actions 默认锁定 own agent（agentId 由 context 注入），跨 agent 操作等 M3 collaboration facade。
- [ ] Interceptor 失败语义定案：改为"跳过失败者、保留其余 extension 结果"，或显式 fail-closed 并写进 extensions.md（当前：一个 handler 抛错静默丢弃全部合成结果）。
- [ ] Agent status 收敛：删除 `ready` 或补消费者（当前事件路径只产 `running`/`idle`，`ready` 仅创建瞬间出现）。
- [ ] 显式声明单进程写入假设（session/auth/config storage 共用此裁决），或实现文件锁。
- [ ] package.json 修真：删除虚假入口（`main`/`bin`/`cli` 指向不存在的文件）与未使用依赖；README 写明 bootstrap 顺序（submodule → build pi → test）。
- [ ] Core built-in coding tools 第一版（裁决见 [DESIGN.md](DESIGN.md#coding-tools)）：read/write/edit 最小集复刻 pi-coding-agent，`source: core` 进 ToolRegistry；`/skill` 依赖的 read 能力在此就绪。
- [ ] 最小 stdout/CLI adapter：只消费 orchestrator events + `inputAgent`，用真实调用压力反向检验 ToolRegistry、hook、diagnostics——当前所有 API 只被测试消费过。

## M3: Multi-agent 最小闭环

- [ ] Collaboration facade（orchestrator helper），由 profile `capabilities.canSpawn` 门控。
- [ ] `agent_spawn` / `agent_prompt` / `agent_wait` / `agent_status` 四个 core tools（`agent_handoff` 语义未定义，不做）。
- [ ] `AgentRecord` 增加 `spawnedBy` lineage 事实，复核 command `scope: "user-facing"` 的 gateway 判据。
- [ ] Cross-agent human-request 路由：多 client 语义在此定义（此前维持 first-client-wins）。
- [ ] `/spawn` command。
- [ ] Multi-agent 测试：spawn、并发、abort、dispose、unavailable 恢复。

验收：spawn → collaborate → recover 有真实流程测试；"原生 multi-agent"的差异化声明第一次有代码背书。

## M4: Extension Surface 收口

Extension 是设计缺口最大的一块：当前 loader/runner 是 MVP，能跑内部验证，但离"可交付的第三方扩展面"还有整层设计没做。本 milestone **设计先行**——每个条目先产出裁决文档（进 `docs/core/`，风格与 command-experiment.md 相同：裁决 + 边界 + 代码锚点），再进实现；裁决文档可以在 M2/M3 期间并行推进，实现在 M3 后落地。

- [ ] Hook matrix 裁决：provider/session hook 开放哪些、每个 hook 点是 observe/intercept/mutate 中的哪一档、返回值如何合成、失败语义（承接 M2 的 interceptor 定案）。开放门槛沿用 consumer 举证。
- [ ] Provider/resource contribution 裁决：extension 如何注册 provider、skills、prompt templates 或动态 resources；与 ResourceLoader/ModelRegistry 的所有权边界；参照 ToolRegistry 的 registration-with-provenance 模式。
- [ ] Extension-owned storage 裁决：core 提供什么（路径、diagnostics、lifecycle hook），不解释什么（数据模型）；与 session custom entry 的分工线。
- [ ] Session custom entry policy：fork、branch move、compaction、export、`custom_message` 语义（当前 MVP 只有 append-only + current branch path）。
- [ ] 稳定第三方 extension API 裁决：activation API 面冻结范围、版本兼容策略、`extension.version_incompatible` 的语义。
- [ ] Product presentation：`agent.inspect` facts 的产品级 UI/RPC 呈现形态。

验收：每条"extension 能/不能做 X"的宣言都有裁决文档 + 代码锚点；第一个第三方视角 extension（非仓库内测试）能只依赖公开契约完成 tool + command + observer 的组合。
