# Extension 开发指南

本文面向 extension 作者：如何写一个 extension、runtime 如何找到并激活它、激活期能注册什么、回调里能做什么，以及推荐的做法。机制边界、裁决记录与 Pi 对比见 [core/extensions.md](./core/extensions.md)；本文只讲作者视角的事实。

作者契约的唯一 import 面是 `src/core/extension/api.ts`（API v1）。第三方 extension 只应 import 该模块与公开契约枚举的上游类型（Pi typed hook event、raw `AgentHarnessEvent`、typebox `TSchema` 等）；`extension/index.ts` 是 core 内部 barrel，不属于作者契约。

## 最小 extension

一个 extension 就是一个默认导出 factory（或版本化定义）的模块：

```ts
// .widi/extensions/hello.ts
import type { ExtensionDefinition } from "../path/to/widi-pi/src/core/extension/api.ts";

const extension: ExtensionDefinition = {
	apiVersion: 1,
	activate: (api) => {
		api.registerCommand({
			name: "hello",
			description: "Say hello.",
			handler: async (args, context) => {
				await context.actions.followUp(`Say hello to ${args || "the user"}.`);
			},
		});
	},
};

export default extension;
```

类型标注是编辑器/typecheck 用的 type-only import，jiti 加载时会擦除；仓库内 consumer 以相对路径 import `api.ts`（见 `tests/extensions/`）。`widi-pi` 尚未发布，也没有 `exports` 声明，第三方可用的 import specifier 是当前分发缺口——不影响 extension 运行（不带类型的裸 factory 同样可加载）。

两种声明形态：

- `{ apiVersion, activate }`：版本化定义。第三方发布应显式声明；声明的版本不在 runtime 支持区间内时，extension 不进激活表并产生 `extension.version_incompatible`（error）。
- 裸 factory `(api) => { ... }`：视为面向当前 API 版本，适合与 runtime 同步演进的仓库内 extension。

`activate` 可以是 async。它在每次 agent 装载该 extension 时执行一次（见下节生命周期），职责是调用注册面声明能力；不要在里面做长耗时工作。

## 发现、声明与生命周期

### Extension 从哪里被发现

Loader 从三类 root 发现 extension：

1. settings 中 `extensions` 字段声明的路径（global 或 project settings）。
2. trusted 项目的 `<cwd>/.widi/extensions/`。项目未通过 trust gate 时该 root 整体不加载。
3. agent dir（默认 `.widi`）下的 `extensions/`。

每个 root 下的候选按形态解析：

- 单个 `.ts` / `.js` / `.mjs` / `.cjs` 文件：一个 extension，id 为去扩展名的文件名。
- 子目录带 `package.json`：按 manifest 的 `widi.extensions`（兼容 `pi.extensions`）取 entry 路径；只用第一个 entry，多余的产生 `extension.extra_entries_ignored`。
- 子目录无 manifest entry：按 `index.ts` / `index.js` / `index.mjs` / `index.cjs` 解析，id 为目录名。

模块经 jiti 导入，TypeScript 源可直接加载，无需预编译。同 id 冲突时先注册者胜出，后来者跳过并产生 `extension.id_conflict`。加载失败、导出形态不对、manifest 无效分别产生 `extension.load_failed` / `extension.factory_invalid` / `extension.invalid_manifest`。

测试或宿主代码可以不经文件系统直接注册：`ExtensionLoader.registerExtension(extensionId, module)` 接收裸 factory 或版本化定义。

### 谁激活它

Extension 按 agent 激活。Profile frontmatter 用 id 声明依赖：

```yaml
extensions: [hello, audit]
missing-extension-severity: warning
```

Agent 以该 profile spawn/resume 时，loader 对每个声明的 id 执行 `activate`，产出该 agent 的 loaded scope（tool/command/resource/provider 贡献与 observer/interceptor 注册），再由 runner 接到该 agent 的 scoped overlay 上。要点：

