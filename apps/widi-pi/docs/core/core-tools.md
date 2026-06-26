# Core Tools

Core tools 是 WIDI core 原生维护的 `ToolDefinition`。它们通常包装 `ExecutionEnv`、orchestrator 或其他 core capability，并通过 `ToolRegistry` resolve 后交给 Pi `AgentHarness`。

以后新增 core tool 时，应在本文对应 domain 下新增章节，记录以下信息：

- tool name、用途和输入 schema。
- 依赖的 execution environment capability。
- 成功结果的 `content` 和 typed `details`。
- 错误、截断、并发、持久化或与 Pi 行为差异等细节。

## Coding

Coding tools 面向文件读写和代码修改。当前已落地 `read` 与 `write` 的 WIDI-owned definition，但默认 builtin registry 接入仍由后续工作完成。

### `bash`

`bash` 执行 shell command，返回 stdout 和 stderr。它复刻 Pi coding-agent 的 bash tool 用户可见语义：输出从 tail 截断，失败时把已有输出和退出状态拼在同一个错误文本里，截断时把完整输出保存到临时文件并写入 `details.fullOutputPath`。

Definition:

- Source: `apps/widi-pi/src/core/tools/coding/bash.ts`
- Factory: `createBashToolDefinition(options?)`
- Name / label: `bash`
- Execution env: `{ kind: "harness", capabilities: ["shell", "filesystem"] }`

Input schema:

- `command: string`: 要执行的 bash command。
- `timeout?: number`: command timeout，单位为秒。缺省时没有 tool-level timeout。

Behavior:

- 默认通过 `ExecutionEnv.exec(command, options)` 执行，而不是在 tool 内直接 `spawn` 本地进程。
- `options.cwd` 默认为 `ExecutionEnv.cwd`，也可以通过 factory `cwd` option 覆盖。
- `options.commandPrefix` 存在时，会以 `${commandPrefix}\n${command}` 作为实际执行 command。
- stdout 和 stderr 都进入同一个输出流，保持 backend 回调到达顺序。
- 如果 backend 没有通过 `onStdout` / `onStderr` streaming 输出，tool 会回退使用 `ExecutionEnv.exec` 返回的 `stdout` 和 `stderr`。
- 执行期间如果提供了 `onUpdate`，有输出 chunk 时会发送当前 snapshot。
- `bash` 是阻塞式同步 tool：`execute()` 会等待 `ExecutionEnv.exec` 完成后才返回最终 tool result。
- `onUpdate` 只服务 UI/事件层 partial result；它不会让 tool call 提前结束，也不会唤醒模型继续推理。
- 当前 `bash` 不提供 session id、poll 或 write-stdin 语义。Codex 风格长命令续跑应由未来 interactive shell session capability 承担。
- command 无输出时，成功结果文本为 `(no output)`。

Default truncation:

- `BASH_DEFAULT_MAX_LINES = 2000`
- `BASH_DEFAULT_MAX_BYTES = 50 * 1024`
- bash 输出从 tail 截断，优先保留最后的输出，适合展示最终错误或汇总。
- 命中 line limit 时，结果末尾追加 `Showing lines ... Full output: ...`。
- 命中 byte limit 时，结果末尾追加 `Showing lines ... (50.0KB limit). Full output: ...`。
- 如果最后一行本身超过 byte limit，会保留该行末尾的部分内容，并标记 `lastLinePartial`。

Result:

- `content`: 单个 `{ type: "text", text }`。
- `details.truncation`: 仅在截断触发时存在，记录截断原因、总行数、总 bytes、输出行数、输出 bytes 和限制值。
- `details.fullOutputPath`: 仅在截断触发时存在，指向保存完整输出的临时文件。

Failure behavior:

- 非零 exit code 会抛错，错误文本为当前输出加 `Command exited with code ${exitCode}`。
- abort 会抛错，错误文本为当前输出加 `Command aborted`。
- timeout 会抛错，错误文本为当前输出加 `Command timed out after ${timeout} seconds`。
- 其他 `ExecutionEnv.exec` failure 会原样向外抛出。

Override seams:

- `operations.exec`
- `operations.createFullOutputFile`

WIDI 当前没有复刻 Pi bash tool 的 TUI render、elapsed timer、本地 shell transport、process tree kill 或 detached child tracking；这些属于 Pi coding-agent 的本地进程/UI backend。WIDI 的 tool 层只依赖 `ExecutionEnv.exec`，具体 shell/backend 行为由 execution environment 或 extension patch 决定。

### `read`

`read` 读取文件内容。它尽量复刻 Pi coding-agent 的 read tool 核心语义：文本内容进入 tool result `content`，文件路径、大小和截断信息进入 typed `details`。

Definition:

