# Diagnostics

Diagnostics 是 core 的一等输出。它让 profile、dependency、runtime 和 extension 问题可见、可测试、可恢复。

## 核心理念

Diagnostic 是事实记录。

Diagnostic 不是 UI 文案，也不是普通 log line。它记录 profile、dependency、runtime 或 extension 问题的结构化事实。Throw 只是处理 error diagnostic 的一种控制流，不是 diagnostic 的替代品。

失败不应静默降级。

Profile 缺失、resource 重复、extension 缺失、tool 不可用、model auth 失败，都应该产生结构化 diagnostic。是否继续运行由 severity 和 policy 决定。

Diagnostics 不属于 UI。

Orchestrator、registry、loader 和 extension runner 负责产生结构化 diagnostics。TUI/RPC/CLI adapter 负责展示它们。

Diagnostics 应贯穿 runtime。

至少需要覆盖三类问题：

- Profile diagnostics：profile 文件、schema、metadata、fallback、override。
- Dependency diagnostics：resources、extensions、tools、models 的解析问题。
- Runtime diagnostics：extension activation、tool execution policy、auth/runtime boundary、client delivery。

Diagnostic code 应带 namespace。

`code` 使用字符串，而不是一个不断膨胀的全局 union。命名使用 `domain.problem` 形式，例如：

- `profile.missing`
- `profile.duplicate_id`
- `resource.explicit_missing`
- `tool.requested_missing`
- `extension.activation_failed`
- `model.auth_missing`
- `command.not_permitted`

Domain 是稳定分类，code 是稳定机器可读原因。UI 可以按 domain/code 做本地化、分组、过滤或帮助链接。

Diagnostic source 应标准化。

不同模块不能各自暴露不兼容的 source shape。Core diagnostic source 应能表达 path、profile、resource、tool、extension、settings、operation 和 registry entry。模块内部可以保留自己的 source 类型，但进入 orchestrator event、runtime service 或 public result 时需要转换成统一 source。

建议第一版核心类型：

```ts
type DiagnosticSeverity = "info" | "warning" | "error";

type DiagnosticDisposition =
  | "reported" // 已记录，不影响当前流程
  | "degraded" // 当前流程继续，但功能降级
  | "blocked"; // 当前流程被阻止

type DiagnosticDomain =
  | "orchestrator"
  | "profile"
  | "resource"
  | "tool"
  | "model"
  | "auth"
  | "settings"
  | "extension";

type DiagnosticMessageParam = string | number | boolean | null;

type DiagnosticSource =
  | { kind: "path"; path: string; label?: string }
  | { kind: "profile"; id: string; label?: string }
  | { kind: "resource"; id?: string; resourceType?: string; path?: string; label?: string }
  | { kind: "tool"; name: string }
  | { kind: "extension"; id: string; label?: string; version?: string; path?: string }
  | { kind: "settings"; scope: "global" | "project" }
  | { kind: "operation"; source: OperationSource }
  | { kind: "registry"; name: string; key?: string };

interface DiagnosticRelated {
  source?: DiagnosticSource;
  message?: string;
  details?: Record<string, unknown>;
}

interface CoreDiagnostic {
  id?: string;
  domain: DiagnosticDomain;
  code: string;
  severity: DiagnosticSeverity;
  disposition: DiagnosticDisposition;
  recoverable: boolean;

  message: string;
  messageTemplate?: string;
  messageParams?: Record<string, DiagnosticMessageParam>;

  source?: DiagnosticSource;
  targetSource?: DiagnosticSource;
  requestedBy?: DiagnosticSource;
  related?: DiagnosticRelated[];

  phase?: "load" | "resolve" | "create" | "resume" | "runtime";

  agentId?: string;
  commandId?: string;
  requestId?: string;
  profileId?: string;
  resourceId?: string;
  toolName?: string;
  extensionId?: string;
  provider?: string;
  modelId?: string;

  details?: Record<string, unknown>;
}
```

`message` 是可直接展示或记录的 fallback 字符串。`messageTemplate` 与 `messageParams` 用于 UI/RPC 做本地化、富文本或更稳定的测试。Template 第一版只支持 `{name}` 占位符，params 只允许 JSON scalar，不在 template 中做复数、条件或格式化逻辑。

`severity` 与 `disposition` 分开。