- 每个 (extension, agent) 组合独立执行一次 `activate`。factory 闭包里的状态是 per-agent 的；模块顶层状态跨 agent 共享，且 reload 重新导入时会重置。
- 声明的 id 解析不到时按 profile 的 `missing-extension-severity`（默认 warning）处理。
- `activate` 抛错产生 `extension.activation_failed`（error、blocked）：依赖它的 agent spawn/resume 失败，不静默降级。版本不兼容同族 fail-closed。

### Reload 与 stale

Runtime reload 会重新 discover/import extension catalog 并替换 runner。旧激活产生的 context 被标记 stale：stale context 上任何 action 立即抛错，observer/interceptor 事件不再送达，inline command 退出扫描，资源贡献退出装载管线。不要把 context 或 actions 句柄缓存到激活周期之外。

## 激活 API 总览

`activate(api)` 收到的 `ExtensionActivationApi`：

| 成员 | 作用 |
| --- | --- |
| `extensionId` / `agentId` / `profileId` | 当前激活的身份事实（只读） |
| `registerTool(tool)` | 注册 LLM-callable tool |
| `patchTool(targetToolName, patch)` | 修改既有 tool（含 core built-in） |
| `registerCommand(definition)` | 注册 line 或 inline 命令 |
| `contributeResources(paths)` | 声明额外 skill / prompt template 路径 |
| `registerProvider(name, config)` | 注册 model provider |
| `observe(eventName, handler)` | 订阅事实（只读，返回值忽略） |
| `intercept(eventName, handler)` | 拦截/改写/阻断（六个 hook 点） |

以下逐面展开。

### registerTool

```ts
import { Type } from "typebox";

api.registerTool({
	name: "tp_echo",
	label: "Third-party echo",
	description: "Echo the given text back.",
	parameters: Type.Object({ text: Type.String() }),
	execute: async (toolCallId, params, context) => ({
		content: [{ type: "text", text: `echo: ${params.text}` }],
		details: undefined,
	}),
});
```

- `parameters` 是 TypeBox schema；`params` 按 schema 自动收窄类型。
- `execute` 的 `context` 携带 `signal`（当前调用的 abort）、`onUpdate`（流式更新回调）、`extension`（本 extension 身份）、`human`（受控用户交互 host）。
- Tool 名 first-registration-wins：core built-in 先注册，extension 不能用同名 define 覆盖内置 tool（这是与 pi 的显式差异）；要改内置行为用 `patchTool`。同名 define 只产生 diagnostic。
- Tool 需要可恢复数据时走 tool call arguments、result `content` 和 typed `details`，不要另建私有状态通道。

### patchTool

对既有 tool（core built-in 或其他来源）注册修改，进入 registry 的 resolved pipeline，tool 名保持稳定：

```ts
api.patchTool("write", {
	aroundExecute: async (next, toolCallId, params, context) => {
		const started = Date.now();
		const result = await next(toolCallId, params, context);
		console.error(`write took ${Date.now() - started}ms`);
		return result;
	},
});
```

Patch 字段：`description` / `parameters` / `strict`（改 model-facing contract）、`execute`（整体替换）、`aroundExecute`（包装现有实现）。语义纪律：观察、审计、确认、耗时统计用 `aroundExecute`；只有真要改变 tool 行为（如把 `write` 转发到别的 backend）才替换 `execute`。多个 patch 按注册顺序应用，后注册的 `aroundExecute` 包在外层；字段冲突按注册顺序取最终值并进 diagnostic。

### registerCommand

两种 placement：

**Line 命令**（默认）：`/name args` 形态，带完整回调 context。

```ts
api.registerCommand({
	name: "tp-note",
	description: "Record a note into the session ledger.",
	argumentHint: "<text>",
	handler: async (args, context) => {
		await context.session.appendEntry("note", { text: args });
	},
});
```

- `trigger` 默认 `/`，可自定义（不能为空、不含 `:` 或空白）。
- `context` 是 `ExtensionCommandContext`：`ExtensionContext` 加 `waitForIdle()`。
- `arguments: { required, getArgumentsCompletion(argumentPrefix) }` 声明参数事实与补全候选；补全回调只收前缀字符串，是否发起人机交互由 orchestrator 决定。

