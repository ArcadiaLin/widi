# Session Storage 设计

本文记录 `apps/widi-pi/src/storage/jsonl-repo.ts`、`jsonl-storage.ts` 与 `apps/widi-pi/src/core/session-manager.ts` 当前已经落地的 session 处理方式。

## 设计定位

当前实现不是新的 session 协议，也不在 JSONL 中声明应用专属的 session 类型。它只是把 Pi 的 JSONL session storage 临时复制到 `apps/widi-pi/src/storage`，保留 Pi 的 session tree 语义，并在首行 session header 上增加一个通用 `metadata` 对象。

这样做的原因是：

- `pi/*` 是上游/vendor 代码，当前不直接修改。
- `AgentHarness` 仍然只需要 Pi 的 `Session` 与 `SessionTreeEntry`。
- resume harness 时除了 message tree，还需要知道创建 harness 的外部上下文，例如 `AgentProfile`。
- Pi 当前 JSONL header 没有自定义 metadata 扩展点，因此先在应用侧使用本地 adapter。

核心边界是：自定义 storage 不包裹、不改写、不重新定义后续 session entries；它只扩展首行 header，并补充当前应用需要的路径规划。

## 文件格式

JSONL 文件仍然采用“首行 header，后续每行一个 session tree entry”的格式：

```text
<session header json>
<SessionTreeEntry json>
<SessionTreeEntry json>
...
```

首行 header 当前形状：

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

`type: "session"` 与 `version: 3` 沿用 Pi JSONL session header 的语义。`metadata` 是本地 adapter 增加的额外头信息，不是新的 envelope，也不是应用命名空间。

当前导出的相关类型：

- `JsonlSessionHeaderMetadata`
- `ExtendedJsonlSessionMetadata`
- `ExtendedJsonlSessionCreateOptions`
- `ExtendedJsonlSessionListOptions`
- `JsonlSessionPathLayout`

当前只有 `metadata.profile` 已经写入。它保存的是创建持久 session 时使用的 profile 引用。`id` 用于 resume 时重新加载当前 profile，`label` 只是列表展示和诊断快照。

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

这些 entry 继续由 `AgentHarness` 追加和消费。storage 只负责 append、索引、label cache、leaf 切换和 `getPathToRoot()` 等 `SessionStorage` 接口要求的行为。

规划中的 WIDI session fact 不新增 Pi session entry type。它应复用 Pi 已有的 `custom` entry。Tool-owned fact 的 `namespace` 直接使用 tool name，并在落盘时映射为 Pi `customType`；extension/core-owned fact 可以使用自己的稳定 namespace：

```json
{
  "type": "custom",
  "customType": "write",
  "data": {
    "source": "tool",
    "sourceName": "write",
    "factType": "preview",
    "version": 1,
    "toolCallId": "call_123",
    "payload": {}
  }
}
```

Pi storage 只负责原样保存和读回 `custom` entry。WIDI 在其上提供 session fact 恢复层：`namespace`、`source`、`sourceName`、`factType`、`version` 和 `payload` 共同标识一类可恢复事实。Tool 与 extension 都可以通过受控 API 追加这类 fact，并在 resume 时通过 `SessionFactDefinition.restore` 恢复 typed state。缺少 fact definition 时不丢弃、不解释，只作为原始 `custom` entry 留在 session tree 中，并可通过 `SessionFactStore.find()` 读回。

Session fact 适合保存和当前 session 分支强相关的小型事实，例如 tool call preview、sandbox artifact reference、extension checkpoint reference。它不适合保存 API key、runtime object、大型 artifact 正文、多 session index 或 extension 私有数据库。

因此当前实现保持了 Pi 会话树能力：

- 分支不是线性日志，而是通过 `parentId` 和 `leaf` 表达。
- `setLeafId()` 通过追加 `leaf` entry 改变当前活动分支。
- `Session.buildContext()` 可以从当前 leaf 恢复 messages、model、thinking level 和 active tools。
- fork 时可以复制目标 leaf 到 root 的路径，而不是复制整份文件。

## 路径规划

`JsonlSessionRepo` 当前支持两种 `pathLayout`：

- `by-cwd`：默认值，按 cwd 编码后分目录。
- `flat`：所有 session 文件直接放在 `sessionsRoot` 下。

`by-cwd` 路径示例：

```text
<sessionsRoot>/--workspace-project--/<timestamp>_<sessionId>.jsonl
```

`flat` 路径示例：

```text
<sessionsRoot>/<timestamp>_<sessionId>.jsonl
```

这是临时路径规划入口，不是长期协议。后续如果 extension 或 preset 需要管理多个 session，可以在自己的存储中引用这些 session 文件，例如：

```text
<extensionStateRoot>/agents/<agentId>/session.jsonl
```

或者：

```text
<extensionStateRoot>/sessions/<agentId>.jsonl
```

当前代码只承诺 `ExtendedJsonlSessionMetadata.path` 可以用于重新打开对应文件，不承诺目录形状长期稳定。

## SessionManager 集成

`SessionManager` 现在负责在 orchestrator 与 session repo 之间做一层应用级协调：

- 持久 session 使用本地 `JsonlSessionRepo`。
- 临时 session 使用 Pi 的 `InMemorySessionRepo`。
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

创建临时 session 时不会写 JSONL，也没有扩展 header metadata。

resume 持久 session 时，调用方传入 `ExtendedJsonlSessionMetadata`，`SessionManager` 通过 `sessionRepo.open(metadata)` 打开文件，并把结果缓存到 `_agentSessions`。

