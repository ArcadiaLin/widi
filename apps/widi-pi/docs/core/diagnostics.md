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
- Runtime diagnostics：extension activation、tool execution policy、auth/runtime permission、client delivery。

Tool registry 当前已经定义局部 diagnostic codes：

- `tool_define_conflict`：多个来源定义同名 tool，registry 按 priority/顺序保留一个。
- `tool_patch_target_missing`：patch 指向不存在的 tool。
- `tool_patch_field_conflict`：多个 patch 修改同一覆盖字段，priority/顺序决定最终值。
- `tool_requested_duplicate` / `tool_requested_missing`：profile/policy 请求的工具重复或不存在。
- `tool_active_duplicate` / `tool_active_missing`：resume 或 runtime policy 提供的 active tool names 重复或不可见。
- `tool_invalid_name`：definition、patch target 或 name list 包含空名字。

这些 codes 目前停留在 `ToolRegistryResolveResult.diagnostics`，还没有汇总到 orchestrator event。接入 orchestrator 时应保留 code，并补充 agent/profile/session context。

Policy 决定处理结果。

同一个 diagnostic 可以导致继续、降级、标记 agent unavailable、要求用户选择、或让 core capability 失败。Core 负责产生和汇总事实，caller layer 或 runtime policy 负责决定结果。

## Extension

Extension 可以产生 diagnostics，也可以观察 diagnostics。但 extension 不能吞掉 core diagnostics，也不能把 core failure 私有化。

## 非职责

- 不在 core 中决定最终 UI 文案。
- 不用普通 log 替代结构化 diagnostic。
- 不把 warning/error 只藏在 thrown exception 中。
- 不让 extension 吞掉 core diagnostics。

## TODO

- [x] 定义 command/client/human-request 使用的最小 `OrchestratorDiagnostic` shape。
- [x] 通过 orchestrator event 暴露 command rejection、client delivery failure、human request unhandled/timeout/aborted/cancelled。
- [ ] 扩展统一 diagnostic shape，覆盖 profile、resource、extension、tool 和 model/auth context。
- [ ] 区分 profile、dependency、runtime、extension diagnostic code namespace。
- [ ] 定义 severity 与 policy 的关系，包含 unavailable、fail、continue、user selection。
- [ ] 将 resource/profile/extension/tool/model/auth diagnostics 接入 orchestrator event 或 result。
- [x] 增加 focused tests 覆盖 command rejection 与 human-request diagnostics。
- [ ] 增加 focused tests 覆盖 spawn 和 resume 路径的 diagnostics。