`severity` 描述问题本身的严重程度。`disposition` 描述当前 caller/policy 如何处理这条 diagnostic。一个 `error` 不一定阻断当前流程。

示例：

```ts
{
  domain: "extension",
  code: "extension.activation_failed",
  severity: "error",
  disposition: "degraded",
  recoverable: true,
  message: "Extension github failed to activate; continuing without it.",
  messageTemplate: "Extension {extensionId} failed to activate; continuing without it.",
  messageParams: { extensionId: "github" },
  extensionId: "github"
}
```

```ts
{
  domain: "profile",
  code: "profile.duplicate_id",
  severity: "error",
  disposition: "blocked",
  recoverable: true,
  message: "Profile reviewer has duplicate definitions at the same priority.",
  messageTemplate: "Profile {profileId} has duplicate definitions at the same priority.",
  messageParams: { profileId: "reviewer" },
  profileId: "reviewer"
}
```

错误但不阻断的常见情况：

- lower-priority profile parse failed，但 higher-priority profile 已覆盖并可用。
- settings project parse failed，但 global settings 仍可用。
- extension activation failed，但 missing/activation policy 允许继续。
- profile 请求的 optional tool 缺失，但 runtime policy 允许降级。
- model auth missing 在 interactive 模式下可以继续展示 UI 并请求用户配置。
- resume active tool missing 可以过滤该 active tool 后继续恢复 agent。

是否阻断应由 registry、orchestrator 或 runtime policy 决定，并体现在 `disposition` 中。

Tool registry 直接产出 `CoreDiagnostic`，当前 codes 包括：

- `tool.define_conflict`：多个来源定义同名 tool，registry 保留最先注册的 definition，后续同名 define 只产生 diagnostic。
- `tool.patch_target_missing`：patch 指向不存在的 tool。
- `tool.patch_field_conflict`：多个 patch 修改同一覆盖字段，注册顺序决定最终值。
- `tool.patch_contract_risk`：patch 修改参数 schema 但没有同步 patch execute/aroundExecute，旧执行逻辑可能不匹配新参数。
- `tool.requested_duplicate` / `tool.requested_missing`：profile/policy 请求的工具重复或不存在。
- `tool.active_duplicate` / `tool.active_missing`：resume 或 runtime policy 提供的 active tool names 重复或不可见。
- `tool.invalid_name`：definition、patch target 或 name list 包含空名字。

这些 codes 由 `ToolRegistryResolveResult.diagnostics` 产出，并在 orchestrator create/resume/runtime tool resolve 时补充 agent/profile context 后发布为 diagnostic event。

Settings、Auth 和 Model registry 也直接产出 `CoreDiagnostic`，同时保留旧 error/string API 作为兼容层：

- `settings.load_failed` / `settings.write_failed`：settings 读取或持久化失败，旧 `drainErrors()` 仍返回 `SettingsError[]`。
- `auth.load_failed` / `auth.persist_failed` / `auth.oauth_refresh_failed`：auth storage 或 OAuth refresh 失败，旧 `drainErrors()` 仍返回 `Error[]`。
- `model.load_failed`：models.json 读取、解析、schema 或 config 校验失败，旧 `getError()` 仍返回原字符串。
- `model.auth_missing` / `model.auth_resolution_failed`：model request auth 缺失或解析失败，旧 `ResolvedRequestAuth` 返回 shape 保持不变。

这些模块第一版提供 `drainDiagnostics()`；Auth 和 Model 额外提供 `getLoadDiagnostic()` 读取当前 load failure 的结构化版本。

Policy 决定处理结果。

同一个 diagnostic 可以导致继续、降级、标记 agent unavailable、要求用户选择、或让 core capability 失败。Core 负责产生和汇总事实，caller layer 或 runtime policy 负责决定结果。

## Extension

Extension 可以产生 diagnostics，也可以观察 diagnostics。但 extension 不能吞掉 core diagnostics，也不能把 core failure 私有化。

Extension diagnostics 应预留独立 namespace：

- `extension.missing`
- `extension.load_failed`
- `extension.version_incompatible`
- `extension.activation_failed`
- `extension.timeout`
- `extension.runtime`

Missing extension、activation failed 和 runtime diagnostic 是不同问题。`missingExtensionSeverity` 之类 policy 决定 disposition，但不改变事实 code。

