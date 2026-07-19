# Extension 开发指南

本文面向 extension 作者，说明如何声明 extension、runtime 如何激活它，以及回调中可以使用哪些能力。机制与失败语义的 canonical 说明见 [Extensions](core/extensions.md)。

## 作者 import 面

唯一作者契约是 `src/core/extension/api.ts`（API v1）。第三方 extension 不应 import `extension/index.ts`、runner、loader 或 orchestrator internals。

当前 `widi-pi` 尚未发布稳定 package exports。仓库内 consumer 使用相对路径 import `api.ts`；无类型 import 的裸 factory 也可以被 loader 执行。第三方发布应显式声明 `apiVersion`。

## 最小 extension

```ts
import type { ExtensionDefinition } from "../path/to/widi-pi/src/core/extension/api.ts";

const extension: ExtensionDefinition = {
  apiVersion: 1,
  activate(api) {
    api.observe("agent_harness_event", (event) => {
      console.error(`agent event: ${event.event.type}`);
    });
  },
};

export default extension;
```

`activate` 可以是 async，但应只声明 contributions，不执行长时间任务。

裸 factory `(api) => { ... }` 视为面向当前 API version，适合同仓 extension；版本化 definition 更适合第三方分发。

## Discovery

Loader 从三类 roots 发现 extension：

1. Settings 中声明的 paths。
2. Trusted project 的 `<cwd>/.widi/extensions/`。
3. Agent dir 下的 `extensions/`。

支持的 entry：

- 单个 `.ts` / `.js` / `.mjs` / `.cjs` file。
- 带 `package.json` extension entry 的 directory。
- 使用 `index.ts` / `index.js` / `index.mjs` / `index.cjs` 的 directory。

Module 经 jiti 加载，TypeScript source 不需要预编译。同 id first-registration-wins，冲突和 load/factory/manifest failure 产生结构化 diagnostics。

测试可以用 `ExtensionLoader.registerExtension(id, module)` 直接注册 in-memory factory/definition。

## Agent lifecycle

Profile frontmatter 通过 id 声明 extension dependencies：

```yaml
extensions: [hello, audit]
missing-extension-severity: warning
```

每个 `(extension, agent)` 独立 activate。Factory closure 是 per-agent state，module top-level state 跨 agent 共享。

- Missing id 按 profile missing severity 处理。
- Activation failure 和 version incompatibility 是 blocked dependency failure。
- Reload 替换 runner；旧 context/actions 变成 stale。
- 不要把 context 或 action handle 缓存到 activation lifecycle 之外。

## 注册 tool

```ts
import { Type } from "typebox";

api.registerTool({
  name: "tp_echo",
  label: "Third-party echo",
  description: "Echo text.",
  parameters: Type.Object({ text: Type.String() }),
  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: `echo: ${params.text}` }],
      details: undefined,
    };
  },
});
```

同名 definition 不能覆盖 built-in。修改已有 tool 使用 `patchTool`：

```ts
api.patchTool("write", {
  async aroundExecute(next, toolCallId, params, context) {
    const startedAt = Date.now();
    try {
      return await next(toolCallId, params, context);
    } finally {
      console.error(`write took ${Date.now() - startedAt}ms`);
    }
  },
});
```

审计、确认和计时优先使用 `aroundExecute`；真正替换 backend 时再设置 `execute`。

## 展示、状态与诊断

Observer、interceptor 与 tool callback 的 context 都带 own-agent scoped actions。需要追加进度时使用 `emitOutput()`：

```ts
await context.actions.emitOutput("Scanning files");
await context.actions.emitOutput("Building index");
```

每次调用产生一条独立、append-only plain-text event；顺序 `await` 才保证调用顺序。它不合并进度项、不进入 model context、不写 session，重启或 resume 后不会恢复。

只需要短暂告知用户一个成功或信息事实时使用 `notify()`：

```ts
await context.actions.notify("Report generated in 2.1s");
```

Notify 是 info-only、fire-once 的 transient notice。Consumer 决定显示位置和时长；它不进入 timeline、model context 或 session，重启或 resume 后不会恢复。Text 必须非空白且不超过 4 KiB（UTF-8 字节）。它没有 severity、code、dedupe、clear 或 attention：需要展示过程痕迹使用 `emitOutput`，需要 warning/error 或降级事实使用 `reportDiagnostic`。

需要可替换的当前状态时使用 `setStatus()`，完成后显式 `clearStatus()`：

```ts
await context.actions.setStatus("index", {
  text: "Building symbol index",
  progress: { completed: 418, total: 672 },
});
await context.actions.clearStatus("index");
```

Status 按 extension 自己的 key replace，不进入 timeline、session 或 model context。Extension 必须显式 clear；成功 reload 或 agent dispose 也会由 core 清理。

需要在 resume 后恢复的展示内容时使用 `publishMessage()`：

```ts
const { entryId } = await context.actions.publishMessage({
  kind: "markdown",
  title: "Index Summary",
  content: "Indexed **672 files** and **14,208 symbols**.",
});
```

Core 先写 `core:extension_message` session entry，再发布 live event；返回值、entry 与 event 使用同一个 `entryId`。Message 不进入 model context。`text`、`markdown`、`code` 是 transport-neutral 语义，具体 consumer 可以降级为有界 plain text。

已知问题使用 `reportDiagnostic()`，不要用 output/status 模拟 warning 或 error：

