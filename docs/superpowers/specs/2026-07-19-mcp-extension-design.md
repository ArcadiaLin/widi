# MCP Extension 设计

日期：2026-07-19
状态：已批准（用户确认）

## 目标

为 widi-pi 实现第一个扩展：将标准 MCP server（本地 stdio 与远程 HTTP）包装成专用 tool 提供给 agent 使用。扩展代码放在 `.widi/extensions/mcp/` 并 git 入库，使仓库内 `.widi/` 同时作为简易发行版样例。

## 关键决策（已与用户确认）

- Transport：stdio + StreamableHTTP 都支持。
- Server 配置放在独立的 `.widi/mcp.json`（Claude Code 风格 schema，便于复制现有生态配置）。
- 代码组织：`.widi/extensions/mcp/` + 根 `package.json` 添加 `@modelcontextprotocol/sdk` 依赖（jiti 从扩展目录向上解析到根 `node_modules`）。
- 连接生命周期：方案 A——激活时急切并行连接 + 单 server 容错降级 + 执行时断线重连一次。核心 `deactivate` 钩子留到后续迭代。

## 背景事实（探索结论）

- `apps/widi-pi/src/core/extension/` 已实现完整扩展运行时（jiti 加载 TS/JS，`EXTENSION_API_VERSION = 1`）。
- `<agentDir>/extensions` 与 `<cwd>/.widi/extensions`（信任门控）已是内置 discovery root（`runtime-service.ts` `createExtensionRoots`）。`npm run tui` 时 agentDir 即仓库 `.widi/`。
- profile frontmatter `extensions: [id]` 按 agent 激活扩展；当前 `widi-dev` profile 未声明。
- 扩展激活 API：`registerTool` / `patchTool` / `contributeResources` / `registerProvider` / `observe` / `intercept`；`activate` 可为 async。
- `ToolDefinition.parameters` 声明为 TypeBox `TSchema`，但 pi-ai `validateToolArguments` 对非 TypeBox 的 JSON Schema 有 fallback（`coerceWithJsonSchema`），MCP `inputSchema` 可转型直接使用。
- 工具名冲突 first-registration-wins 并产生 diagnostic，故 MCP 工具必须加前缀。
- 扩展 API v1 无 dispose/deactivate 钩子；reload 会使旧 context 失效（`invalidate()`），但外部连接无清理通道。
- 根 `.gitignore` 整体忽略 `.widi/`（现有文件为 force-add），`.widi/extensions/` 需要加例外。
- 当前无 `@modelcontextprotocol/sdk` 依赖。

## 布局

```
.widi/
├── mcp.json                     # 新增：server 配置
├── extensions/mcp/              # 新增：扩展本体，git 入库
│   ├── index.ts                 # 入口：default export { apiVersion: 1, activate }
│   └── lib.ts                   # 连接/注册逻辑（client factory 可注入，便于测试）
├── profiles/widi-dev.md         # frontmatter 增加 extensions: [mcp]
```

其他改动：

- 根 `package.json`：新增依赖 `@modelcontextprotocol/sdk`。
- 根 `.gitignore`：增加 `!.widi/extensions/` 与 `!.widi/mcp.json` 例外；入库的样例 `mcp.json` 初始内容为 `{"mcpServers": {}}`。
- `apps/widi-pi/tests/extensions/mcp.test.ts`：新增测试。

## 配置格式（`.widi/mcp.json`）

```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@mcp/server-filesystem", "/tmp"], "env": {} },
    "remote-api": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer $TOKEN" } }
  }
}
```

- 含 `command` 走 stdio（`command`/`args`/`env`）；含 `url` 走 StreamableHTTP（`url`/`headers`）。二者互斥。
- `env` 与 `headers` 的值支持 `$VAR` 环境变量展开（与 `models.json` 的 `$ENV` 惯例一致）。
- 扩展从自身模块路径解析配置：`<extensionDir>/../../mcp.json`（即 `.widi/mcp.json`），不需要核心暴露 agentDir。

## 激活与数据流

1. `activate(api)`：
   - 读取并校验 `mcp.json`。
   - 并行连接所有 server（每个独立超时，默认 15s）。
   - 每个连接成功的 server 调 `listTools()`，逐个 `api.registerTool()`。
2. 工具注册：
   - 名称：`mcp_<server>_<tool>`，清洗为合法工具名字符（`[a-zA-Z0-9_-]`，其余替换为 `_`）。
   - `label`：`<server>: <tool>`；`description` 取 MCP tool 描述。
   - `parameters`：MCP `inputSchema` 经 `as unknown as TSchema` 转型直接使用；`strict: false`。
3. `execute`：
   - `client.callTool({ name, arguments })`。
   - MCP content blocks 映射为 `AgentToolResult`：text/resource 块拼接为文本内容；`isError: true` 时返回错误结果。
   - 调用抛错且判定为连接错误时，重建该 server 的 client 并重试一次；再失败则返回错误结果。

## 错误处理

- `mcp.json` 缺失：扩展 no-op，不报错（未配置 MCP 是正常状态）。
- 配置非法（JSON 解析失败 / server 条目既非 stdio 也非 http）：`reportDiagnostic` 警告，不注册任何工具。
- 单 server 连接失败或超时：diagnostic 警告（TUI 可见），其余 server 正常注册。
- 工具调用 MCP 层错误（`isError`）：映射为错误 `AgentToolResult`，由 agent loop 正常处理。

## 已知限制

- 扩展 API v1 无 dispose 钩子：TUI "Reload extensions" 后，旧 MCP client 与 stdio 子进程滞留至 widi-pi 进程退出。后续迭代在 `ExtensionRunner` 增加 `deactivate` 钩子后解决。

## 测试

`apps/widi-pi/tests/extensions/mcp.test.ts`，vitest：

- 用 SDK `InMemoryTransport` 创建 linked 对，起内存 fake MCP server（注册 echo 工具与报错工具）。
- 通过注入的 client factory 替换真实 transport，覆盖：
  - 连接成功 → 工具按 `mcp_<server>_<tool>` 注册，schema/description 正确透传。
  - `execute` 调用映射：text 结果、`isError` 结果。
  - 单 server 连接失败 → diagnostic + 其他 server 不受影响。
  - 配置缺失 → no-op；配置非法 → diagnostic。
  - 断线后重连一次重试。

## 不做的事（YAGNI）

- MCP resources / prompts 能力（v1 只做 tools）。
- OAuth / 复杂鉴权流程（仅静态 headers + env 展开）。
- 工具列表热更新 / server 运行时增删。
- 核心 dispose 钩子（后续迭代）。