## 迁移策略

`apps/widi-pi/src/core/diagnostics.ts` 是共享 diagnostic contract，不是有状态 runtime service。它定义 `CoreDiagnostic`、`DiagnosticError`、message formatter、source 类型、dedupe helper 和兼容 Pi upstream diagnostics 的 adapter。

短期可以保留兼容 alias：

```ts
type OrchestratorDiagnostic = CoreDiagnostic;
class OrchestratorError extends DiagnosticError {}
```

Profile registry、Tool registry、Settings、Auth 和 Model registry 已直接产出 `CoreDiagnostic`。WIDI 自有模块优先接入统一 shape；adapter 只用于尚未迁移的内部模块，或兼容 Pi agent harness 等 upstream 已定义的局部 diagnostics。

Pi agent harness 已经为 resource loaders 定义了局部 diagnostics，例如 `SkillDiagnostic` 和 `PromptTemplateDiagnostic`。WIDI 不改这些 upstream shape。Resource loader 可以继续返回 Pi diagnostics；进入 orchestrator event 或 runtime service 时，通过 adapter 转成 `CoreDiagnostic`。

第一版 resource adapter 规则：

- `SkillDiagnostic` -> `code: "resource.skill.<upstream-code>"`
- `PromptTemplateDiagnostic` -> `code: "resource.prompt_template.<upstream-code>"`
- `type: "warning"` -> `severity: "warning"`
- `path` -> `source: { kind: "resource", resourceType, path }`
- 当前 profile -> `requestedBy: { kind: "profile", id }`
- 第一版 `disposition: "reported"`，只发布 diagnostic，不阻断 harness 创建。

Orchestrator event 和 command result 应优先只暴露 `CoreDiagnostic`。模块私有 diagnostics 可以继续存在于 inspect/debug 结果中，但进入 runtime event 时要统一 shape。

## Orchestrator Event Boundary

UI/RPC/CLI 不直接轮询 Settings、Auth、Model、ProfileRegistry 或 ResourceLoader。它们只订阅 orchestrator 的统一事件：

```ts
{ type: "diagnostic", diagnostic: CoreDiagnostic, createdAt: string }
```

Orchestrator 负责在 runtime 边界汇总并发布 diagnostics：

- 启动期：UI 注册 listener/client 后调用 `emitStartupDiagnostics()`，drain Settings、Auth 和 Model registry 的 startup diagnostics；`spawnAgentHarness()` 也会在创建 agent 前 drain 一次，避免启动问题完全沉默。
- Agent create/resume：profile resolve、resource load 和 tool registry resolve 产生的 diagnostics 会在 spawn/resume 路径发布。
- Model request auth：`getApiKeyAndHeaders` 产生的 model/auth diagnostics 会在 provider auth callback 后 drain 并发布。
- Command/human request：blocking errors 继续通过 command result 或 thrown `OrchestratorError` 暴露，同时也发布 `diagnostic` event。

Drain 型模块发布后会清空本地队列；result 型模块只在当前 operation 内收集并发布一次。Orchestrator 发布前使用 `dedupeDiagnostics(...)` 去重。

当前 helper：

- `formatDiagnosticMessage(template, params)`
- `createDiagnostic(...)`
- `dedupeDiagnostics(...)`
- `diagnosticToError(...)`
- `createOrchestratorDiagnostic(...)`
- `toDiagnostic(error, fallback)`

`createOrchestratorDiagnostic(...)` 和 `toDiagnostic(...)` 是给 orchestrator-domain runtime modules 复用的 construction helper。它们不意味着 diagnostic 只能由 `AgentOrchestrator` 类产生；例如 `HumanRequestBroker` 会直接用它们把 no-client、abort、timeout、cancel 等 request lifecycle failure 变成统一 diagnostic facts，再通过 host 回到 orchestrator publish path。

## 非职责

- 不在 core 中决定最终 UI 文案。
- 不用普通 log 替代结构化 diagnostic。
- 不把 warning/error 只藏在 thrown exception 中。
- 不让 extension 吞掉 core diagnostics。

## TODO

后续任务按 milestone 维护在 [Milestones](../TODO.md) 与 [Backlog](../BACKLOG.md)，本文件只保留 diagnostics 机制边界和当前行为。