## 当前允许的处理

当前 storage adapter 已经允许这些操作：

- `create()` 创建持久 JSONL session，并写入扩展 header metadata。
- `list()` 只读取每个 JSONL 文件首行，快速得到 session id、cwd、path、parent 和 metadata。
- `open()` 读取完整 session tree，恢复为 Pi `Session`。
- `delete()` 删除 session 文件。
- `fork()` 复制源 session 的目标分支路径，并默认继承源 header metadata。
- `SessionManager.createAgentSession()` 根据 profile 的 `persist` 决定使用 JSONL 还是 in-memory。
- `SessionManager.resumeAgentSession()` 根据 metadata 打开已有 JSONL session。

这给后续 orchestrator resume 留出的目标流程是：

1. 通过 `sessionRepo.list()` 或上层 index 得到候选 `ExtendedJsonlSessionMetadata`。
2. UI、RPC 或 CLI 选择一个 metadata。
3. `SessionManager.resumeAgentSession({ agentId, metadata })` 打开 session。
4. `AgentOrchestrator` 从 `metadata.metadata?.profile?.id` 得到 profile id。
5. profile loader 或 profile registry 按 id 加载当前 profile；如果 profile 已删除，回退到 `defaultProfile`。
6. `session.buildContext()` 从当前 leaf 恢复 messages、model、thinking level 和 active tools。
7. orchestrator 用恢复出的 profile、model 和 session 创建新的 `AgentHarness`。

第 4-6 步属于 orchestrator resume 分支，storage 已经准备好数据，但 orchestrator 侧还需要继续接入。

## Metadata 使用原则

`metadata` 应只保存 resume harness 所需的、小型、可 JSON 序列化的信息。

当前建议：

- 可以保存 `profile` 引用，例如 `{ id, label }`。
- 可以未来保存 profile version、resource snapshot id、runtime profile id 等稳定引用。
- 不保存 API key、OAuth token、临时环境变量、ExecutionEnv 实例、函数或大型资源正文。
- 不把 `metadata` 当作事件日志；会随时间增长的内容应进入独立 log 或 session entries。
- 不在 metadata 里声明新的 session type；session type 仍然是 header 的 `type: "session"`。
- 不把 tool/extension 的可恢复运行事实塞进 metadata；这些事实应进入 session fact 或 extension-owned storage。

现在选择保存 profile id，是为了让 session header 只记录可恢复的外部上下文引用。`label` 不参与匹配。system prompt、skills、prompt templates、resources 等由当前 profile 加载流程重新生成。

## Profile Loader 骨架

`apps/widi-pi/src/core/agent-profile.ts` 已经提供 `AgentProfileLoader` 骨架。它使用 `ExecutionEnv` 从 agent dir 与 project `.widi/profiles` 加载 profile，并返回 profiles 与 diagnostics。orchestrator 如何消费 profile、resources、extensions 与 diagnostics 的后续设计记录在 `apps/widi-pi/docs/profile-orchestration.md`。

当前 loader 只建立边界：

- markdown body 暂时作为 `systemPrompt`。
- frontmatter 暂时读取 `id`、`label`、`description`、`persist`、`tools`、`skills`、`promptTemplates`、`extensions`、`missingExtensionSeverity`。
- diagnostics 使用 `file_info_failed`、`list_failed`、`read_failed`、`parse_failed`、`invalid_metadata`。
- 复杂 YAML schema、profile 继承、资源引用校验、按 id registry 查询等后续再补。

resume 时 storage 不直接加载 profile。它只暴露 `metadata.profile.id`，由 orchestrator 或更高层 profile registry 使用 loader 查找当前 profile。找不到时，当前策略是回退到 `defaultProfile`，并在 orchestrator 侧产生诊断或事件。

## 暂不处理

当前实现刻意不解决这些问题：

- 多进程文件锁。
- header metadata schema 迁移。
- profile registry 与 profile snapshot 的最终取舍。
- extension/preset 级多 session index。
- agent lifecycle、checkpoint 等 extension/preset 级存储。
- 删除 session 时与未来 extension/preset 存储的同步。
- 与 Pi upstream JSONL storage 的自动兼容测试。

这些问题都应等 orchestrator、profile registry、runtime service 与 extension/preset 编排边界更稳定后再收敛。

## 未来收敛

架构稳定后可以从三个方向收敛。

1. 回到 Pi storage

   如果 Pi upstream 后续支持自定义 header metadata 或 storage hooks，可以删除本地 adapter，改用 upstream `JsonlSessionRepo`，只通过官方扩展点写入 `metadata.profile` 或其后继结构。

2. 保留本地 JSONL adapter

   如果应用需要长期保留自己的路径布局、metadata schema、锁策略或迁移机制，可以把当前 adapter
   正式整理为应用 storage backend，并补齐 schema version、migration、文件锁和损坏尾行处理。

3. 抽象为 extension/preset session persistence backend

   如果 extension 或 preset 最终需要 checkpoint 或数据库后端来管理多个 session，可以保留 Pi 的 `Session`/`SessionTreeEntry` 语义，把 JSONL 文件实现藏在 persistence backend 后面。这样 `AgentHarness` 仍然只看到 `Session`，orchestrator 看到的是单个 agent 的 session metadata API。

当前阶段选择本地 JSONL adapter，是为了在不修改 `pi/*` 的前提下，让 session header 能携带恢复 harness 所需的额外 metadata。这个选择应保持克制：只扩展 header，不改变 Pi session tree 行为。
