# WIDI Multi-Agent 持久化设计

本文记录 WIDI multi-agent 系统的持久化边界、目录结构、fork/restore 语义，以及自定义 session storage 如何对接 Pi `AgentHarness`。

## 设计原则

- `AgentHarness` 仍然只表示单个 agent。
- 每个持久化 agent 拥有一个独立的 Pi `Session`。
- WIDI 的 run 是 multi-agent 的一致性边界，负责管理 agent registry、mailbox、checkpoint 和 run fork。
- 不修改 `pi/*`。WIDI 在 `apps/widi-pi` 内实现自己的 JSONL 或数据库后端。
- profile、resources、tool registry 在恢复时从当前配置重新构建；历史快照只用于审计和差异检测。
- 用户只能直接接触 main agent。fork/restore 的产品语义围绕 main 展示，但存储层必须复制 checkpoint 前存在的所有持久化 subagents。

## 推荐目录结构

```text
.widi/
  runs/
    <encoded-cwd>/
      <timestamp>_<runId>/
        run.json
        run.lock
        agent-events.jsonl
        checkpoints.jsonl
        mailbox.jsonl
        agents/
          <agentId>.jsonl
```

`<timestamp>_<runId>` 表示一次 multi-agent run，不表示单个 agent session。`agentId` 只在 run 内唯一，完整身份是 `(runId, agentId)`。

## 文件职责

`run.json` 保存 run 的稳定元数据：

- `runId`
- `cwd`
- `createdAt`
- `mainAgentId`
- `parentRunId`
- `forkedFromCheckpointId`
- schema version

`agent-events.jsonl` 是 append-only agent registry：

- `agent_created`
- `agent_status_changed`
- 后续可加入 `agent_unavailable`、`agent_deleted` 等事件

`checkpoints.jsonl` 是 append-only run 提交记录。checkpoint 不是会话内容副本，而是记录每个 agent 与 mailbox 的一致性位置。

`mailbox.jsonl` 保存 agent 间消息及投递事件。

`agents/<agentId>.jsonl` 保存单个 agent 的 Pi session tree。首行是 WIDI 自定义 header，后续每行直接写 Pi `SessionTreeEntry`。

## Agent 身份与 Profile

同一个 profile 可以在一个 run 内生成多个 agent。profile 只是构建模板，不能作为 agent 实例 ID。

`AgentProfile` 需要稳定唯一的 `id`：

```ts
type AgentProfile = {
  readonly id: string;
  readonly label: string;
  readonly persist?: boolean;
  // ...
};
```

`agentId` 在 run 生命周期内稳定且不可复用。agent 退出后也不把 ID 分配给新 agent。

`profileOverride` 必须持久化声明式内容。恢复时：

```ts
effectiveProfile = {
  ...currentProfile,
  ...profileOverride,
  defaultModel: { ...currentProfile.defaultModel, ...profileOverride.defaultModel },
  capabilities: { ...currentProfile.capabilities, ...profileOverride.capabilities },
};
```

`tools`、`skills`、`promptTemplates` 数组整体替换，不做拼接。

## Persist 与 Ephemeral Agent

profile 可以声明 `persist?: boolean`，默认 `false`。main agent 强制持久化，不能被 override 关闭。

持久化 agent：

- 写入 `agent-events.jsonl`
- 拥有 `agents/<agentId>.jsonl`
- 进入 checkpoint 与 run fork
- 可通过 restore 重建 harness

ephemeral agent：

- 使用 Pi `InMemorySessionRepo`
- 不写磁盘或数据库
- 不进入 `agent-events.jsonl`
- 不进入 checkpoint/fork
- 进程退出或崩溃后丢失
- 不允许使用 mailbox
- 不允许创建持久化子 agent

ephemeral agent 的结果必须写回调用方的持久化 session，例如 `custom_message` 或 tool result，包含 profile id、输入摘要、输出、失败信息和可选 usage。否则恢复 run 后 main 无法看到该一次性 agent 的产物。

