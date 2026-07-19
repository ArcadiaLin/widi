# TUI Agent 惰性启动设计

日期：2026-07-19
状态：已确认并实现

## 背景与目标

当前 `WidiTuiApplication.run()` 在 TUI 启动完成后立即调用
`orchestrator.spawnAgent()`。Persistent profile 的 spawn 会同步创建 Pi JSONL
session，因此用户只是打开并退出 TUI，也会在 `.widi/runs/` 中留下只有 header
的空 session 文件。

这个问题属于 TUI 调用 core 的时机，不改变 core 的 session persistence 语义：
一旦 TUI 真正调用 `spawnAgent()`，core 仍立即创建 session；model、thinking level、
session name 等 session fact 仍由现有 core API 立即持久化。

目标：

- 单纯打开或退出 TUI 不调用 `spawnAgent()`，不创建 session 文件。
- 首次提交普通消息时启动 agent，然后把消息交给该 agent。
- `/model`、`/thinking`、当前的 `/rename`（产品语义上的 session name）在用户
  真正提交变更时启动 agent，再调用现有 setter，变更立即进入 session。
- `/new` 只建立一个新的待启动意图；若用户没有继续发消息或修改上述设置，不创建
  agent 或 session。未来 `/spawn` 采用相同规则。
- 不修改 `pi/*`，不把惰性文件逻辑下沉到 `SessionManager`。

## 状态模型

TUI 增加一个 application-owned `PendingAgentStart`，它不是 core agent，也不进入
`TuiApplicationState.agents`：

```ts
export type PendingAgentStart =
	| { readonly kind: "default" }
	| { readonly kind: "new-session"; readonly sourceAgentId: string };
```

TUI 初始持有 `{ kind: "default" }`，`activeAgentId` 为空。此时 editor 可提交，
transcript 为空，标题与启动摘要继续使用 `runtime.services` 中已经解析好的默认
profile/model/thinking facts。

`/new` 在已有 active agent 上把 pending intent 替换为
`{ kind: "new-session", sourceAgentId }`，切换到空 transcript，但不调用
`newAgentSessionFromAgent()`。若用户切回一个已有 agent，尚未 materialize 的 pending
intent 被放弃；它没有 core state 或磁盘 state 需要清理。

## Materialization

TUI 通过一个可单测的 pending-agent coordinator 集中 materialize：

- `default` 调用 `orchestrator.spawnAgent()`。
- `new-session` 调用 `orchestrator.newAgentSessionFromAgent(sourceAgentId)`。
- 同一 pending intent 的并发提交共享一个 in-flight promise，最多启动一次。
- 成功后清除 pending intent、同步 agent snapshot、切换 active agent，再继续原输入。
- 失败后保留 pending intent并恢复 editor 内容，用户可以重试；错误沿现有
  application notice / diagnostic 路径显示。

首次普通消息和含 inline expansion 的消息先 materialize，再走现有
`CommandEngine` expansion 与 `promptAgent()` 路径。这样 skill/prompt template 的
解析仍可使用真实 agent profile/resources。

## 命令启动策略

Line command definition 增加交互层自己的 pending-agent 策略；该字段不进入 core：

- `materialize`：`/model`、`/thinking`、`/rename`。只有带有可执行参数的提交才
  materialize；仅打开命令或参数补全不能启动 agent。materialize 后继续调用现有
  core setter，因此 transcript/hydration 事实保持不变。
- `runtime`：`/quit`、`/exit`、`/session`、`/agent`、`/login`、`/logout`、
  `/resume`。它们不为了获得 command context 而创建默认 agent；`/resume` 只打开
  已存在的 persistent session。
- `active`：`/abort`、`/compact`、`/follow-up`、`/fork`、`/inspect`、
  `/reload`、`/status`、`/steer`、`/tree`。pending 状态下返回明确的
  “no active agent” 交互错误，不 materialize。

`/new` 是 application-owned 的 `runtime` command；其 handler 只替换 pending
intent，不调用 core。因而它不需要额外的 command policy 枚举值。

Command context 允许 runtime command 在没有 `agentId` 时执行；agent-scoped command
在类型和执行入口处收窄为必有 `agentId`。Autocomplete 在 pending 状态下可以列出
命令名和 runtime candidates；需要 agent 的 completion 不通过隐式 spawn 获取。
`/model` 使用现有全局 model candidates；`/thinking` 使用 pending 默认 model 的
supported levels。最终带参数提交仍由 core setter 做权威校验。

## `/new` 与导航

`/new` 从 orchestrator-backed built-in 调整为 TUI application action，因为它现在
表达的是“准备一个新 session”，不是立即创建 core agent。已有 agent 仍保留在
agent strip 中；pending view 不伪造 agent id，也不向 projector 注入虚假 lifecycle
event。

`/resume` 与 `/fork` 保持真实导航：

- `/resume` 可以从 pending view 直接打开已有 session，并清除 pending intent。
- `/fork` 必须有 active agent；fork 本身复制已有 session facts，因此不是空
  session 创建场景。

未来 `/spawn` 只需新增一种 `PendingAgentStart`（携带 profile/model 等创建参数），
不能直接在命令 execute 阶段调用 `spawnAgent()`。

## 错误与关闭

- Pending 状态关闭 TUI 时，`disposeAll()` 只处理已经存在的 agents；不会产生新
  session。
- Materialization 失败不创建 TUI 假 agent，pending intent 与 editor 输入保留。
- Setting command 在 materialize 前完成语法与候选校验；成功 spawn 后立即调用
  setter。Setter 失败使用现有 command error 呈现，不把失败的设置显示为已完成。
- Core spawn、session write 和 extension activation 的错误语义保持不变。

## 测试策略

1. Pending-agent coordinator：
   - 构造与 `/new` intent 都不调用 orchestrator。
   - default 首次 materialize 只调用一次 `spawnAgent()`。
   - new-session 首次 materialize 只调用一次
     `newAgentSessionFromAgent(sourceAgentId)`。
   - 并发 materialize 去重；失败保留 intent并可重试。
2. Command policy：
   - plain/inline prompt 与带参数 setting command 要求 materialize。
   - bare `/model`、bare `/thinking` 与 completion 不 materialize。
   - runtime/read-only command 不 materialize。
   - pending `/new` 替换 intent；pending active-only command 返回错误。
3. TUI/application 接入：
   - `run()` 不调用 `spawnAgent()`。
   - 首条消息 materialize 后只提交一次 prompt。
   - `/model`、`/thinking`、`/rename` materialize 后调用对应 setter。
   - `/new` 后直接退出不调用 `newAgentSessionFromAgent()`。
4. 回归验证：
   - session manager/core persistence 测试保持不变。
   - `npm --workspace apps/widi-pi run test`。
   - 仓库根 `npm run check`。

## 范围外

- 修改 Pi JSONL repo 或 WIDI `SessionManager` 的持久化时机。
- 改变 session 磁盘格式。
- 为 pending intent 建立可恢复草稿或在 agent selector 中长期保存多个 pending
  agents。
- 实现未来 `/spawn` 的参数与 UI；本次只保证策略可复用。
