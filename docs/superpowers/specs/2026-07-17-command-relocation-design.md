# Command 迁出 core 设计（command relocation）

日期：2026-07-17
状态：已与用户逐节确认

## 背景与目标

当前 `apps/widi-pi` 的命令系统整体活在 core：`src/core/command.ts` 持有命令定义、
解析与内置绑定表，`AgentOrchestrator.inputAgent` 承担命令解析、gateway 检查、
必填参数补全（走 human request）、inline 展开、`command_*` 事件广播与会话写入。
但内置命令的 execute 几乎全部是对 orchestrator 原子方法的一行转发，命令层实质
是交互协议，不是运行时能力。

目标：**core 中不再存在 command 语义**。orchestrator 只提供原子方法；命令的
定义、解析、补全、执行循环、结果呈现与错误全部下移到交互层共享模块
`src/commands/`，由 TUI 和 cli 消费。

## 已确认的决策

1. **扩展命令整体移除**。扩展不再注册命令（`extensionRunner.getCommands` /
   `getCommand`、`reservedCommands`、扩展触发词收集全部删除）。扩展保留被动
   能力（输入拦截、输出、状态、消息、诊断）。未来如需暴露扩展的主动唤醒入口，
   由前端以 `/extension` 之类的命令另行设计，不在本工程范围。
2. **inline 命令（`<prompt:` `<skill:`）移到交互层**。交互层在提交前扫描展开，
   核心通过 `promptAgent` 的 `expansions` 参数持久化展开记录。
3. **命令引擎放共享交互层模块 `src/commands/`**，TUI 与 cli.ts 共用；TUI 在其
   上注册纯 TUI 命令。
4. **迁移方式：一步到位（方案 A）**，不保留过渡期双管线，不保向后兼容 API。
5. **命令错误自成一体**。命令失败不进入 core 诊断系统，使用交互层自己的
   `CommandError`；core 诊断反向清理 `commandId` 字段与 `command.*` code。

## core 侧变更

### promptAgent 成为唯一文本输入入口

`promptAgent(agentId, text, options)` 保留并内聚现 `inputAgent` 中属于输入而非
命令的部分：

- 扩展输入拦截（block/transform）留在 `promptAgent` 内部，包括
  `input_blocked` / `input_transformed` 事件与 `appendInputTransformEntry`
  持久化。任何调用方都不能绕过输入拦截。
- 新增 `options.expansions?: readonly PromptExpansion[]`：交互层完成 inline
  展开后，把展开记录（原 token、替换文本、位置、展示名）交给 core，core 以
  现有 `appendCommandExpansionEntry` 的会话条目格式持久化，保证水合不变。
  `PromptExpansion` 是 core 类型，字段与现有会话条目对齐，不含 command 语义
  命名（条目磁盘格式不变）。

### 整体删除

- `inputAgent`、`InputResult`、`options.commands` 开关。
- `src/core/command.ts` 的解析（`parseLineCommand`、`scanInlineCommands`）、
  `BUILT_IN_COMMANDS` / `BUILT_IN_INLINE_COMMANDS` 绑定表、`getBuiltInCommands`、
  `Command` / `CommandInvocation` / `CommandArguments` 等类型（该文件清空后删除）。
- `AgentOrchestrator.listCommands`、命令 gateway（`_commandGateway`、
  `_commandPolicyDenial`、`_withCommandAvailability`）、`commandPolicy`、
  `scope: "user-facing"` 检查、`_getLineCommandTriggers`、
  `_findLineCommand` / `_findInlineCommand`、`_expandInlineInput`、
  `_createCommandId`。
- orchestrator 事件 `command_detected` / `command_accepted` /
  `command_completed` / `command_failed` / `command_rejected`。
- `_completeCommandArguments` 与 human-request 的 `argumentsCompletion` kind、
  `CommandArgumentsCompletionPayload`。
- agent profile 中的 `commandPolicy`（enabled/deny）。它防的是"程序化调用方带
  命令语法进入 core"，命令只存在于交互层后已无对象。
