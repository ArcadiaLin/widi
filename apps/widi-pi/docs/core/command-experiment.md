# Command Experiment

> **状态：实验裁决已出，正在迁移。**
> Command 作为独立可选 runtime 的实验结束，结论是否定的：command 不是一层独立 runtime，而是 orchestrator 自身的 input 能力。本文档记录裁决理由、目标形态和迁移边界。`src/core/command/` 在迁移完成后删除。

## Motivation

Core 里已经存在许多原子能力：prompt agent、steer running agent、resume session、fork branch、reload extension、request human、修改 active tools 等。第一版实验试图把这些能力包装成 typed `CommandRequest` union，让 consumer、extension、adapter 围绕同一组 capability 组合。

架构 review（2026-07-03，基于 `f05c88c`）证明这个形态失败了，失败点有三：

1. **伪可选**。文档声称 Command 是可选 runtime，代码事实是 `agent-orchestrator.ts` 运行时 import `executeCommand/executeInput/listInputCommands`，`dispatch()` 的执行体就是 command 模块的 switch。可选的只是那个 20 行的 `Command` 包装类。
2. **事件语义分叉**。`orchestrator.dispatch()` emit `command_accepted/completed/rejected`，`Command.execute()` 直接调 `executeCommand` 不发任何事件。同一个请求走两个"官方入口"得到两种可观察性。
3. **四重簿记**。每新增一个能力 = orchestrator 方法 + `CommandRequest` 变体 + switch case + `CommandValue` 成员（外加 `BuiltinInputCommandKind` 第五份映射）。27 个 command kind 里只有 `agent.input`（input command 解析）和 `extension.reload` 有增量语义，其余 25 个是方法的镜像。在没有任何 RPC consumer 之前，这套 schema 只有维护成本。

## Decision

**Command 收回 orchestrator，core 中的 "command" 一词从此只指 input-triggered command。**

- Orchestrator 的原子方法（`promptAgent`、`steerAgent`、`forkAgentSessionFromAgent`……）是唯一的 capability 事实。programmatic consumer（测试、adapter、未来 collaboration tools）直接调方法，不经过任何 command 包装。
- Command 是 orchestrator 内置的 human/client-facing input 协议：按 `<trigger><name>` / `<trigger><name>:<argument>` 固定模板解析、注册、门控、参数补全、执行、发事件。`/` 只是 built-in 当前使用的默认 trigger，不是 command 的本体。
- typed `CommandRequest`/`CommandValue` union、`dispatch()`、`Command` 类全部删除。将来出现真实 RPC/serialization consumer 时，再从实际调用点提取 schema，而不是提前维护。

这同时解决 review 指出的命名撞车：旧 typed runtime `Command` 不再存在；新的 `Command` 只表示 input-triggered command fact，与 Pi coding-agent 的 `registerCommand`、VSCode command、CQRS command 不再共享执行入口。

## Capability Model

Orchestrator 内部分两层，边界清晰：

| 层 | 入口 | 消费者 | 事件 |
| --- | --- | --- | --- |
| 原子方法 | `promptAgent` / `steerAgent` / `forkAgentSessionFromAgent` … | 代码（adapter、extension actions、collaboration tools、测试） | 各自已有的 harness / diagnostics 轨道 |
| Command input | `inputAgent(agentId, text)` | 人类输入（TUI、CLI、任何 client） | `command_*` 事件轨道 |

Command 的执行体最终仍是原子方法调用——它的增量只有四件事：input 解析、可见性/门控事实、参数补全、统一事件轨道。这四件事都以 human 输入为前提，所以它们属于 input 路径而不属于方法面。

Command 解析有两个关闭开关：`inputAgent` 的 per-call 选项 `commands: false`（原 `inputInvoke`，已随契约改名），以及 profile 的 `commands.enabled: false`（整个 profile 关闭解析）；关闭后 `inputAgent` 等价于 `promptAgent`。

## Command Registry

类型定义在 `src/core/command.ts`。目标形态：

```ts
export interface Command {
  readonly name: string;              // 不含 trigger / ":" / whitespace
  readonly placement: "line" | "inline";
  readonly trigger: string;           // 例如 "/"、"@"、"<"
  readonly closeTrigger?: string;     // inline command 可用，例如 ">"
  readonly description?: string;
  readonly argumentHint?: string;     // 例如 "<name>"、"[session]"
  readonly source: CommandSource;
  readonly scope?: "user-facing" | "any";  // 默认 "any"，gateway 消费
  readonly arguments?: CommandArguments;
  readonly available?: boolean;
  readonly unavailableReason?: string;
}

export type CommandSource =
  | { readonly kind: "built-in" }
  | { readonly kind: "extension"; readonly extensionId: string };

export interface CommandArguments {
  readonly required?: boolean;        // 必填但缺失时触发 argument completion
  // 候选来源，client-side completion 与 runtime completion 共用
  complete?(context: CommandCompletionContext): Promise<CommandCandidates>;
}
```

