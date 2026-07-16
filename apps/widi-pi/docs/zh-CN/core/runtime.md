# Runtime

本文记录 `widi-pi` runtime 的组成、所有权、生命周期和事件边界。它描述当前机制，不定义产品 UI 或实施计划。

## Orchestrator 的职责

`AgentOrchestrator` 是 runtime coordinator。它把 profile、session、resources、tools、models、extensions、command input 与 clients 组合成可运行的 agent runtime。

Agent 由 `AgentId` 标识，并由 profile reference、Pi `AgentHarness`、session、model、resolved dependencies、extensions、diagnostics 和 lifecycle status 共同构成。当前状态集合为：

- `creating`
- `running`
- `idle`
- `unavailable`
- `disposed`

Orchestrator 拥有：

- agent create、resume、runtime mutation 和 dispose。
- agent record 与 public snapshot。
- harness event 订阅和 client fanout。
- command input 的执行状态机。
- human-request collaborator 的挂载与对外能力入口。
- dependency diagnostics 的上下文补充与统一发布。
- extension runner 与 harness、command、session context 的绑定。

Orchestrator 不直接解析 profile、resource、extension module、tool definition、model config 或 auth file。解析与局部 diagnostic 应由对应 registry、loader 或 runtime module 完成。

## Runtime 模块

### Shared protocol

`core/types.ts` 只承载多个 core peer 共同消费、且没有更具体 owner 的事实，例如 `AgentId`、lifecycle status、runtime model、tool snapshot 与 orchestrator events。

Owner-local config、result、record 和私有状态跟随其模块，不为缩短文件而迁入通用 `*-types.ts` bucket。

### Dependency layer

- `SettingManager`：global/project settings、project trust、runtime override 与 flush。
- `AgentProfileRegistry`：profile discovery、identity、priority、validation 与 diagnostics。
- `ResourceLoader`：skills、prompt templates 及其 source provenance。
- `SessionManager`：persistent/in-memory Pi session 的创建、恢复和 agent 关联。
- `ToolRegistry`：tool definition、patch、visibility、active state 与 Pi adapter。
- `ExtensionLoader`：extension discovery、module load、版本检查和 per-agent activation。
- `ModelRegistry` / `AuthStorage`：pi-ai Models runtime、models.json、provider 与 credential。

Dependency layer 产生事实和 diagnostics，但不拥有 agent lifecycle。

### Runtime collaborators

拥有独立状态机或生命周期的能力可以成为 collaborator，例如 `HumanRequestBroker`。Collaborator 通过 narrow host 请求 event emit、diagnostic publish 或 client lookup，不 import `AgentOrchestrator` implementation，也不接触 agents/clients map。

新的 collaborator 应满足至少一个条件：拥有独立状态或生命周期；多个调用点重复同一状态机；或者能通过 narrow host 与 orchestrator 解耦。单行 helper、单一消费者类型和纯粹为缩短文件的搬迁不构成拆分理由。

## Runtime composition

应用入口按以下顺序组装 runtime：

1. 确定 cwd、agent dir、project config dir、session root 与 `ExecutionEnv`。
2. 加载 global/project settings，应用 project trust 与 runtime overrides。
3. 创建 config resolver、auth/model、profile/resource/session/tool/extension services。
4. 解析 defaults 并收集 startup diagnostics。
5. discover/load extension catalog。
6. 创建 `AgentOrchestrator`，注入 dependency layer、defaults 与 runtime collaborators。
7. 返回 services、orchestrator 和 startup diagnostics。

Runtime composition 不创建产品 UI，也不决定 team、flow、goal 等交互模式。

## Agent create 与 resume

Orchestrator 是唯一 lifecycle owner。创建或恢复的主路径为：

1. 解析 profile、model、thinking level 与 session reference。
2. 建立 `creating` agent record。
3. 创建或恢复 Pi session。
4. 激活 profile 声明的 extension runner。
5. 合并 profile/core resources 与 extension resource contributions。
6. 将 extension tool definitions/patches replay 到 scoped ToolRegistry。
7. resolve visible/active tools 与 diagnostics。
8. 注册 extension provider contributions，并创建 Pi `AgentHarness`。
9. 绑定 scoped actions、command context、session custom entry 与 interceptors。
10. 订阅 harness events，发布 `agent_spawned` 或 `agent_resumed`。
11. record 进入可运行状态；可恢复的 subagent 失败可以保留为 `unavailable`。

Profile missing、disabled、duplicate、invalid 或 version-incompatible extension 会按当前 policy 结构化失败，不回退到默认 profile。

## Command input

### 两类入口

Orchestrator 原子方法是 programmatic capability 的唯一事实。Adapter、extension actions、collaboration tools 和测试直接调用原子方法。

`inputAgent(agentId, text, options)` 是人类输入入口。Command 是这条输入路径上的 trigger-based 协议，不是另一套 programmatic API。