- `OrchestratorDiagnostic.commandId` 字段及所有 `command.*` 诊断 code；
  扩展 API 回调（emitOutput/notify/setStatus/clearStatus/reportDiagnostic/
  publishMessage）签名中的 `commandId` 参数一并移除。

### 保留并整理的原子面

命令引擎的全部原料均为既有方法：`abortAgent`、`compactAgent`、`steerAgent`、
`followUpAgent`、`forkAgentSessionFromAgent`、`newAgentSessionFromAgent`、
`resumeAgentSessionByReference`、`listAgentSessions`、`getAgentSessionTree`、
`navigateAgentTree`、`setAgentModelByReference`、`listAvailableModelCandidates`、
`setAgentThinkingLevelByName`、`listAgentThinkingLevelCandidates`、
`setAgentSessionName`、`inspectAgent`、`listAgents`、`getAgentStatus`、
`reloadExtensions`、`getAgentPromptTemplate`、`listAgentPromptTemplateCandidates`、
`getAgentSkill`、`listAgentSkillCandidates`。

`CommandCandidate` 改名为中性的 `CandidateItem`（`{ value, label?, description? }`），
归 core 类型（上述 list 方法的返回元素）；含 "Command" 字样的结果类型同步改名
（如 `AgentSessionCommandResult` 去掉 Command 字样）。

## `src/commands/` 模块

位置与依赖方向：与 `src/tui/`、`src/cli.ts` 平级；依赖 core（类型 + orchestrator
原子方法），core 对它零感知。

### 文件划分

- `types.ts`：
  - `CommandContext { agentId, orchestrator }`
  - `LineCommand { name, description, argumentHint?, requiresArgument?,
    checkStatus?, complete?, execute }`
  - `InlineCommand { name, argumentHint?, complete?, expand }`（expand 为纯函数
    展开，无副作用）
  - `CommandError { message: string; cause?: unknown }`
  - `EngineOutcome`（见下）与 `CommandView`（带可用性标注的列表项）
- `parse.ts`：`parseLineCommand`（触发词固定 `/`）与 `scanInlineCommands`
  （固定 `<` `>`），从 core 迁入；多触发词逻辑删除。`ParsedLineCommand` 新增
  `hasArgument: boolean`，区分 `/fork`（未给参数）与 `/fork:`（显式空参数）。
- `built-ins.ts`：内置命令表迁入，execute 一行转发原子方法：
  `/abort /compact /steer /follow-up /fork /new /resume /session /tree /model
  /thinking /name /status /inspect /agent /reload` 与 inline 的
  `<prompt:` `<skill:`。`checkStatus` 语义保持（如 `/steer` 需 running、
  `/resume` 非 running）。
- `engine.ts`：`CommandEngine`，构造签名
  `new CommandEngine(commands: readonly (LineCommand | InlineCommand)[])`。
  调用方自行拼装 `[...builtInCommands, ...extraCommands]`；TUI 将来把
  `/export` `/copy` `/hotkeys` `/quit` 作为 extraCommands 注册。
- 辅助：从 cli.ts 迁入 agent 切换判定（原 `getNextAgentId`），即从
  `/resume` `/new` `/fork` 的返回值中提取新 agentId，供 TUI 与 cli 共享。

### 引擎 API

- `list(status: AgentLifecycleStatus): CommandView[]` — 按当前 agent 状态计算
  `available` / `unavailableReason`，供 editor 自动补全与 completion menu。
- `handleInput(text, context): Promise<EngineOutcome>`：
  - `{ kind: "pass" }` — 非命令，调用方自行 `promptAgent`；
  - `{ kind: "expanded", text, expansions }` — 含 inline 命令，调用方以
    `promptAgent(text, { expansions })` 提交；
  - `{ kind: "executed", commandId, name, value }`；
  - `{ kind: "failed", commandId, name, error: CommandError }`；
  - `{ kind: "needs-argument", command, candidates }`。