**Inline 命令**：`<name:argument>` 形态，在输入文本中就地展开。

```ts
api.registerCommand({
	name: "tp-term",
	placement: "inline",
	description: "Expand a glossary term.",
	expand: (argument) => glossary[argument] ?? argument,
});
```

- 触发语法固定为 built-in inline 语法，与 `<prompt:>` / `<skill:>` 同一条扫描管线，不开自定义 trigger。
- `expand(argument)` 只收参数字符串、返回替换文本，拿不到 context/actions——展开无副作用由 API 形状强制。展开需要的数据在激活期闭包携带。
- `expand` 抛错发 `command_failed`（source: extension），整条输入丢弃，不产生半展开 prompt。

命令名规则：字母或数字开头，只含字母、数字、`.`、`_`、`-`。与 built-in 或已注册命令同名时按 rename-with-provenance 处理（built-in 名是保留字）。

### contributeResources

```ts
api.contributeResources({
	skillPaths: ["/path/to/my-skills"],
	promptTemplatePaths: ["/path/to/templates"],
});
```

只交出路径，文件读取与解释（skill 解析、frontmatter、ignore 规则）全归 core ResourceLoader。贡献是 own-agent scope：只进本 agent 的 `<skill:>` / `<prompt:>` 候选、spawn 装载和 system prompt skills 列表。同名冲突 first-registration-wins（core 侧 profile/cwd 资源必胜），被丢弃的贡献发 `extension.resource_conflict`。

### registerProvider

```ts
api.registerProvider("my-gateway", {
	baseUrl: "https://gateway.example.com/v1",
	apiKey: "$MY_GATEWAY_KEY",
	api: "openai-completions",
	models: [{ id: "my-model", /* 完整模型定义 */ }],
});
```

要点：

- 只许新 provider 名。内置、models.json、其他 extension 的名字一律不可覆盖（冲突 drop + `extension.provider_conflict`）；不提供 pi 式的 provider override/代理通道，用户的 override 入口是 models.json。
- 必须带完整 `models`；override-only 形态在校验层拒绝（`extension.provider_invalid`）。
- `apiKey` 与 headers 是 config value 引用（literal / `$ENV` / `!command`），请求期由 core 解析；`!command` 在项目未 trusted 时导致整条注册被拒（`extension.provider_trust_denied`）。OAuth credential 持久化在 core AuthStorage，extension 声明 `oauth` 回调即可接入既有桥接。
- 注册全局可见但生命周期绑 runner：reload 撤销并重注册，agent dispose 按引用计数收尾。
- 贡献模型不能作为 spawn 默认模型；首轮起即可经 `setModel` / `/model` 选用。

### observe

```ts
api.observe("command_completed", (event, context) => {
	// event 按 eventName 自动收窄
});
api.observe("agent_harness_event", (event) => {
	// event.event 是 Pi AgentHarnessEvent：turn/message/tool execution、
	// compact/tree、model/thinking update 等全部经此到达
});
```

可订阅事件（own-agent scope）：

| 事件 | 内容 |
| --- | --- |
| `agent_harness_event` | Pi harness 全量事实的 raw 透传 |
| `command_detected/accepted/completed/rejected/failed` | 命令生命周期 |
| `human_request_pending/resolved/timeout/cancelled` | 人机请求生命周期 |
| `diagnostic` | 结构化诊断事实 |
| `agent_spawned` / `agent_resumed` | session-start 对应物 |
| `agent_session_info_changed` / `agent_session_forked` | session 事实变更（成功后发布，无取消语义） |
| `input_transformed` / `input_blocked` | input 拦截结果的成功事实 |

Observer 返回值被忽略，按注册顺序串行执行。handler 抛错只产生 `extension.handler_failed` diagnostic，不影响原操作，后续 observer 继续——observe 是安全的默认档位。

### intercept

六个 hook 点，全部按注册顺序串行执行，语义与失败行为各不相同：