`agent-as-tool` 与持久化策略是两个独立维度。agent-as-tool 可以是持久化 agent，也可以是 ephemeral agent。

## Agent 生命周期

推荐状态事件：

```text
created -> running -> idle -> completed | failed | cancelled | unavailable
```

`completed` 后可以释放 `AgentHarness`，但保留 session、mailbox 和 registry。继续工作时创建新的 `agentId`；只有 run restore 时允许用原 `agentId` 重建对应 harness。

如果恢复时 profile 或 tool 缺失：

- main agent 无法重建：拒绝恢复并报告缺失资源。
- subagent 无法重建：保留 session 与 registry，标记为 `unavailable`。
- 只有再次唤醒该 subagent 时才报错。

## Checkpoint

checkpoint 是 run 级一致性提交点，初版只在用户回合结束且所有 harness idle 后创建。

推荐时机：

1. main agent 收到用户消息。
2. main/subagents 完成该轮工作。
3. 所有 harness 进入 idle。
4. 所有 session、mailbox、agent events 写入完成。
5. 追加 checkpoint。

示例：

```json
{
  "id": "checkpoint-id",
  "sequence": 12,
  "createdAt": "2026-06-08T12:00:00.000Z",
  "trigger": "main_turn_completed",
  "agentLeaves": {
    "main": {
      "sessionId": "session-main",
      "leafId": "entry-123"
    },
    "researcher": {
      "sessionId": "session-sub",
      "leafId": "entry-456"
    }
  },
  "mailboxSequence": 38,
  "agentEventSequence": 4
}
```

checkpoint 主要记录：

- 当时存在哪些持久化 agent。
- 每个 agent 的 session ID 与提交 leaf。
- mailbox 的一致性边界。
- agent registry 的事件边界。

实际消息仍在各 agent 的 JSONL 中。

恢复时读取最后一条合法 checkpoint。checkpoint 之后的尾部数据默认不可见。对 session JSONL 不物理删除尾部，而是追加 Pi `leaf` entry，将活动 leaf 指回 checkpoint 记录的位置，之后新消息形成新分支。

## Fork

用户只能 fork 整个 run，不能直接 fork 单个 subagent session。UI 只展示 main agent 的用户回合，内部映射到对应 run checkpoint。

选择 main 的某条历史用户消息进行 fork 时，默认语义是在该消息之前 fork，并把原消息放回输入框供修改。实现上使用该消息前一个完整 checkpoint。如果用户想从该轮结果继续，则选择该轮完成后的 checkpoint。

fork 新 run 时采用物理复制：

- 创建新 `runId`。
- 保留 run 内的 `agentId`。
- 为每个持久化 agent 创建新 `sessionId`。
- 复制 checkpoint 前已存在的所有持久化 agents。
- 对每个 session 只复制 checkpoint leaf 路径上的 `SessionTreeEntry`。
- 截取 mailbox 到 checkpoint 的 `mailboxSequence`。
- 截取 agent registry 到 checkpoint 的 `agentEventSequence`。
- 新 run 独立追加，不依赖父 run 文件。
- `run.json` 记录 `parentRunId` 和 `forkedFromCheckpointId`。

恢复后只自动启动 main；subagent harness 可按需懒加载。

## Mailbox

mailbox 采用至少一次投递，并使用 `messageId` 去重。

- `mailbox.jsonl` 记录消息及投递事件。
- 投递后写入 recipient session 的 `custom_message`，携带 `messageId`。
- 恢复时检查 session 是否已有该 `messageId`，避免重复注入。
- checkpoint 记录已提交的 mailbox sequence。

跨多个 JSONL 文件不承诺 exactly-once。未来数据库后端可以通过事务提供更强保证。

## 并发与锁

初版只允许单进程独占写入同一个 run。

`run.lock` 放在 run 目录：

```json
{
  "pid": 12345,
  "createdAt": "2026-06-08T12:00:00.000Z",
  "cwd": "/root/projs/widi",
  "processStartHint": "..."
}
```

