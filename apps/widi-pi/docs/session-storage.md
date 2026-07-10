# Session Storage 设计

本文记录 `apps/widi-pi/src/core/session-manager.ts` 当前已经落地的 session 处理方式。WIDI 现在直接使用 `@earendil-works/pi-agent-core` 的 JSONL session repo/storage，不再维护 `apps/widi-pi/src/storage` 本地 adapter。

## 设计定位

当前实现不是新的 session 协议，也不在 JSONL 中声明应用专属的 session 类型。它沿用 Pi 的 JSONL session storage、`Session` 和 `SessionTreeEntry` 语义，只在创建持久 session 时通过上游支持的 header `metadata` 写入恢复 harness 所需的小型 reference。

核心边界是：

- `AgentHarness` 仍然只需要 Pi 的 `Session` 与 `SessionTreeEntry`。
- WIDI 不包裹、不改写、不重新定义 session entries。
- Header `metadata` 是 opaque JSON object；storage 只保存和读回，不解释业务 shape。
- `metadata.profile` 的形状校验由消费方完成（`agent-profile.ts` 的 `parseAgentProfileReference`）。

## 文件格式

JSONL 文件采用“首行 header，后续每行一个 session tree entry”的格式：

```text
<session header json>
<SessionTreeEntry json>
<SessionTreeEntry json>
...
```

首行 header 形状：

```json
{
  "type": "session",
  "version": 3,
  "id": "main",
  "timestamp": "2026-06-13T00:00:00.000Z",
  "cwd": "/workspace",
  "parentSession": "/path/to/parent.jsonl",
  "metadata": {
    "profile": {
      "id": "main",
      "label": "Main Agent"
    }
  }
}
```

`type: "session"` 与 `version: 3` 沿用 Pi JSONL session header 的语义。`metadata` 是 Pi JSONL header 的通用自定义 metadata 字段，不是新的 envelope，也不是应用命名空间。

当前直接使用上游相关类型：

- `JsonlSessionMetadata`
- `JsonlSessionCreateOptions`
- `JsonlSessionListOptions`
- `JsonlSessionRepo`

当前只有 `metadata.profile` 由 WIDI 写入。它保存的是创建持久 session 时使用的 profile 引用。`id` 用于 resume 时重新加载当前 profile，`label` 只是列表展示和诊断快照。

## Entry 语义

header 之后的每一行仍然是 `@earendil-works/pi-agent-core` 的 `SessionTreeEntry`：

- `message`
- `model_change`
- `thinking_level_change`
- `active_tools_change`
- `compaction`
- `branch_summary`
- `custom`
- `custom_message`
- `label`
- `leaf`

这些 entry 继续由 Pi `AgentHarness` 追加和消费。storage 只负责 append、索引、label cache、leaf 切换和 `getPathToRoot()` 等 `SessionStorage` 接口要求的行为。

WIDI core 不新增 session entry type，也不为 built-in tools 增加额外的 session persistence facade。Built-in tool 的可恢复数据应进入 Pi 已有的 tool call arguments、tool result `content` 和 typed `details`。

Pi 的 `custom` entry 仍是 session tree 的合法 entry，storage 负责原样保存和读回：

```json
{
  "type": "custom",
  "customType": "example.extension",
  "data": {
    "version": 1
  }
}
```

WIDI core 当前不解释 `custom` entry 的 data shape。Extension runner 已提供 `ctx.session.appendEntry()` / `findEntries()` MVP，用于和当前 session tree 强相关的小型 extension 状态。当前 API 只开放 extension namespace 下的 append-only `custom` entries，并按 current branch path 读取。fork、schema validation、diagnostics、compaction/export/debug policy 仍需在 extension API 中继续定义。大型 artifact、多 session index、产品模式状态仍属于 extension-owned storage。

因此当前实现保持了 Pi 会话树能力：

- 分支不是线性日志，而是通过 `parentId` 和 `leaf` 表达。
- `setLeafId()` 通过追加 `leaf` entry 改变当前活动分支。
- `Session.buildContext()` 可以从当前 leaf 恢复 messages、model、thinking level 和 active tools。
- fork 时可以复制目标 leaf 到 root 的路径，而不是复制整份文件。

## 路径规划

WIDI 不再维护应用侧 `pathLayout`。持久 session 路径由 Pi `JsonlSessionRepo` 决定，当前按 cwd 编码后分目录：

```text
<sessionsRoot>/--workspace-project--/<timestamp>_<sessionId>.jsonl
```

当前代码只承诺 `JsonlSessionMetadata.path` 可以用于重新打开对应文件，不承诺目录形状长期稳定。历史本地 adapter 曾支持 flat layout；如需长期读取这类旧文件，应单独设计迁移或兼容入口。

## SessionManager 集成

`SessionManager` 负责在 orchestrator 与 session repo 之间做一层应用级协调：

- 持久 session 使用 Pi `JsonlSessionRepo`。
- 临时 session 使用 Pi `InMemorySessionRepo`。
- 已打开的 session 按 `agentId` 缓存在 `_agentSessions` 中。

创建持久 session 时，`SessionManager` 会把 profile 引用写入 header metadata：