### 执行顺序

1. Extension `input` interceptor 在 command 解析前运行；改写结果重新进入完整解析，block 或 handler failure 均 fail-closed。
2. 整行 line command 先匹配；未命中时扫描 inline commands；仍未命中则按普通 prompt 处理。
3. 命中的 command 发布 `command_detected`。
4. Gateway 检查 profile command policy、scope 和 agent status。
5. 必填参数缺失时通过 `argumentsCompletion` human request 补全，并在等待后复查 gateway。
6. 发布 `command_accepted`，执行 built-in binding、extension line handler 或 inline expand。
7. 成功发布 `command_completed`，其 `result` 与 `InputResult.value` 使用同一返回值；执行前拒绝发布 `command_rejected`；执行中失败发布 `command_failed`。Extension handler 可以在完成前顺序发布 append-only `extension_output`。

Line 与 inline command 共享 gateway、参数补全和事件语义。一个输入中的 inline expansion 按出现顺序执行；任一命中项失败时不发送半展开 prompt。

模型看到的展开后文本进入 user message。人类原始输入与 expansion/transform 位置进入 `core:command_expansion` 或 `core:input_transform` custom entry，使 resume/fork 后仍可解释当时事实。

Core 不建立 `CommandRegistry` 类。当前来源只有静态 built-in bindings 与 per-agent extension contributions，没有 patch/override 语义，惰性查询足以保持事实新鲜。出现第三种构建期 command 来源，或需要 command patch/override 时，再复议 resolver/registry。

## Human request

`HumanRequestBroker` 拥有 request id、pending map、timeout、abort、cancel 和 `human_request_*` event。Orchestrator 提供 narrow host，并通过统一入口授权调用。Broker 在 handler 运行前解析请求来源的 `agentId`，同一值写入 `HumanRequestEnvelope` 与全部 `human_request_*` events；envelope 不携带调用方 `signal`，handler 只通过独立参数接收 broker-owned signal。

Human request 选择第一个可处理请求的 client；跨 client 路由语义随真实 multi-agent 场景定义。Pending request 是 runtime-local state，不进入 session。只有 request 作为 tool result 的一部分时，response 才自然进入 Pi session tree。

## Extension execution points

当前 extension 插入点包括：

- Activation：tool、patch、line/inline command、resource、provider、observer 与 interceptor contributions。
- Interceptors：`before_agent_start`、`context`、`before_provider_request`、`tool_call`、`tool_result`、`input`。
- Observers：raw `agent_harness_event`，以及 command、human request、diagnostic、agent/session、input canonical facts。
- Scoped actions：own-agent model、thinking、tools、input、human request、ephemeral client output、session info、exec、abort、compact 等受控能力。
- Session command context：受 profile capability 与 idle state 门控的 new/fork/resume/tree 操作。
- Session custom entry：namespaced、append-only、current-branch state。

Extension 不能直接持有 orchestrator、raw agents map 或跨 agent 句柄。跨 agent 能力通过 collaboration facade 进入统一主路径。

## 事件边界

Pi `AgentHarnessEvent` 通过 `agent_harness_event` 原样传递：

```text
AgentHarnessEvent
  -> update agent record status
  -> orchestrator listeners
  -> clients
  -> own-agent extension observers
```

Core 不维护第二套 tool lifecycle facts。Assistant tool-call streaming 和 `tool_execution_*` 的 arguments、partial result、result 与 provider-specific 数据均由 raw event 保留。

Canonical orchestrator facts（command、human request、diagnostic、agent/session、input、extension output）经同一 `_emit()` 路径发送。`extension_output` 只发送给 listeners/clients，并在调用点显式关闭 extension observer 回灌。其他 observer failure 不改变原操作结果；它产生 `extension.handler_failed` diagnostic。Diagnostic observer 处理中产生的新 diagnostic 不回灌 extension observer，避免递归。

Harness status 更新遵循事实事件：run/turn 开始进入 `running`；结束、abort 或 settled 回到 `idle`；dispose 解绑 harness/extension、取消 pending request 并进入 `disposed`。

## Persistence boundary

Pi session tree 保存单 agent messages、tool calls/results、model/thinking/tools change、compaction 与 branch。以下内容不进入 session body：

- agent lifecycle/status。
- command/client event log。
- append-only `extension_output` client event。
- pending human request。
- extension runner instance 或大型 extension database。
- runtime objects、API keys 和 tool closures。

小型 recovery reference 可以进入 session metadata。Built-in tool 的可恢复上下文进入 tool call arguments、result `content` 和 typed `details`。Extension 小型 session-local state 使用 namespaced custom entry。

## 非职责

- 不定义 UI/RPC 呈现。
- 不重建 Pi harness queue 或 session state。
- 不让 ToolRegistry 负责 extension activation。
- 不让 command input 成为 programmatic API。
- 不为产品模式提供通用多 session state。