打开 run 写入前创建锁；正常退出删除。若锁存在且进程仍活着，则拒绝写入。若进程不存在，则视为 stale lock，接管前记录告警。

正常写入不需要 run 级全局串行化：

- 每个 `SessionStorage` 自己维护写队列或互斥锁，保证单个 JSONL append 顺序。
- mailbox 维护独立写队列。
- run 级协调锁仅用于 checkpoint、fork、创建 agent、更新 registry 等跨文件操作。

创建 checkpoint 时：

1. 阻止新的结构变更。
2. 等待所有 harness idle。
3. flush 各 session、mailbox、agent events。
4. 收集所有 leaf、mailbox sequence 和 agent event sequence。
5. 追加 checkpoint。

初版只保证进程崩溃恢复，不承诺断电后的物理落盘一致性。`ExecutionEnv.appendFile()` 没有暴露 `fsync`。若未来要求断电一致性，文件后端需要直接使用 Node 文件句柄，并在 checkpoint 前同步 session、mailbox、agent events，最后同步 checkpoint。

## WIDI Session JSONL

单 agent session 文件第一行使用 WIDI header：

```json
{
  "type": "widi_session",
  "version": 1,
  "sessionId": "session-id",
  "runId": "run-id",
  "agentId": "main",
  "createdAt": "2026-06-08T12:00:00.000Z"
}
```

后续每行直接序列化 Pi `SessionTreeEntry`，不再包裹 WIDI event envelope。mailbox、agent lifecycle、checkpoint 均保持独立日志。

metadata 形状：

```ts
interface WidiSessionMetadata {
  id: string;
  createdAt: string;
  runId: string;
  agentId: string;
  path: string;
}
```

其中 `id === sessionId`。`AgentHarness` 只关心 metadata 的 `id`，WIDI 管理层使用 `runId`、`agentId` 和 `path`。

打开 session 时初版接受全量加载，沿用 Pi `JsonlSessionStorage` 的缓存方式：

- `entries: SessionTreeEntry[]`
- `byId: Map<string, SessionTreeEntry>`
- `labelsById`
- `currentLeafId`

JSONL 仍是事实来源。数据库后端未来可以按需查询，不要求使用同样的内存策略。

### 损坏尾行处理

进程崩溃可能留下半行 JSONL。

- 仅最后一个非空行损坏：允许自动修复。保留最后合法换行位置，将损坏尾部保存到诊断文件，截断原 JSONL 到合法位置，再继续追加。
- 中间任意行损坏：判定 session 损坏，拒绝恢复。
- 不自动重写合法历史内容。

## 对接 AgentHarness 的自定义 Storage

`AgentHarness` 构造时接收的是已经创建好的 Pi `Session`：

```ts
new AgentHarness({
  env,
  session,
  tools,
  resources,
  model,
  thinkingLevel,
  activeToolNames,
});
```

因此数据库或自定义 JSONL 后端不需要传给 harness。它们需要先实现 Pi 的 `SessionStorage`，再构造：

```ts
const session = new Session(new WidiJsonlSessionStorage(...));
```

或者通过自定义 `SessionRepo.create()` / `open()` 返回 `Session`。

必须实现 Pi `SessionStorage<TMetadata>` 的全部方法：

```ts
interface SessionStorage<TMetadata extends SessionMetadata = SessionMetadata> {
  getMetadata(): Promise<TMetadata>;
  getLeafId(): Promise<string | null>;
  setLeafId(leafId: string | null): Promise<void>;
  createEntryId(): Promise<string>;
  appendEntry(entry: SessionTreeEntry): Promise<void>;
  getEntry(id: string): Promise<SessionTreeEntry | undefined>;
  findEntries<TType extends SessionTreeEntry["type"]>(
    type: TType,
  ): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>>;
  getLabel(id: string): Promise<string | undefined>;
  getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]>;
  getEntries(): Promise<SessionTreeEntry[]>;
}
```

各方法职责：

