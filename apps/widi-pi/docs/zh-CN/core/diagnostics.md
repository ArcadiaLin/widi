# Diagnostics

Diagnostic 是 core 的一等结构化输出。它记录 profile、dependency、runtime 或 extension 问题的事实；不是最终 UI 文案，也不是普通 log line。

## Contract

`CoreDiagnostic` 的契约面：

- `severity`：`warning | error`，描述问题本身；不存在 info 级 diagnostic。
- `code`：稳定分类和机器可读原因，例如 `profile.missing`、`tool.requested_missing`。
- `message`：可直接记录/展示的人类可读文本。
- `agentId` / `extensionId`（可选）：归属 attribution。

severity 加 code 就是整个模型：没有 domain/disposition/recoverable/phase/details 元数据层，也不注入 fresh per-report id。是否阻断由 caller policy 直接判断 severity——例如 extension load diagnostics 中存在 `severity === "error"` 即构成阻断。

## Code 与 message

Code 使用 `domain.problem` 风格 namespace，不维护不断膨胀的全局 union。Code 应稳定，是 diagnostic 的机器可读身份；UI 可以据此分组、过滤、本地化或链接帮助。

具体 path、profile id 或 extension name 等上下文直接进入 message。不要只在 message 中拼接 attribution：agent/extension 归属使用 `agentId` / `extensionId` 字段。

## 产生位置

Diagnostic 应由最接近失败事实的 owner 产生：

- ProfileRegistry：source、parse、validation、duplicate、override、missing。
- ResourceLoader/adapter：skill/template load 与 identity 问题。
- ToolRegistry：definition/patch/visibility/active resolution。
- ExtensionLoader/Runner：discovery、version、activation、handler/action 与 contribution conflict。
- ModelRegistry/AuthStorage/SettingManager：config、credential、request auth 与 persistence。
- Runtime collaborator：自己拥有的 lifecycle failure，例如 human request timeout/cancel。

Orchestrator 主要承担两件事：补充 agent/extension attribution，以及通过统一 event boundary 发布。它不应重新实现各 domain 的 diagnostic decision tree，也不应成为所有 message construction 的唯一地点。

跨模块重复的 construction、format 或 error conversion 可以进入 `core/diagnostics.ts`（当前只有契约、`OrchestratorError` 与 `toDiagnostic`）；只服务单一 domain 的 wrapper 留在 owner module。是否继续拆分由 [Milestones](../TODO.md) 的 diagnostics 收敛目标驱动，不在本机制文档预设文件方案。

## 主要 domain facts

ToolRegistry 直接产出 define conflict、patch target/field/contract、requested/active duplicate/missing 与 invalid name diagnostics。

Settings/Auth/Model 直接产出 load、write/persist、OAuth refresh、auth missing/resolution diagnostics，并可以保留旧 error accessor 作为内部兼容。

Extension 区分：

- missing declaration。
- module load/factory/manifest invalid。
- API version incompatible。
- activation failed。
- observer/interceptor handler failed。
- scoped action failed/denied。
- tool/resource/provider contribution conflict。

Missing severity 不改变其他 failure 的事实 code。

## Upstream diagnostics

Pi resource loaders 已有 `SkillDiagnostic` 与 `PromptTemplateDiagnostic`。WIDI 不修改 upstream shape；进入 runtime event 时由 adapter 转为 `CoreDiagnostic`：

- Code 加 `resource.skill.*` 或 `resource.prompt_template.*` namespace。
- Upstream warning 映射为 WIDI warning。
- Path 拼入 message。
- 归属 agent 时附 `agentId`。

## Orchestrator event boundary

UI/RPC/CLI 不轮询各 registry 的 error queue。统一事件为：

```ts
{ type: "diagnostic", diagnostic: CoreDiagnostic, createdAt: string }
```

发布时机：

- Startup：drain settings/auth/model load diagnostics。
- Agent create/resume：发布 profile/resource/tool/extension resolution diagnostics。
- Model request：发布 auth resolution diagnostics。
- Command/human request/runtime action：发布带 operation source 的 failure diagnostic。

Drain 型 source 发布后清空队列；operation result 型 diagnostic 只在当前 operation 发布一次。Core 不做跨发布去重；consumer 按 code、attribution 与 message 生成 view key 去重。

Blocking capability 可以同时 throw `OrchestratorError` 并发布 diagnostic；throw 是控制流，不替代结构化事实。

## Extension observation

Own-agent extension 可以 observe diagnostic，但不能吞掉、改写或阻止 core diagnostic。Observer failure 产生新的 `extension.handler_failed`；为避免 feedback loop，该 diagnostic 仍发给 core listeners/clients，但不再次送进 extension diagnostic observers。

## 非职责

- 不在 core 决定最终文案、布局或本地化策略。
- 不用普通 log 替代 diagnostic。
- 不把 warning/error 只藏在 exception 中。
- 不让 orchestrator 重新拥有 domain-specific diagnostic logic。
