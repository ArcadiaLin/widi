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
    api.registerCommand({
      name: "hello",
      description: "Say hello.",
      async handler(args, context) {
        await context.actions.followUp(`Say hello to ${args || "the user"}.`);
      },
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

## 注册 command

Line command 获得完整 command context：

```ts
api.registerCommand({
  name: "tp-note",
  argumentHint: "<text>",
  arguments: { required: true },
  async handler(args, context) {
    await context.session.appendEntry("note", { text: args });
    return { saved: true, text: args };
  },
});
```

Line-command handler 的返回值会同时进入 `InputResult.value` 与 `command_completed.result`，富 client 可以将其显示为最终 command result。纯副作用 command 返回 `undefined`。

执行期间需要追加进度时使用 `emitOutput()`：

```ts
api.registerCommand({
  name: "tp-index",
  async handler(_args, context) {
    await context.actions.emitOutput("Scanning files");
    await context.actions.emitOutput("Building index");
    return { indexed: 42 };
  },
});
```

每次调用产生一条独立、append-only plain-text event；顺序 `await` 才保证调用顺序。它不合并进度项、不进入 model context、不写 session，重启或 resume 后不会恢复。

Inline command 是无副作用的文本展开：

```ts
api.registerCommand({
  name: "tp-term",
  placement: "inline",
  expand(argument) {
    return glossary[argument] ?? argument;
  },
});
```

Inline 语法固定为 `<name:argument>`。`expand` 拿不到 context/actions；需要副作用时使用 line command。

Arguments definition 可以提供 completion candidates。Runtime 与富 client 消费同一 candidates；缺少必填参数时 orchestrator 可以发起 `argumentsCompletion` human request。

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
api.observe("command_completed", (event) => {
  console.error(`completed: ${event.command.name}`);
});

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
- get/set session name、model、thinking level。
- list commands/model candidates。
- exec trusted project command。

Line command context 额外提供 new/fork/resume/list session 与 tree navigation，并受 `canSpawn`/idle policy 门控。

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
- 消费 input 使用 block + scoped actions，或注册 command；不提供独立 `handled` 通道。
