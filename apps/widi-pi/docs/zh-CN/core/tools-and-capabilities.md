# Tools And Capabilities

Tool 是 agent/模型调用 runtime 能力的 adapter。Core capability 是 orchestrator 或 runtime 原生提供的受控能力；profile capability 是声明式 policy。三者不是同一个概念。

## Capability 与 tool

Orchestrator 原子方法、profile/resource resolution、human request 和 diagnostics publish 都是 core capabilities。Programmatic consumer 直接调用受控 API；不需要把每项能力绕成 tool 或 command。

Tool 把 core capability、runtime boundary 或产品能力暴露给 `AgentHarness`。Profile 不保存 tool instance，只声明 tool visibility 与 capability policy。

## ToolRegistry

`ToolRegistry` 属于 dependency layer，是唯一的 `ToolDefinition -> AgentTool` adapter。它提供两种 registration：

- `defineTool(tool, source)`：新增 definition。
- `patchTool(targetToolName, patch, source)`：修改既有 definition。

同名 define 采用 first-registration-wins；后续 definition 被忽略并产生 `tool.define_conflict`。修改既有 tool 必须走 patch，使来源、顺序与冲突可诊断。

Patch 按注册顺序应用：

- `description`、`parameters`、`strict`、`execute` 由后成功注册者覆盖。
- `aroundExecute` 包装当前 execute，后注册者位于外层。
- Patch context 绑定 patch source；调用 `next()` 时恢复内层 definition source。
- 修改 schema 但没有同步 execute/aroundExecute 会产生 contract-risk diagnostic。
- Target missing 不创建隐式 tool。

Extension runner 把 per-agent tool definitions/patches replay 到 scoped registry；registry 本身不发现或激活 extension。

## Visibility 与 active tools

- 未提供 `requestedToolNames`：全部 resolved tools 可见。
- 提供 `requestedToolNames`：只保留存在的名字，duplicate/missing 产生 diagnostic。
- 未提供 `activeToolNames`：默认启用全部 visible tools。
- 提供 `activeToolNames`：校验到 visible 集合，duplicate/missing 产生 diagnostic。

Create、resume 和 runtime tool mutation 共用同一 resolve 语义。Orchestrator 对外只暴露 name snapshots，不接受裸 `AgentTool[]`。

## Core built-in coding tools

| Tool | 职责 |
| --- | --- |
| `read` | 读取 UTF-8 文本和受支持图片，返回 head truncation 与 typed details |
| `bash` | 运行 shell command，支持 streaming update、abort、timeout 与 tail truncation |
| `edit` | 对文本执行精确/归一化替换并返回 diff/patch details |
| `write` | 创建父目录并写入完整文件 |
| `grep` | 通过 `rg --json` 搜索内容，支持 context、limit 与单行截断 |
| `find` | 通过 `rg --files` 枚举路径，在 WIDI 层匹配 glob |
| `ls` | 单层目录浏览，稳定排序并标记目录 |

共同契约：

- Success `content` 面向模型，保持简短且可行动。
- 路径、数量、截断和完整输出位置进入 typed `details`。
- Failure 通过 throw 表达；abort 统一为 `Operation aborted`。
- Backend 通过最小 typed operations 注入，不把整个 `ExecutionEnv` 暴露给 definition。
- 用户提供的搜索参数作为 argv 传递，不拼接进 shell。
- `grep`/`find` 依赖显式路径或 `PATH` 中的 `rg`，不在执行期联网下载 executable。

`read` 按内容探测 JPEG、PNG、GIF、WEBP 与 BMP。图片 normalize/resize 可以运行于 worker，BMP 转为 PNG；`images.blockImages` 在 provider-bound context 上统一过滤，非视觉模型继续由 Pi message transform 降级。

Active tools 的 `promptSnippet` 与 `promptGuidelines` 进入唯一 system prompt composition，指导模型优先使用精确工具而不是用 bash 模拟全部文件操作。

## Tool events

Orchestrator 只发布 raw `agent_harness_event`。Tool-call streaming 使用 Pi `message_update.assistantMessageEvent.toolcall_*`；执行使用 `tool_execution_start/update/end`。Core 不维护第二套 preview/state 或 lifecycle event。

TUI、RPC、exporter 或 extension observer 可以从 raw arguments、partial result、result 和 typed details 派生展示。

## Result persistence

Tool call arguments、result `content` 与 typed `details` 共同构成 session 中的可恢复上下文。ToolRegistry 不提供 session persistence facade，也不把 Pi custom entry 变成 built-in tool state。

审计、确认、耗时统计或 tracking 适合由 extension `aroundExecute` 实现。真正替换 backend 时再 patch `execute`。

## 非职责

- 不把 tool 当作裸数组长期透传。
- 不让 profile 持有 runtime tool object。
- 不让 extension 绕过 registry 注入 tool。
- 不把 tool visibility 当作 capability。
- 不在 core 维护 tool preview/state。