解析模板固定，command 只声明 trigger：

- line：`<trigger><name>` 或 `<trigger><name>:<argument>`，整行匹配；无 `:` 时 argument 是空字符串。
- inline：`<trigger><name>` / `<trigger><name>:<argument><closeTrigger>` 嵌入文本，前后必须是空白或文本边界；有 `closeTrigger` 时 argument 到 closeTrigger 截止。
- `:` 只分割第一次出现的位置，后续 `:` 都属于单个 raw argument。command parser 不拆 argv，需要结构化参数的 command 自己解析。

注册来源有两个，**运行时绑定共享，可见事实统一**：

- **Built-in**：静态绑定表，定义在 `command.ts`（迁移见[解析归属裁决](#解析归属不建-commandregistry-类2026-07-07-裁决)），orchestrator 直接 import 并持有运行时 lookup。每条 binding = `Command` 事实 + `execute(orchestrator, agentId, args)` / 后续 `expand` 执行体，只消费公开原子方法。built-in 当前默认 `trigger: "/"`，名字在同一 `placement + trigger` 下保留，extension 不能覆盖。
- **Extension**：`registerCommand()` 贡献，随 extension runner per-agent 存活（见 [Extension Surface](#extension-surface)）。extension 当前只支持 line handler，默认 `trigger: "/"`，允许声明其他 trigger。

对外只暴露统一事实，不暴露执行体：

```ts
listCommands(agentId: AgentId): Command[]
```

`listCommands` 输出的是**该 agent 可见**的 command：静态判据（profile `commands` policy、`scope`）直接剪列表——被 deny 的、非 user-facing agent 上的 `/new` 不出现；动态判据（agent status）**不剪列表**，而是作为每项的 `available: boolean` + `unavailableReason` 事实输出——`/steer` 在 idle 时仍在列表里但标注不可用。这样菜单稳定不闪烁，UI 自己决定置灰还是隐藏；列表只是快照，执行时 gateway 仍是唯一裁决。client 可按 `trigger` 唤醒菜单、按 `placement` 过滤 line/inline 子集，RPC 的能力宣告也消费这一个事实，core 不关心呈现形态。

### 解析归属：不建 CommandRegistry 类（2026-07-07 裁决）

阶段 3/4 落地后曾评估引入与 ToolRegistry 同构的 `CommandRegistry` 类，外加 agent runtime build 期物化的 `AgentCommandSet`（`allLineBindings` / `listedCommands` / `lineTriggers` 三视图）。裁决：**否。command 的解析与门控是 orchestrator input 路径的私有行为，保持惰性查询，不物化、不建 registry 类。**（本节标题的 "Command Registry" 指注册与可见事实这套机制，不是一个类。）

理由：

1. **提案要解决的四条 profile 语义已全部实现，且不需要 registry。** deny/scope 命中时明确 rejected 而非降级为 prompt——`_findLineCommand` 查 binding 不看 deny，`_commandGateway` 是执行期唯一仲裁者；`listCommands()` 应用 `_commandPolicyDenial` 做静态剪裁；`_getLineCommandTriggers` 取自全部 binding，denied command 不会被误当普通输入。三视图恰是这三个私有方法的惰性等价物，物化只是把已有查询换了个数据结构。
2. **ToolRegistry 的复杂度由 patch 语义挣回**：`aroundExecute` 包装与 context source 绑定、patch 字段冲突诊断、注册顺序语义、requested/active 两层名字解析。command 一样都没有——无 patch 概念、只有 built-in 与 extension 两种来源、冲突规则一句话（built-in 名字保留，由 runner 的 `reservedCommands` 参数强制）。
3. **build 期快照有反向代价**：extension 若动态增删 command，快照需要失效/重建逻辑；每次 input 现查 runner 天然新鲜，command 列表规模下扫描成本可忽略。

同轮补充裁决——**built-in 绑定表迁至 `command.ts`，但不做 runtime-service 构建期注入**。binding 执行体签名是 `(orchestrator, agentId, args)`，只消费公开原子方法，表本身是纯声明事实，搬到 `command.ts` 是零行为变化的布局归位（command.ts = 类型 + parser + built-in 表的完整 command 事实模块，对 `AgentOrchestrator` 仅 `import type`）；orchestrator 继续直接 import 该常量。评估过"runtime-service 构建期把表注入 orchestrator 构造参数"，裁决否，理由：

1. **绑定不闭包任何构建期状态**。执行体到执行时才拿 `(orchestrator, agentId)`，候选事实（modelRegistry、skills）也经 orchestrator 触达；注入只是把常量多递两跳，不产生新自由度。extension command 需要构建期组装是因为 `profile.extensions` 是真实构建期变量，built-in 无对应物。
2. **可注入意味着可变，但该可变性没有消费者**。没有场景需要一个 built-in 集合不同的 orchestrator；per-agent 差异已由 profile `deny`/`enabled`/`scope` 承担。
3. **注入重开验证面**。表作为静态常量时"built-in 名字保留"是编译期事实；变成实例参数后重名/缺项/diagnostics 的问题链会把 mini-registry 逼回来。
4. **与 ToolRegistry 的对称是形式对称、实质不对称**。tool 多来源、可 patch、profile 按名选择，构建期组装有实活；command 三者皆无。

复议条件（满足其一时再提取 resolver 与构建期组装，提取点就是上述三个私有方法）：

- command 出现第三种来源（用户/项目级 command 文件、MCP prompts 等），冲突处理不再适合塞在 `reservedCommands` 参数里，且该来源确属构建期发现；
- command 出现 patch/override 语义。

## Execution Flow And Events

唯一入口是 `inputAgent(agentId, text, options)`。流程与事件严格对应：

解析分两个阶段：先按**整行 line command** 匹配（输入以任一已注册 line `trigger` 开头，且 `<trigger><name>` 命中 registry），未命中再对全文做 **inline command 扫描**（见 [Inline Commands](#inline-commands)），最后剩余文本按普通 prompt 走。

```
inputAgent(agentId, text)
  │
  ├─ 非已注册 line trigger 开头，或 trigger/name 无匹配 line command
  │    ├─ inline 扫描命中 → 逐个展开（各自走 detected→…→completed/failed）
  │    │                     全部成功 → 展开后的文本走 promptAgent
  │    │                     任一失败 → 整段输入 rejected，不发送半展开的 prompt
  │    └─ 无任何命中 → 按普通 prompt 走 promptAgent —— 不发任何 command 事件
  │
  └─ 整行解析命中 registry
       ├─ emit command_detected        // 识别为 command，附 commandId、trigger、name、source
       ├─ gateway 检查（profile policy / scope / agent status）
       │    └─ 失败 → emit command_rejected + diagnostic，结束（无副作用）
       ├─ 参数检查
       │    ├─ 必填缺失 → argumentsCompletion human request（见下节）
       │    └─ 无 client / 超时 / 拒绝 → emit command_rejected + diagnostic，结束
       ├─ emit command_accepted        // 门控与参数就绪，即将执行
       ├─ 执行 built-in binding 或 extension handler
       ├─ 成功 → emit command_completed（附 result 摘要）
       └─ 抛错 → 转 diagnostic → emit command_failed
```

事件语义收窄后的裁决：

- `command_detected`：输入被识别为已注册 command 的瞬间。UI 可以据此立即给出"命令已识别"反馈，审计可以记录包括被拒命令在内的全部意图。
- `command_rejected`：**执行前**被拦下（门控失败、参数无法补全）。保证无副作用。
- `command_failed`：**执行中**失败。可能已有部分副作用，diagnostic 必须携带。
- 旧 `dispatch()` 用 `command_rejected` 同时表达两者，拆开是为了让审计/恢复逻辑能区分"没做"和"做砸了"。
- 未命中 registry 的 `<trigger><name>` 文本不发事件——它不是 command，是普通输入。这维持现状语义（fall through 到 prompt），避免把用户口头的 trigger 误报成命令失败。

所有 command 执行**只有这一条事件轨道**。extension command 与 built-in command 走完全相同的 detected→accepted→completed/failed 序列（旧实现中 extension command 失败只记 diagnostic 不发事件，统一掉）。事件传递顺序与 client fanout 见 [Runtime Lifecycle](./runtime-lifecycle.md)（该文档 command 章节需随迁移改写）。

**返回契约**：`inputAgent` 返回小的判别式 union，调用方同步拿结果，不被迫订阅事件：

```ts
export type InputResult =
  | { kind: "prompt"; message: AssistantMessage }
  | { kind: "command"; commandId: string; name: string; value: unknown }
  | { kind: "rejected"; commandId: string; diagnostic: OrchestratorDiagnostic }
  | { kind: "failed"; commandId: string; diagnostic: OrchestratorDiagnostic };
```

`value` 是 `unknown`——不复活 17 成员的 `CommandValue` union，需要精确类型的调用方直接用原子方法。由此 `command_completed` 事件只携带摘要（commandId、name、ok），完整 result 由返回值承载，事件轨道专注审计而非取值。

## Inline Commands

Line command 把**整行输入**变成一次操作；inline command 允许在**输入的任意位置**嵌入命令，随 prompt 一起提交。典型场景：

```
帮我 review 这个 PR，<skill:code-review> 重点看并发问题
```

`<skill:code-review>` 在提交时被捕捉并展开为 skill 提示，其余文本原样保留。这是你在任何输入阶段插入 skill/template 的方式，不要求先敲一条独立命令。

裁决如下：

- **语法**：line 与 inline 共享固定模板：无参 `<trigger><name>`，有参 `<trigger><name>:<argument>`。空格不再是 name/argument 分隔符；argument 是单个 raw string，`:` 只切第一次。line command 要求整行匹配，inline command 要求 command token 前后是空白或文本边界。
- **Inline 闭合**：有 `closeTrigger` 时完整形态是 `<trigger><name>:<argument><closeTrigger>`，例如 `<skill:code-review>`。argument 到 `closeTrigger` 截止，可包含空格；无 `closeTrigger` 的 inline command 只适合无空格 argument，到下一个空白截止。
- **placement 是声明事实，执行体仍受 binding 校验**。命令声明自己挂在 `line` 还是 `inline` 模板上；registry binding 负责保证 line command 有操作执行体（built-in `execute` / extension `handler`），inline command 有纯展开执行体（`expand(arg) => string`）。操作类命令（`/new`、`/abort`、`/model`……）因其执行形态天然 line-only——在句中执行有副作用的操作，无论对用户还是对审计都是不可接受的歧义。
- **解析时机**：orchestrator 在 `inputAgent` 提交时扫描，这是唯一的事实裁决点。client 在输入过程中按 `trigger` 与 `placement: "inline"` 唤醒补全菜单只是输入辅助，client 不自行展开——展开语义、gateway、事件都归 orchestrator。
- **展开语义**：一段输入可含多个 inline command，按出现顺序逐个展开；每个占位被替换为该 command 的展开产物（如 `<skill:name>` → skill 提示 + metadata）。未命中 registry 的 `<trigger><name>:<argument>` 视为普通文本原样保留，不发事件。
- **事件与失败**：每个命中的 inline 展开走同一条 `command_detected → accepted → completed/failed` 轨道，事件附 `placement: "inline"` 和所属输入的关联 id。任一展开失败（skill 不存在、profile deny）→ 整段输入 `command_rejected`，**不发送半展开的 prompt**——与参数补全失败不降级为普通聊天是同一条纪律。
- **参数补全同样适用**：`<skill:>` 冒号后为空视为必填缺失，走 argumentsCompletion human request（候选来自 profile skills），补全后继续展开。
- **Session 记录：两份都记**。user message 存展开后的文本——模型看到的就是 session 里的，resume/fork 后上下文与当初实际发送一致，消费者不需要理解展开逻辑；原始输入与展开位置（command name、arg、offset）进 session custom entry（facade 已存在），UI 回放想渲染用户原文时从 custom entry 取。拒绝"只记原始、resume 时重展开"——skill 文件变更后重展开产物不同，破坏 session 事实性。

首批 inline command 就是两个 input 变换类 built-in：`<skill:...>`、`<prompt:...>`（内部同样以 expand 形态实现，与 extension 契约同构）。

## Command Gateway And Profile Policy

Gateway 是 orchestrator 私有方法（`_commandGateway(record, command)`），按序检查三类事实，任一失败产出带 `command.not_permitted` / `command.not_available` code 的 diagnostic：

1. **Profile policy**。profile 新增 command 门控字段。命名上采纳 review 建议：这是权限声明，不进 `capabilities` 继续泛化，而是独立字段：

   ```ts
   readonly commands?: {
     readonly enabled?: boolean;        // false = 该 profile 完全关闭 command 解析
     readonly deny?: readonly string[]; // 按 name 禁用个别 command
   };
   ```

   默认全开。先只做 `enabled` + `deny` 两个否定形事实——allow-list、按 source 门控等等待真实 consumer 再加。`deny` 对 built-in 和 extension command 一视同仁。

2. **Scope**。`scope: "user-facing"` 的 command（`/new`、`/fork`、`/resume`）只在接受用户输入的 agent 上可执行，判据是 profile 的 `capabilities.acceptsUserInput !== false`。**不引入 "main agent" 运行时概念**——AgentRecord 上没有也暂不添加 lineage 字段，避免再造一个无写入者的提前定义；这是 `capabilities` 第一次被真实消费（回应 review "解析而不执行的 policy 字段"）。M3 spawn 落地时补 `spawnedBy?: AgentId` 作为 lineage 事实，届时复核此判据。

3. **Agent status**。个别 command 对状态有要求（`/steer` 要求 running、`/resume` 要求非 running 等）。这些要求声明在 built-in binding 上，gateway 统一检查，而不是散落在各方法里重复报错。

Gateway 只裁决"这个 agent 此刻能不能执行这个 command"。它不是 extension 权限系统——ExtensionActions 的 scope 收敛是独立问题（review 问题 3），不在本文档范围。

## Argument Completion

Command 对参数有结构要求，这是 input-triggered command 相对普通 prompt 的核心增量，也是 human request 的第一个 core 内消费场景。

`HumanRequestKind` 已增加 `"argumentsCompletion"`（`src/core/human-request.ts`）。流程：

- 命中 command 且声明 `arguments.required` 但输入未携带参数时，orchestrator 发起 `argumentsCompletion` human request。`payload` 是 `CommandArgumentsCompletionPayload`：`commandId`、原始 `command` invocation、`argumentHint`、`argumentPrefix` 和候选列表（若 `complete()` 存在）。请求恒置 `allowFreeInput: true`——参数补全天然接受候选之外的自由输入（见 [Client 渲染契约](#client-渲染契约)）。
- client 返回的 `input`/`select` 值作为 args 继续执行；其他 response kind、`undefined` 或 blank string 均视为未补全。无可用 client、超时（仅当调用方设置 `timeoutMs`）、取消或用户拒绝 → `command_rejected`（recoverable diagnostic），**不静默 fall back 成普通 prompt**——用户明确输入了命令，把残缺命令当聊天文本发给模型是最坏的失败模式。
- 补参失败后的 command diagnostic code 保持 `command.arguments_required`，`details` 记录 `completionFailureCode`、`requestId` 等 human request 失败事实；human request 自身的 diagnostic event 仍作为支撑遥测发布。
- 补参成功后 gateway **复查一次**：human 等待可能比 gateway 前提活得长（如 `/steer` 要求的 running turn 在用户打字期间结束），复查让过期的 command 仍以 `command_rejected` 无副作用收场，而不是执行中途 `command_failed`。

候选来源按 command 归属：

- **Built-in** 的候选直接来自 orchestrator 事实：`/resume` → `listAgentSessions()`，`/tree` → session tree entries，`/skill` → profile 声明的 skills。
- **Extension** 通过契约里的 `getArgumentsCompletion(argumentPrefix)` 提供。

补参路径现状仅覆盖 built-in（`ExtensionCommandDefinition` 尚无 `arguments` 字段）。将来接入时 extension 的候选回调**不得接收完整 orchestrator 句柄**——`CommandCompletionContext.orchestrator` 是 built-in 专属事实，extension 侧要么镜像 `execute` 的 binding 层闭包模式，要么消费经 runner 收窄的 context。

同一候选源支撑两种消费模式：

1. **Runtime 补全**（上述 human request 路径）：保证没有富 UI 的 client（stdout、RPC）也能走通带参命令。
2. **Client 补全**：UI 在输入过程中主动查询候选渲染 completion menu，参数就位后提交的输入直接通过参数检查，human request 不触发。

也就是说 human request 是兜底轨道，富 client 可以完全绕开它，两边消费同一份事实，不出现两套 completion 定义。

### Client 渲染契约

Human request 的统一呈现是选择题；自由输入是可选能力而非例外形态（`allowFreeInput` 字段，2026-07-07 裁决）：

- **双轨渲染**：`options` 只携带候选 value，是无富 UI client 的降级渲染最小面；label、description 等富信息只进 `payload`。未来新增 kind 遵守同一阶梯，不往信封顶层加渲染字段。
- **`allowFreeInput`**：缺省按 kind 固有形态（`input` 恒自由输入，`confirm`/`select` 恒否）；置 true 时 client 在候选之外提供自由输入入口。`argumentsCompletion` 恒置 true——补参天然接受候选之外的值。
- **自由输入不兼容 command**：自由输入的值是字面值，任何一侧都不对它做 command 解析。argumentsCompletion 的补全值直接进 `execute`，从不回流 `parseLineCommand`。
- **应答约定**：`select` = 选了候选，`input` = 自由输入。`argumentsCompletion` 接受这两种，其余 response kind 由 orchestrator 以 `arguments_completion_invalid_response` 拒绝（强制点：`_completeCommandArguments` 的 kind 检查），client 无需自行防御。
- **超时**：orchestrator 不设默认 `timeoutMs`——交互式补参没有合理的超时值；超时是调用方通过字段主动选择的行为，悬挂请求的逃生门是 `cancelHumanRequest`。

## Built-in Commands

Built-in 集合定义在 `command.ts` 的静态绑定表中（orchestrator 直接 import，见[解析归属裁决](#解析归属不建-commandregistry-类2026-07-07-裁决)），是 Multi-Agent Core 完整操作面的一部分。现状 + 规划：

| Command | 绑定 | scope | 参数 | 状态 |
| --- | --- | --- | --- | --- |
| `/abort` | `abortAgent` | any | — | 已有 |
| `/compact` | `compactAgent` | any | `[instructions]` | 已有 |
| `/follow-up` | `followUpAgent` | any | `<text>` 必填 | 已有 |
| `/steer` | `steerAgent` | any | `<text>` 必填 | 已有 |
| `/fork` | `forkAgentSessionFromAgent` | user-facing | `[entry]` | 已有 |
| `/new` | `newAgentSessionFromAgent`（重载全部 extension） | user-facing | — | 已有；非 user-facing agent 上执行 reject + diagnostics |
| `/name` | `setAgentSessionName` | any | `<name>` 必填 | 已有 |
| `/resume` | `resumeAgentSessionByReference`；无参时列出 sessions | user-facing | `[session]`，候选来自 `listAgentSessions()` | 已有 |
| `/session` | `listAgentSessions` | any | — | 已有 |
| `/tree` | `getAgentSessionTree` / `navigateAgentTree` | any | `[entry]` | 已有 |
| `/agent` | `listAgents` | any | — | 已有 |
| `/status` | `getAgentStatus` | any | — | 已有 |
| `/inspect` | `inspectAgent` | any | — | 已有 |
| `/reload` | `reloadExtensions`（当前 agent） | any | — | 已有 |
| `/model` | `setAgentModel`；无参时列出候选 | any | `[provider/model]`，候选来自 `modelRegistry.getAvailable()` | 规划 |
| `/thinking` | per-agent thinking level setter（缺失，见下） | any | `<level>`，候选来自当前 model 的 `thinkingLevelMap` | 规划 |
| `<skill:...>` | input 变换，`placement: inline` | any | `<skill_name>` 必填，候选来自 profile skills | 规划 |
| `<prompt:...>` | input 变换，`placement: inline` | any | `<template>` 必填 | 规划 |
| `/spawn` | `spawnAgent` | user-facing | `<agent_profile>` | **推迟**：没有 UI/collaboration 语义前不定义子 agent 交互，与 collaboration tools（M3）一起做 |

`/steer`、`/follow-up` 看似多此一举（UI 完全可以直接调方法），保留的理由是让 stdout/最小 client 无需实现任何专有交互就能触达完整操作面——这正是 command input 协议存在的意义。

**Input 变换类 command**（`<skill:...>`、`<prompt:...>`）是第三种 built-in 形态：执行体不是原子方法调用，而是把输入改写后继续走 `promptAgent`，因此它们是首批 `placement: "inline"` 成员（语义见 [Inline Commands](#inline-commands)）。例如 `<skill:review>` 展开为 skill 提示（`use this skill` + skill metadata），嵌在原输入的对应位置。事实源已经就绪：`ResourceLoader.loadSkills()` 已存在（`resource-loader.ts:68`，复用 pi 的 `loadSourcedSkills`），候选与 metadata 都从它取；展开产物只含 metadata 与指引，skill 正文仍由 agent 的 read tool 按需加载——这依赖 coding tools 的 core built-in 裁决（见 [DESIGN.md](../DESIGN.md) Coding Tools 节，M2 落地 read 最小集）。

### Settings Commands

`/model`、`/thinking` 是第一批 settings 类 built-in，边界裁决：

- **只改 agent 运行时事实，不写 settings 文件**。`/model` 绑定 `setAgentModel`，`/thinking` 绑定 per-agent thinking level setter，二者都作用于当前 agent record，进程结束即失效。把"本次会话换个 model"持久化成默认偏好是 adapter/setting-manager 的裁决，command 层不做——否则一条 command 输入就能改共享配置文件，审计轨道对不上。
- **候选即事实**。`/model` 的候选来自 `modelRegistry.getAvailable()`（只列 auth 就绪的 model），`/thinking` 的候选来自当前 model 的 `thinkingLevelMap` 键（`off/minimal/low/medium/high/xhigh` 中该 model 实际支持的子集；无 `reasoning` 能力的 model 上直接 reject）。无参输入触发 argumentsCompletion，与其他命令同轨。
- **命名缺口**：orchestrator 目前只有 `setDefaultThinkingLevel()`（orchestrator 级默认值）和创建时的 `thinkingLevel` 选项（`agent-orchestrator.ts:375`、`:274`），没有 per-agent 运行时 setter。`/thinking` 落地前需先补 `setAgentThinkingLevel(agentId, level)` 原子方法——command 永远绑定原子方法，不允许 command 执行体成为某能力的唯一入口。生效时机：下一 turn，不打断当前运行，与 Pi harness queue 语义一致。
- 通用的 `/set <key> <value>` 不做：setting-manager 的键面还没有稳定契约，逐键开 command 会重演 typed union 的四重簿记。等出现第三个 settings 类需求再评估收敛形态。

## Extension Surface

Extension 贡献 command 的价值不变：提供 UI-neutral executable capability，不描述 keybinding、picker、modal、autocomplete、RPC shape。这让 extension 注册的能力可以被 TUI、stdout、RPC 任意 adapter 以自己的方式呈现。

**契约收敛**：`src/core/extension/command.ts` 的草稿与 `extension/types.ts` 里既有的 `ExtensionCommandDefinition` 必须合并为一个类型，不允许平行契约。目标形态（替换 `types.ts` 中现有定义，`inputInvoke` 字段名随之退役）：

```ts
export interface ExtensionCommandDefinition {
  readonly name: string;               // 不含 trigger / ":" / whitespace
  readonly trigger?: string;           // 默认 "/"
  readonly placement?: "line";         // 当前 extension command 只支持 line handler
  readonly description?: string;
  readonly argumentHint?: string;
  readonly handler: (argument: string, ctx: ExtensionCommandContext) => Promise<void> | void;
}
```

第一阶段 extension 只贡献 line handler；inline 的 `expand(argument) => string` 会在 inline commit 加入，届时 extension definition 仍是作者侧契约，runner 负责 adapter 成统一 `Command` fact 与 runtime binding。

与 built-in 的关系：

- **共享 runtime binding，不共享作者侧 definition**。orchestrator 内部把 built-in 与 extension 都 adapter 成 `{ command: Command; execute(context): Promise<unknown> }` 这类 normalized binding；但 built-in 的作者侧执行体仍可直接访问 orchestrator 内部，extension 的作者侧执行体只拿 `ExtensionCommandContext`。强行统一作者侧 `CommandDefinition` 会迫使 built-in 走 context 注入，或迫使 extension 拿到 orchestrator 内部面——两个方向都错。
- **共享可见事实与事件轨道**。`registerCommand()` 的贡献在 `listCommands()` 中以 `source: { kind: "extension", extensionId }` 出现，执行走同一条 detected→accepted→completed/failed 事件序列。
- 后续 `getArgumentsCompletion` 返回候选事实而非 `HumanRequest`——发不发 human request、发给谁，是 orchestrator 的裁决，extension 只提供候选。
- built-in 的 `placement + trigger + name` 组合保留；extension 之间同 key 冲突由 runner 归一化并产出可见事实，后续可收敛为 first-registration-wins + diagnostic。
- Profile 的 `commands.deny` 对 extension command 同样生效。

## Milestone: Command 收编

本文档的全部裁决构成一个独立 milestone（对应 review M1 中 Command 相关部分：问题 1/2 及问题 3 的 `ExtensionActions.dispatch` 一角）。按 commit/阶段落地，每个阶段结束时测试全绿：

**阶段 1 — 文档修真（无代码）**。本文档定稿；改写 `runtime-lifecycle.md` 的 "Command Dispatch" 章节与 `DESIGN.md` 的 "Command Runtime" 章节；`TODO.md` 收敛为本 milestone 的 blocking 项。文档先与目标一致，后续 commit 以它为验收基准。

**阶段 2 — 代码布局整理（零行为变化）**。现有 command 相关代码归位：

- `OperationSource` 从 `command/types.ts` 迁到独立 core 模块（如 `core/operation-source.ts`），解开 `human-request → command` 的反向依赖。
- `command.ts` 定型：`Command`、`CommandSource`、`CommandArguments`、候选类型，`parseLineCommand` 迁入并使用固定 `<trigger><name>:<argument>` 模板。
- `extension/command.ts` 草稿并入 `extension/types.ts` 的 `ExtensionCommandDefinition`（按本文档契约重写，工作树草稿与设计出入处——`CommandDefintion` 拼写、旧命令字段——直接丢弃）。
- `AgentSessionCommandResult` 等纯 result 类型迁到其所有者模块（session-manager / orchestrator）。

**阶段 3 — `inputAgent` 收编**。`command/builtin.ts` 的 14 条定义换到 `Command` binding 表形态（补 `trigger`、`scope`、`arguments` 事实，`executeBuiltinInputCommand` 的 switch 变成绑定表闭包，消灭第五份映射）；`executeInput`/`listInputCommands`/`executeExtensionInputCommand` 并入 orchestrator；接上 `_commandGateway`、`InputResult` 返回契约与完整事件序列（`command_detected`/`command_failed` 加入 `OrchestratorEvent`）；profile `commands` 字段进 frontmatter 解析。

**阶段 4 — 删除，不留过渡期**。旧 `Command` 类、`CommandRequest`/`CommandValue`/`CommandResult` union、`dispatch()` 与 `_executeCommand` switch、`ExtensionActions.dispatch`、`command/` 目录整体。消费面已核实：`tests/core/agent-orchestrator.test.ts` 的 29 处 `dispatch()` 调用（机械改写为原子方法或 `inputAgent`）、`runtime-service.ts:693` 的 `new Command()` 组合——没有产品消费者，deprecated 过渡期只会延长双入口状态。**阶段 4 完成后 dispatch 不复存在，双入口状态在本阶段内终结，不跨阶段过夜。**

**阶段 5+ — 增量能力，按命令逐个落**。每个切片独立可验收、测试全绿，任何一个卡住不阻塞已收编的主干。commit 顺序按依赖排定：

0. **built-in 绑定表迁至 `command.ts`（零行为变化布局 commit）**。`BuiltInCommandBinding`、`BUILT_IN_COMMANDS`、`getBuiltInCommands()` 归位 command 事实模块，orchestrator 直接 import（裁决见[解析归属](#解析归属不建-commandregistry-类2026-07-07-裁决)）。必须先于一切新 command 落地——后续每个切片都往这张表加条目，先搬家，加条目的 commit 才不混入布局变更。
1. **`setAgentThinkingLevel(agentId, level)` 原子方法**。纯方法面补缺（见 [Settings Commands](#settings-commands) 命名缺口），下一 turn 生效；无 `reasoning` 能力的 model 上报错。command 落地前方法必须先在。
2. **`/model` + `/thinking` settings commands**。绑定 `setAgentModel` / `setAgentThinkingLevel`；候选来自 `modelRegistry.getAvailable()` / 当前 model 的 `thinkingLevelMap`；无参时以 command value 返回候选列表（同 `/session` 形态），不依赖 argumentsCompletion。
3. **argumentsCompletion human request**。已替换"参数缺失直接 `command_rejected`"的过渡行为：先发 `argumentsCompletion` 请求，无 client / 超时 / 拒绝再 reject；候选消费 binding 的 `complete()` 事实，与 client 补全共用一份定义。既有消费者：`/steer`、`/follow-up`、`/name` 的必填参数，切片 2 的候选源。
4. **inline 扫描与 expand 管线 + `<prompt:...>`**。`parseLineCommand` 未命中后的 inline 扫描、expand 执行体校验、`placement: "inline"` 事件、session 双份记录、任一失败整段 reject。`<prompt:...>` 纯文本插入，作为管线的首个消费者一起落，避免无消费者的裸机制。
5. **`<skill:...>`**。候选来自 profile skills（`ResourceLoader.loadSkills()`）；展开产物只含 metadata 与指引，正文按需加载依赖 M2 coding tools 的 read 最小集——本切片可先落，正文加载能力随 M2 就绪。

验收标准沿用 review 的纪律：阶段 4 后不存在两个事件语义不同的 command 入口；每一条"不让 X 做 Y"（保留字、gateway、fall-back 禁止、expand 无副作用）都能指到一行强制它的代码。

## Non-Goals And Open Questions

不做（直到出现真实 consumer）：

- **RPC/serialization schema**。typed union 死于没有 consumer，不再提前造。RPC adapter 出现时从 `listCommands()` 事实 + 原子方法签名生成。
- **Command log 持久化**、client fanout 变更、Pi harness queue 语义重定义——均维持现状边界。
- **多 client 的 human request 路由**。argumentsCompletion 暂沿用 first-client-wins，多 client 语义随 M3 真实场景再定义。

已裁决（原待定项）：main-agent 判定 → `scope: "user-facing"` 消费 `capabilities.acceptsUserInput`；返回契约 → 判别式 `InputResult`，`command_completed` 只带摘要；解析模板 → 固定 `<trigger><name>` / `<trigger><name>:<argument>`，argument 是单个 raw string；session 记录 → message 存展开、custom entry 存原文；inline 能力 → `placement: "inline"` + 可选 `closeTrigger` 声明模板，binding 校验执行体；`dispatch()` → 直接删无过渡；`listCommands` → policy/scope 静态剪列表 + status 作 availability 标注；`<prompt:...>` → 纯文本插入无占位符；`/thinking` → 下一 turn 生效。

已裁决（补充）：`inputInvoke` 开关随契约退役，改名为 `inputAgent` 选项 `commands: false`，并新增 profile 级 `commands.enabled: false` 等价开关；参数缺失在 argumentsCompletion 落地前直接 `command_rejected`（code `command.arguments_required`），不降级为 prompt；不建 `CommandRegistry` 类 / build 期 `AgentCommandSet`——解析与门控保持 orchestrator 私有惰性查询（见 [解析归属](#解析归属不建-commandregistry-类2026-07-07-裁决)）。

待定：

- `<skill:...>`、`<prompt:...>` 展开产物的具体模板文本（事实源已就绪，格式随实现定）。