- `getMetadata()`：返回 `WidiSessionMetadata`。
- `getLeafId()`：返回当前活动 leaf，若 leaf 指向不存在 entry，应抛 `SessionError("invalid_session", ...)`。
- `setLeafId()`：追加一条 Pi `leaf` entry，记录活动 leaf 切换。用于 navigate、restore 到 checkpoint 和 branch。
- `createEntryId()`：生成不会与当前 session entry 冲突的 entry id。
- `appendEntry()`：append 一个 `SessionTreeEntry`，更新内存索引、label cache 和当前 leaf。
- `getEntry()`：按 entry id 查找。
- `findEntries()`：按 entry type 查找，用于 session name、custom entry、diagnostics 等能力。
- `getLabel()`：读取 label cache。
- `getPathToRoot()`：从 leaf 沿 `parentId` 回溯到 root，返回正序路径。`Session.buildContext()`、compaction、branch summary 和 fork 都依赖它。
- `getEntries()`：返回 session 内全部 entries 的拷贝，主要用于 list/fork/debug。

实现时应完整支持 Pi 会话树，不要简化成线性消息日志。`AgentHarness.navigateTree()`、compaction、branch summary、fork 都依赖 `parentId` 和 `leaf` 语义。

推荐参考 Pi 现有实现：

- `pi/packages/agent/src/harness/session/jsonl-storage.ts`
- `pi/packages/agent/src/harness/session/jsonl-repo.ts`
- `pi/packages/agent/src/harness/session/memory-storage.ts`
- `pi/packages/agent/src/harness/session/repo-utils.ts`

注意不要直接修改这些 upstream 文件。

## WIDI SessionRepo

`WidiJsonlSessionRepo` 绑定单个 run：

```ts
new WidiJsonlSessionRepo({
  fs,
  runId,
  runDir,
});
```

它管理 `agents/<agentId>.jsonl`，不负责跨 cwd 或跨 run 搜索。跨 run 列举、恢复和 fork 由 `RunStore` 与 `PersistenceManager` 负责。

推荐 create/open API：

```ts
interface WidiSessionCreateOptions {
  id?: string;
  agentId: string;
}

interface WidiSessionOpenOptions {
  agentId: string;
  sessionId: string;
}
```

`id` 允许内部指定，用于测试、导入和 run fork；普通 spawn 使用 uuidv7 生成。

底层可以实现 Pi `SessionRepo` 的 `fork()` 便于测试，但产品层只允许 run fork。单独 session fork 无法复制 agent registry、mailbox 和 checkpoint，不能作为 WIDI 用户功能。

## RunStore 与 PersistenceManager

推荐抽象：

```ts
interface PersistenceBackend {
  sessions: SessionRepo;
  runs: RunStore;
}
```

`SessionRepo` / `SessionStorage` 只负责单 agent 会话。

`RunStore` 负责：

- 创建/open/list/delete run
- 写 `run.json`
- 管理 `run.lock`
- append/read `agent-events.jsonl`
- append/read `mailbox.jsonl`
- append/read `checkpoints.jsonl`
- run fork 的物理复制

`PersistenceManager` 负责协调：

- 为 main 创建持久化 session
- 为 persist subagent 创建 session 与 agent event
- 为 ephemeral agent 创建 in-memory session
- 恢复 run 时根据 checkpoint 和 agent events 重建 main harness
- 懒加载 subagent harness
- 创建 checkpoint
- 执行 run fork

## 恢复 Harness 的初始状态

恢复持久化 agent harness 时：

- tools/resources 从当前配置重新加载。
- profile 通过 `profileId` 加载当前版本，再应用持久化 `profileOverride`。
- model/thinking/active tools 优先从 session branch 的 `buildContext()` 结果恢复。
- 如果 session branch 中没有对应 entry，则回退到当前 profile 默认值。

创建持久化 agent session 后应立即追加初始状态：

- `model_change`
- `thinking_level_change`
- `active_tools_change`

这样恢复时不依赖 profile 默认值，也能审计初始运行状态。