- Source: `apps/widi-pi/src/core/tools/coding/read.ts`
- Factory: `createReadToolDefinition(options?)`
- Name / label: `read`
- Execution env: `{ kind: "harness", capabilities: ["filesystem"] }`
- Supported image extensions: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`

Input schema:

- `path: string`: 要读取的文件路径，可以是相对路径或绝对路径。
- `offset?: number`: 从第几行开始读取，1-indexed。缺省时从第一行开始。
- `limit?: number`: 最多读取多少行。缺省时读取从 `offset` 到文件末尾的内容，再由默认截断规则限制输出。

Text behavior:

- 通过 `ExecutionEnv.absolutePath(path)` 解析 `absolutePath`。
- 通过 `ExecutionEnv.readTextFile(path)` 读取文本。
- `offset` 会转换为 0-indexed start line；小于 1 的值会被压到第一行。
- 当 `offset` 超过文件总行数时抛错：`Offset ${offset} is beyond end of file (...)`。
- `limit` 存在时先按行切片；如果后面还有内容，会在输出末尾追加 continuation notice。
- `limit` 不存在时按默认截断规则输出。

Default truncation:

- `READ_DEFAULT_MAX_LINES = 2000`
- `READ_DEFAULT_MAX_BYTES = 50 * 1024`
- 输出命中任一限制时停止，并追加 `Use offset=... to continue.`。
- 如果第一行本身超过 byte limit，不输出部分行，而是返回提示用户用 shell 精确读取该行的文本。

Text result:

- `content`: 单个 `{ type: "text", text }`。
- `details.path`: 原始输入路径。
- `details.absolutePath`: `ExecutionEnv.absolutePath` 的结果。
- `details.bytes`: 原始完整文件文本的 UTF-8 byte length。
- `details.truncation`: 仅在默认截断触发时存在，记录截断原因、总行数、总 bytes、输出行数、输出 bytes 和限制值。

Image behavior:

- 默认根据扩展名判断 MIME type，不读取 magic bytes。
- 命中支持的图片扩展名时，通过 `ExecutionEnv.readBinaryFile(path)` 读取二进制。
- 图片以 base64 image content 返回。
- WIDI 当前没有复刻 Pi read tool 的 TUI image render、图片 resize 或模型能力判断；这些依赖 Pi coding-agent 自己的 UI/runtime surface。

Image result:

- `content[0]`: `{ type: "text", text: "Read image file [${mimeType}]" }`
- `content[1]`: `{ type: "image", data, mimeType }`
- `details.mimeType`: 检测到的 MIME type。
- `details.bytes`: 图片二进制 byte length。

Override seams:

- `operations.absolutePath`
- `operations.readTextFile`
- `operations.readBinaryFile`
- `operations.detectImageMimeType`

这些 seams 主要服务测试、sandbox/backend patch 和未来 extension adapter；默认行为仍走 `ExecutionEnv`。

### `write`

`write` 创建或覆盖文件。它是 WIDI 第一版落地的 coding core tool，采用 Pi 风格 tool call/result/details 持久化：正文来自 tool call arguments，成功结果只返回短文本和结构化 details。

Definition:

- Source: `apps/widi-pi/src/core/tools/coding/write.ts`
- Factory: `createWriteToolDefinition(options?)`
- Name / label: `write`
- Execution env: `{ kind: "harness", capabilities: ["filesystem"] }`

Input schema:

- `path: string`: 要写入的文件路径，可以是相对路径或绝对路径。
- `content: string`: 要写入的完整文件内容。

Behavior:

- 通过 `ExecutionEnv.absolutePath(path)` 解析 `absolutePath`。
- 通过 `ExecutionEnv.writeFile(path, content)` 创建或覆盖文件。
- 默认语义是完整重写，不做 patch、merge 或 append。
- 文件系统 backend 如果支持创建父目录，应在 `writeFile` 层完成；tool 本身不额外实现目录创建。
- 如果缺少 execution env，会抛错：`write tool requires an execution environment with filesystem support.`

Concurrency:

- `write` 内部按 `absolutePath` 建立 mutation queue。
- 同一路径的并发写入会串行执行。
- 不同路径的写入可以并行。
- queue entry 在当前写入结束后释放；如果该 entry 仍是 map 中最新队列，会被清理。

Result:

- `content`: 单个 text result，格式为 `Successfully wrote ${content.length} bytes to ${path}`。
- `details.path`: 原始输入路径。
- `details.absolutePath`: `ExecutionEnv.absolutePath` 的结果。
- `details.bytes`: `content.length`。

Override seams:

- `operations.absolutePath`
- `operations.writeFile`

这些 seams 用于测试、sandbox/backend patch 和未来 extension adapter。需要修改写入策略时，优先通过 `ToolRegistry.patchTool("write", ...)` 或 factory operations 注入，而不是直接修改已注册的 tool object。