| Hook | 能做什么 | 合成规则 | handler 抛错时 |
| --- | --- | --- | --- |
| `before_agent_start` | 注入 messages、改 systemPrompt | messages 依次追加；最后一个 systemPrompt 胜出 | 跳过该 handler，继续 |
| `context` | 改写送往模型的 messages | 管线式：后者接收前者产物 | 跳过，继续 |
| `before_provider_request` | 改 streamOptions（header/metadata 等） | 管线式 patch 合成 | 跳过，继续（塑形 hook，非门禁） |
| `tool_call` | 阻断 tool 调用 | 第一个 `block: true` 短路 | fail-closed：立即 block 本次调用 |
| `tool_result` | 逐字段改写 tool result | 字段级最后成功者胜出；`terminate: true` 一旦出现即保留 | 跳过，继续 |
| `input` | 改写或拒绝人类输入 | 管线式改写 + 第一个 `block: true` 短路 | fail-closed：拒绝整条输入 |

`input` 的细则：拦截发生在 command 解析之前且只运行一次，改写产物重新进入完整解析管线；返回 `undefined` 放行、`{ text, images? }` 改写、`{ block: true, reason? }` 拒绝。没有 pi 的 `handled` 语义——消费输入自行处理 = block（留下可观察拒绝事实）+ scoped actions；接管命令语法用 `registerCommand`。改写与拒绝都会发布 canonical 事实（`input_transformed` / `input_blocked`）并可审计。

需要门禁语义的策略拦 `tool_call` 或 `input`，不要指望 `before_provider_request`（它失败跳过）。

## 回调 context 与 scoped actions

Observer、interceptor、command handler 收到的 `ExtensionContext`：

```ts
interface ExtensionContext {
	extensionId: string;
	agentId: string;
	profileId: string;
	actions: ExtensionActions;   // own-agent 动作/查询面
	session: ExtensionSessionContext; // session custom entry facade
	readonly signal: AbortSignal | undefined;
	isIdle(): boolean;
}
```

所有 action 绑定 extension 自己的 agent，签名中不出现 agentId；跨 agent 操作不属于本契约。完整清单：

| Action | 说明 |
| --- | --- |
| `getTools()` / `setTools()` / `setActiveTools()` | 读写本 agent 的 tool 集合 |
| `requestHuman(draft)` | 发起受控人机请求；source 由 runner 注入为 extension 身份，不可伪造；profile `canRequestUser: false` 时抛 `extension.human_request_denied` |
| `prompt` / `steer` / `followUp` | 向本 agent 注入输入；返回 void，结果经 raw event 流可达；不经过 `input` 拦截 |
| `setSessionName` / `getSessionName` | session 命名 |
| `getCommands()` | 与 client 同一门控口径的命令列表 |
| `setModel(reference)` / `getModel()` / `listModelCandidates()` | 模型读写与候选 |
| `getThinkingLevel()` / `setThinkingLevel()` | thinking level |
| `abort()` | 终止当前 run，清空排队输入 |
| `compact(instructions?)` | 触发 compaction，完成事实经 raw `session_compact` 事件 |
| `exec(command, options)` | 经 ExecutionEnv 执行命令；项目未 trusted 时抛 `extension.exec_denied` |

失败语义：async action 抛错时 runner 上报 `extension.action_failed` 并原样 rethrow；stale context 上任何 action 立即抛错。

### Session custom entry

`context.session` 是唯一的 core 提供 storage 通道，用于「当前 session 可恢复的 extension 状态」：

```ts
await context.session.appendEntry("verdict", { toolCallId, outcome: "blocked" });
const entries = await context.session.findEntries<Verdict>("verdict");
```

契约要点：

- Namespace 自动隔离：落库 type 为 `extension:<extensionId>:<localType>`，读不到其他 extension 的条目。
- Append-only，无 delete/update；`findEntries` 返回 current branch path 上 root-to-leaf 顺序的条目。
- 条目不进模型 context，compaction 零影响；fork 按分支事实复制 path-to-root。
- Extension 不可用时条目原样保留，只是无人消费。