```ts
await context.actions.reportDiagnostic({
  severity: "warning",
  disposition: "degraded",
  code: "remote_policy_unreachable",
  message: "Remote policy service is unavailable",
  details: { attempts: 2 },
});
```

Core 注入 agent/extension attribution，并把 code 规范化为 `extension.<extensionId>.<code>`。Local code 只使用字母、数字、`.`、`_`、`-`，最长 128 UTF-8 bytes；message 最长 4 KiB，JSON details 最长 16 KiB。作者只能声明 `reported` 或 `degraded`，不能自称 `blocked`。每次调用生成独立 diagnostic id；不要轮询式重复上报同一持续问题。

Extension API 不提供命令注册。Line/inline command 属于 `src/tui/commands/` 的 TUI 命令引擎（CLI 复用）；extension 保留 tool/resource/provider contribution、observer/interceptor 与 scoped actions 等被动能力。未来需要主动入口时，由前端以 `/extension` 一类命令另行设计。

## 贡献 resources 与 provider

Resource contribution 只声明 path：

```ts
api.contributeResources({
  skillPaths: ["/path/to/skills"],
  promptTemplatePaths: ["/path/to/prompts"],
});
```

Core ResourceLoader 负责读取、解析、冲突与 provenance。

Provider contribution 必须使用新 name 并携带完整 models：

```ts
api.registerProvider("my-gateway", {
  baseUrl: "https://gateway.example.com/v1",
  apiKey: "$MY_GATEWAY_KEY",
  api: "openai-completions",
  models: [
    {
      id: "my-model",
      name: "My Model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32000,
      maxTokens: 4096,
    },
  ],
});
```

Credential 归 AuthStorage；`!command` config value 受 project trust gate。Extension provider 不能 override built-in/models.json provider。

## Observe 与 intercept

`observe()` 适合日志、审计、统计和 session ledger。Observer failure 不影响原操作。

```ts
api.observe("agent_harness_event", (event) => {
  // event.event is the raw Pi AgentHarnessEvent.
});
```

`intercept()` 用于改变行为。六个 hook 的合成和失败语义见机制文档。重要原则：

- `tool_call` 和 `input` failure 都 fail-closed。
- `context`、`before_agent_start`、`before_provider_request`、`tool_result` 跳过失败 handler 并保留其他成功结果。
- Provider request hook 用于 shaping，不是策略门禁。

## Context 与 actions

Callback context 绑定 extension 自己的 agent。常用 actions：

- get/set tools 与 active tools。
- prompt/steer/followUp、abort、compact。
- requestHuman。
- emitOutput：向 client 追加 own-agent 的 ephemeral plain-text output，不回灌 observer。
- notify：发布 own-agent 的 info-only transient notice，不进入 timeline/session，也不产生 attention。
- setStatus/clearStatus：维护 keyed runtime current state，不进入 timeline/session。
- publishMessage：写入可恢复的展示消息，返回稳定 entryId。
- reportDiagnostic：发布带 core attribution 的结构化问题事实。
- get/set session name、model、thinking level。
- list model candidates。
- exec trusted project command。

Actions 不接受任意 agentId；跨 agent 协作使用未来的受控 collaboration facade。

## Session-local state

```ts
await context.session.appendEntry("verdict", {
  toolCallId,
  outcome: "blocked",
});

const entries = await context.session.findEntries("verdict");
```

Namespace 自动隔离，写入 append-only，读取 current branch path。Entry 不进入 model context，compaction 不影响它，fork 按 path-to-root 复制。

状态选择：

- Runtime state：factory closure。
- Small recoverable session state：custom entry。
- Large/cross-session state：extension-owned file storage。

## 推荐做法

- 从 observe 开始，只有需要改变行为时再 intercept。
- `tool_call`/`input` handler 内保护非关键账本逻辑，避免次要 failure 触发 fail-closed。
- Handler 快速返回；observer/interceptor 按顺序串行执行。
- 第三方 extension 显式声明 `apiVersion`，只 import `extension/api.ts`。
- 通过 diagnostics 与 `agent.inspect` 检查 load、activation、hooks、contributions、patches 和 stale state。
- 不把 closure 当持久状态，不把 custom entry 当数据库，不缓存 stale context。

## 与 Pi extension 的差异

- `pi.on()` 对应 WIDI 的 observe/intercept 两条通道。
- 修改 built-in tool 使用 patch，不用同名 registration。
- Provider 只能注册新 name。
- `registerShortcut`、flag、renderer 和 UI context 归 client adapter。
- 消费 input 使用 block/transform + scoped actions；不提供独立 `handled` 通道，也不注册交互命令。

## 示例：MCP extension

仓库内 `.widi/extensions/mcp/` 是一个完整的第三方 extension 样例：它读取 `.widi/mcp.json`（Claude Code 风格的 `mcpServers` 配置），在 activation 时并行连接所有配置的 MCP server（stdio 与 StreamableHTTP），把每个 server tool 注册为 `mcp_<server>_<tool>` 形式的 WIDI tool。`env`/`headers` 值支持 `$VAR` 环境变量展开。单 server 连接失败降级为 `agent_spawned` 时的 warning diagnostic，不影响其他 server。工具调用抛错时会重建连接并重试一次。

已知限制：extension API v1 没有 dispose 钩子，reload extensions 后旧 MCP client 与 stdio 子进程会滞留到进程退出。