```ts
this.sessionRepo.create({
  id: options.agentId,
  cwd: this._cwd,
  parentSessionPath: options.parentSessionPath,
  metadata: {
    profile: {
      id: options.agentProfile.id,
      label: options.agentProfile.label,
    },
  },
});
```

创建临时 session 时不会写 JSONL，也没有 header metadata。

resume 持久 session 时，调用方传入 `JsonlSessionMetadata`，`SessionManager` 通过 `sessionRepo.open(metadata)` 打开文件，并把结果缓存到 `_agentSessions`。

## 当前允许的处理

当前 session repo 已经允许这些操作：

- `create()` 创建持久 JSONL session，并写入 header metadata。
- `list()` 只读取每个 JSONL 文件首行，快速得到 session id、cwd、path、parent 和 metadata。
- `open()` 读取完整 session tree，恢复为 Pi `Session`。
- `delete()` 删除 session 文件。
- `fork()` 复制源 session 的目标分支路径，并默认继承源 header metadata。
- `SessionManager.createAgentSession()` 根据 profile 的 `persist` 决定使用 JSONL 还是 in-memory。
- `SessionManager.resumeAgentSession()` 根据 metadata 打开已有 JSONL session。

orchestrator resume 流程：

1. 通过 `sessionRepo.list()` 或上层 index 得到候选 `JsonlSessionMetadata`。
2. UI、RPC 或 CLI 选择一个 metadata。
3. `SessionManager.resumeAgentSession({ agentId, metadata })` 打开 session。
4. `AgentOrchestrator` 从 `metadata.metadata?.profile?.id` 得到 profile id。
5. profile registry 按 id 加载当前 profile；如果 profile 缺失、禁用、重复或无效，由 orchestrator 产生结构化 diagnostic 并停止恢复。
6. `session.buildContext()` 从当前 leaf 恢复 messages、model、thinking level 和 active tools。
7. orchestrator 用恢复出的 profile、model 和 session 创建新的 `AgentHarness`。

当前 orchestrator resume 分支已经接入第 4-7 步的基础路径：它会读取 profile reference，通过 `AgentProfileRegistry` 恢复 profile，读取 session context 中的 model、thinking level 和 active tools，并创建新的 `AgentHarness`。profile 缺失不再回退到 default profile。Profile/resource diagnostics 会通过 orchestrator `diagnostic` event 发布。active tools 会经过当前 tool registry 重新校验，缺失、重复或不可见工具会产生 tool diagnostics。

## Metadata 使用原则

`metadata` 应只保存 resume agent 所需的、小型、可 JSON 序列化的信息。

当前建议：

- 可以保存 `profile` 引用，例如 `{ id, label }`。
- 可以未来保存 profile version、resource snapshot id、runtime profile id 等稳定引用。
- 不保存 API key、OAuth token、临时环境变量、ExecutionEnv 实例、函数或大型资源正文。
- 不把 `metadata` 当作事件日志；会随时间增长的内容应进入独立 log 或 session entries。
- 不在 metadata 里声明新的 session type；session type 仍然是 header 的 `type: "session"`。
- 不把 tool/extension 的可恢复运行数据塞进 metadata；built-in tool 使用 Pi tool result details，extension 根据作用域选择 custom entry 或 extension-owned storage。

现在选择保存 profile id，是为了让 session header 只记录可恢复的外部上下文引用。`label` 不参与匹配。system prompt、skills、prompt templates、resources 等由当前 profile 加载流程重新生成。

## Profile Registry

`apps/widi-pi/src/core/agent-profile.ts` 已经提供 `AgentProfileRegistry`、file/in-memory/composite storage backend，以及低优先级 builtin default profile source。Registry 按 `ProfileId` 建 lazy metadata index，处理 source priority、同级 duplicate、parse/validation diagnostics 和 id/filename mismatch。

当前 registry 建立的边界：

- markdown body 暂时作为 `systemPrompt`。
- frontmatter 暂时读取 `id`、`label`、`description`、`persist`、`tools`、`skills`、`promptTemplates`、`extensions`、`missingExtensionSeverity`。
- diagnostics 已覆盖文件读取、parse、metadata validation、duplicate id、source override、profile missing/disabled 等第一版 code。
- 复杂 YAML schema、profile 继承和资源引用校验后续再补。

resume 时 storage 不直接加载 profile。它只暴露 opaque 的 header metadata，orchestrator 先用 `parseAgentProfileReference` 收窄出 `metadata.profile.id`，再使用 profile registry 查找当前 profile。引用缺失、找不到、被禁用或解析失败时，orchestrator 产生 policy-driven diagnostic，并且不创建 harness。

## 暂不处理

当前实现刻意不解决这些问题：

- 多进程文件锁。
- header metadata schema 迁移。
- 历史 flat layout session 文件迁移。
- profile registry 与 profile snapshot 的长期版本化策略。
- extension/preset 级多 session index。
- agent lifecycle、checkpoint 等 extension/preset 级存储。
- 删除 session 时与未来 extension/preset 存储的同步。

这些问题都应等 orchestrator、profile registry、runtime service 与 extension/preset 编排边界更稳定后再收敛。