它不是 extension 私有数据库。大型 artifact、多 session index、产品模式状态由 extension 经 `exec` 与自有文件自理。

## 推荐做法

**从 observe 开始，确需改变行为再 intercept。** Observer 失败不影响 runtime，是审计、统计、账本类需求的正确档位。Interceptor 中 `tool_call` 与 `input` 是 fail-closed 的：你的 handler 抛错会阻断 tool 调用或整条用户输入。在这两个 hook 里对自己的次要逻辑（如写账本失败）做 try/catch 兜底，只让真正的策略判断决定 block（参考 `tests/extensions/audit-extension.ts` 中 abort action 的兜底写法）。

**改内置 tool 用 patchTool，且优先 aroundExecute。** 这保持 active tool name 稳定，session 历史可解释；只有真正改变行为时才替换 `execute`。

**状态三分。** 运行期状态放 factory 闭包（per-agent，随 reload 重置）；需要随 session 恢复的小型状态走 custom entry；大数据与跨 session 状态用 `exec` 加自有文件。不要把闭包状态当持久状态，也不要把 custom entry 当数据库。

**Inline expand 的数据在激活期闭包携带。** `expand` 拿不到 context，这是契约不是缺口；需要副作用的场景用 line 命令。

**第三方发布显式声明 `apiVersion`，只 import `extension/api.ts`。** import core 内部模块的 extension 不受版本契约保护。上游类型（Pi hook event、`AgentHarnessEvent`、typebox `TSchema` 等）按公开契约枚举使用。

**Handler 保持快速返回。** Observer/interceptor 按注册顺序串行执行，慢 handler 拖慢整条管线。需要长耗时工作时记录事实、异步处理。

**用 diagnostics 和 inspect 自证。** 你的 extension 的加载、激活、冲突、handler 失败都会以 `extension.*` diagnostic 呈现（`extension.load_failed`、`extension.activation_failed`、`extension.handler_failed`、`extension.action_failed`、各类 conflict 码）；`agent.inspect` 暴露 loaded extensions、hooks、贡献、patches 与 stale state。调试先看这两处。

## 参考实现

仓库内的锚点 consumer 都是可运行的完整示例：

- `tests/extensions/third-party-extension.ts`：版本化声明 + tool + line/inline 命令 + observers，只 import 作者契约。
- `tests/extensions/audit-extension.ts`：策略型 extension——observer 账本、`input` / `tool_call` 拦截、human approval、abort kill switch、custom entry。
- `tests/extensions/resource-extension.ts`：资源路径贡献。
- `tests/extensions/provider-extension.ts`：model-gateway 形态（registerProvider + `before_provider_request` 盖章）。

对应集成测试在 `tests/core/`（`third-party-extension.test.ts`、`audit-extension.test.ts`、`provider-extension.test.ts` 等），是各契约的回归锚点；写自己的 extension 测试时可用 `ExtensionLoader.registerExtension` 注入内存 factory，不必走文件 discovery。

## 与 Pi extension 的差异速查

从 pi coding-agent extension 迁移时的对照：

- `pi.on(event, handler)` → `api.observe()`（只读）与 `api.intercept()`（改写/阻断）两条通道；payload 同样按事件名收窄。
- Pi typed hook 中 WIDI 暴露 `before_agent_start` / `context` / `tool_call` / `tool_result` / `before_provider_request`；其余 harness 事实经 raw `agent_harness_event` 观察。`before_provider_payload` 与可取消 session hook 未收编（backlog 待举证）。
- Extension tool 不能覆盖 built-in tool 名，改行为用 `patchTool`。
- Provider 只能注册新名字，无 override/代理通道。
- `registerShortcut` / `registerFlag` / UI context 没有对应物：WIDI extension 只注册 UI-neutral 事实，呈现归 client adapter（extension host 尚在 backlog）。
- 消费输入的 `handled` 语义不存在：block + scoped actions，或注册命令。