- needs-argument 触发规则：未给参数（`hasArgument === false`）且命令声明了
  `requiresArgument` 或 `complete`。显式空参数（`/fork:`）不触发，直接以空参数
  执行——这是 completion menu 中 "Fork here" 项的提交形态。因此
  `/model` `/thinking` `/resume` `/tree` 的 execute 删除现有"空参数返回候选
  列表"分支，候选列表统一由 needs-argument 出口承担。
- 引擎不调用 `promptAgent`：images、排队、pendingInput 记账是前端职责。
- commandId 由引擎本地生成，仅用于前端关联展示。
- `execute` / `expand` / `complete` 抛错统一捕获为 `CommandError`；可用性拒绝
  （如 idle 时 `/steer`）同样返回 failed + `CommandError`，不分级、不进诊断。

## TUI 接入

- `submit()`：`engine.handleInput` → pass/expanded 走 prompt 路径（pendingInput
  记账保持）；executed/failed 直接本地生成 `CommandResultItem`（时间线投影不再
  监听 `command_*` 事件，投影器相应分支删除）；needs-argument 打开 completion
  menu，选中后以 `/name:value` 重新提交。现有 `matchBareSelectorCommand` 裸命令
  拦截删除，由 needs-argument 出口统一承担。
- `CommandResultItem`：`diagnostic?: OrchestratorDiagnostic` 字段改为
  `error?: CommandError`，渲染为一行错误文本；`retainedAttention` 不再扫描
  command-result 的诊断——命令失败是即时交互反馈，不做跨 agent 注意力标记。
- 状态简化：命令集静态化，`AgentViewState.commands` 与 `commandRevision` 删除，
  自动补全与菜单直接查询引擎。
- `human-request.ts` 删除 `argumentsCompletion` 渲染分支。
- 会话水合：inline 展开条目磁盘格式不变，水合渲染不变；`CommandResultItem`
  本就 ephemeral，不参与水合。本工程不改会话磁盘格式，旧会话可直接打开。

## cli.ts 接入

`inputAgent` 调用替换为 `engine.handleInput` + `promptAgent`；needs-argument
时打印候选列表；executed/failed 打印结果或错误；agent 切换复用共享辅助函数。

## 测试策略

- `tests/core/agent-orchestrator.test.ts` 中命令用例迁移改写为
  `tests/commands/engine.test.ts`（解析判定、可用性、必填参数、inline 展开、
  执行转发、失败错误）；orchestrator 测试保留输入拦截与
  `promptAgent(expansions)` 持久化用例。
- `tests/commands/parse.test.ts` 承接现有解析测试。
- TUI 测试更新：submit 路径按引擎结果分支、needs-argument 开菜单、
  `CommandResultItem` 本地生成与错误渲染、自动补全改问引擎。
- 全量验证：仓库根 `npm run check` 与 `npm --workspace apps/widi-pi run test`。

## 实现核对备注

整体分层与行为按本设计落地；实现有三处 API 形状调整：

- `promptAgent` 使用 `options.expansion?: PromptExpansion`，一个对象聚合同一次输入
  的 `originalText` 与全部 expansion items；对应 `EngineOutcome.expanded` 字段也叫
  `expansion`，而不是设计初稿中的复数数组。
- `PromptExpansion.items` 精确沿用既有 `core:command_expansion` 磁盘字段
  （commandId、name、trigger、argument、start、end），不额外保存 replacement
  text；展开后的 user message 已保存模型实际看到的文本。这样无需迁移 session
  磁盘格式。
- `CommandEngine.handleInput` 额外接受可选 `EngineHooks.onCommandStart`。TUI 用它
  在异步 execute/expand 期间建立本地 running `CommandResultItem`；该 hook 不进入
  core，也不改变最终 `EngineOutcome`。

兼容性上，旧 `core:extension_message` custom entry 若仍带多余 `commandId`，
hydrator 会按所需字段读取并忽略它；不需要磁盘迁移。

## 范围外（明确不做）

- `/extension` 前端入口与扩展主动交互（未来另议）。
- `/export` `/copy` `/hotkeys` `/quit` 的实现（属 TUI 第 4 项工作，本工程只
  提供 extraCommands 注册点）。
- 会话磁盘格式变更。
- `pi/*` 上游代码改动。
