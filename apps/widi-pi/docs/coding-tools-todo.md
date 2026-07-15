# Coding Tools Implementation TODO

本文档定义 `apps/widi-pi/src/core/tools/coding` 从当前 `read/write/edit` 最小集补齐为完整 coding-agent 工具集的实施任务。目标集合已经由 [DESIGN.md](DESIGN.md#coding-tools) 裁决为：

- `read`
- `write`
- `edit`
- `bash`
- `grep`
- `find`
- `ls`

实现参考 `pi/packages/coding-agent/src/core/tools` 的参数、执行语义、输出截断和 typed details，但继续遵守 WIDI 已有边界：

- Tool definition 不包含 TUI renderer、theme、component 或 keybinding 能力。
- Tool definition 只返回 Pi `AgentToolResult`；展示由 raw harness events、tool arguments、result content 和 details 派生。
- 本地 backend 由 definition factory 捕获，并通过 typed operations 接口允许测试、sandbox、远程环境或 extension patch 替换。
- ToolRegistry 仍是唯一的 `ToolDefinition -> AgentTool` adapter。
- 不修改 `pi/*`；上游代码只作为行为参考。
- 不增加隐式下载外部 executable 的 tool manager。

## 当前状态

已实现：

- `read`：UTF-8 文本、offset/limit、head truncation、binary/image 分类。
- `write`：创建父目录、覆盖写、typed details、单文件 mutation queue。
- `edit`：批量精确替换、fuzzy normalization、BOM/换行保留、diff/patch details、单文件 mutation queue。
- `bash`：streaming update、abort、timeout、非零退出、tail truncation、完整输出落盘（切片 1）。
- `grep`：rg --json backend、context lines、match limit、单行截断（切片 2）。
- `find`：rg --files 枚举加 WIDI 层 glob 匹配、确定性排序、result limit（切片 2）。
- `ls`：case-insensitive 排序、dotfiles、目录后缀、entry limit（切片 2）。
- 共享：路径解析、文件 operations、mutation queue、head/tail truncation、output accumulator、进程生命周期 helper、rg resolve/spawn backend、glob 匹配。

缺失：

- `read` 图片结果、MIME 探测、转换/缩放和图片设置接线（切片 3）。
- system prompt composition 对 `promptSnippet`/`promptGuidelines` 的消费（切片 4）。
- 七工具注册收尾、smoke test 与文档验收（切片 4）。

## 实施原则

### Result 契约

- 成功结果的 `content` 面向模型，保持简短、可行动。
- 截断、路径、数量、完整输出位置等机器事实进入 typed `details`。
- 执行失败通过 throw 表达，不把失败伪装成成功 content。
- Abort error 统一使用 `Operation aborted`；bash 可以在错误消息前保留已经产生的输出。
- 路径型 details 同时保留调用参数中的 path 和解析后的 absolute path，延续现有 WIDI 工具风格。

### Backend 契约

- 每个工具暴露最小 typed operations 接口，不暴露整个 `ExecutionEnv`。
- 默认 operations 使用 Node 本地文件系统或进程 API。
- Operations 不包含 UI、registry、orchestrator 或 session 状态。
- Extension 若需要 sandbox、SSH、审计或确认，通过 `patchTool` 或替换 operations backend 实现。

### 外部 executable

- `grep` 和 `find` 的默认本地 backend 都使用 `rg`，避免同时引入 `fd`（上游 `find` 使用 `fd`，这是有意偏离）。
- `grep` 使用 `rg --json` 获取结构化 match event。
- `find` 使用 `rg --files` 获取 gitignore-aware 文件列表；用户 glob 在 WIDI 层匹配，因为 rg 的正向 `--glob` 会 override 全部 ignore 逻辑，把 gitignored 文件重新捞回来。
- executable 路径从显式 option 或 `PATH` 解析；不可用时抛出明确错误。
- 不在 tool execute 中联网下载 `rg`。
- 所有用户输入都作为 argv 元素传给 `spawn`，不得拼接进 shell command。

### 切片与提交

任务分为四个切片。每个切片以"工具注册进 ToolRegistry 并通过对应 Vitest 文件"为验收单位；切片内部提交粒度自由，但不要跨切片留半成品接线。每个提交保持根 `npm run check` 通过。

- 注册随切片走：每落地一个工具就在 `builtin.ts` 注册，最终顺序固定为 `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`，与 Pi coding-agent `ToolName` 顺序一致。
- `registerCoreCodingTools()` 接受 typed options，或由 runtime 构造 definitions 后逐一注册；不要把 `SettingManager` 本身传进 tool 模块。runtime 侧的 option 接线随需要它的工具切片落地（shell 配置随 bash、rg 路径随 grep/find、图片设置随 read）。

## 切片 1：`bash` 与共享输出/进程基础设施

`truncateTail`、output accumulator 和 process helper 的首个消费者都是 bash，与 bash definition 同切片交付，避免出现无验收锚点的中间提交。

### `truncate.ts`

- [x] 增加 `GREP_MAX_LINE_LENGTH = 500`。
- [x] 增加 `truncateTail()`，保留最后 N 行或最后 N bytes。
- [x] Tail byte truncation 在最后一行自身超过限制时允许返回该行尾部的 partial line，并设置 `lastLinePartial`。
- [x] 增加 UTF-8 边界安全的 tail byte slicing。
- [x] 增加 `truncateLine()`，返回 `{ text, wasTruncated }`。
- [x] 保持现有 `TruncationResult` 结构兼容 `read`。
- [x] 增加 trailing newline、空内容、多字节字符、首/尾超长单行测试。

### `output-accumulator.ts`

- [x] 新增有界内存的流式输出累计器。
- [x] 使用 streaming `TextDecoder`，正确处理跨 chunk 的 UTF-8 字符。
- [x] 维护 decoded tail、总 bytes、总行数和最后一行 bytes。
- [x] snapshot 使用 `truncateTail()`，适合展示命令结尾和错误。
- [x] 仅在超过展示限制或明确请求持久化时创建临时文件。
- [x] 临时文件写入原始输出 bytes，不因 UTF-8 decode 或截断损失内容。
- [x] 提供显式 `finish()` 和 `closeTempFile()` 生命周期。
- [x] operations resolve 后忽略迟到的 output callback。
- [x] 覆盖 line-only truncation、byte truncation、split UTF-8、迟到输出和临时文件完整性测试。

### 进程生命周期 helper

放在 `coding/process.ts` 或等价的 coding-owned helper 中，不让 `bash.ts` 和搜索工具分别实现一套；切片 2 的 grep/find 复用它。此 helper 不负责 shell command 解析，也不依赖 TUI。

- [x] 提供 typed spawn helper，支持 stdout/stderr pipe、cwd、env 和 abort。
- [x] Unix 使用 detached process group；abort/timeout 时终止整个进程树。
- [x] Windows 使用 `taskkill /F /T` 或等价的可靠 process-tree 终止策略。
- [x] 等待 child exit 后继续消费短时间内仍在输出的 inherited pipe。
- [x] 后台 descendant 静默持有 pipe 时必须通过 idle grace 结束等待，不能无限挂起。
- [x] stdout/stderr listener、abort listener 和 timeout handle 必须在所有结局中清理。
- [x] 测试 spawn failure、abort、timeout、exit 后迟到输出和静默 inherited pipe。

### `bash` definition

- [x] 新增 `bash.ts` 和 `BashToolInput`：`command`、可选 `timeout` 秒数。
- [x] 校验 timeout 是有限正数，且不超过 Node timer 上限。
- [x] 定义 `BashOperations.exec(command, cwd, options)` 注入边界。
- [x] 默认 backend 支持显式 `shellPath`、环境变量和 stdin command transport。
- [x] 支持 `commandPrefix`，以换行连接 prefix 与用户 command。
- [x] 设置 `promptSnippet` 和必要的 prompt guidelines。

### `bash` execution

- [x] 合并 stdout 和 stderr，保持到达顺序。
- [x] 使用 `OutputAccumulator` 保留最后 2000 行或 50KB。
- [x] `context.onUpdate` 首先发空 partial result，再以约 100ms 节流推送输出 snapshot。
- [x] tool promise settle 后不再接受或发送 update。
- [x] 空输出成功时返回 `(no output)`。
- [x] 非零 exit code 抛错，并在错误中保留已有输出和退出码。
- [x] Timeout 和 abort 抛错，并在错误中保留已有输出。
- [x] 截断时在 content 中给出展示行范围和 full output path。
- [x] `BashToolDetails` 包含可选 `truncation` 和 `fullOutputPath`。

### 注册与设置接线

- [x] 在 `builtin.ts` 注册 `bash`。
- [x] runtime 从 `SettingManager.getShellPath()` 和 `getShellCommandPrefix()` 传入配置。

### 测试

`coding-tools-shared.test.ts` 覆盖 truncation、accumulator 和 process helper；新增 `coding-bash-tool.test.ts` 覆盖：

- [x] 简单命令和无输出命令。
- [x] stdout/stderr 合并。
- [x] 非零退出、timeout、abort、cwd 不存在、shell 不存在。
- [x] command prefix 和自定义 shell path。
- [x] chatty output update 节流。
- [x] UTF-8 字符跨 chunk。
- [x] 行数与 bytes 截断、完整输出文件。
- [x] exit 后迟到输出不丢失，operations resolve 后迟到 callback 不污染结果。

## 切片 2：`ls`、`grep`、`find`

grep 和 find 共享 `rg` 的 executable resolve/spawn backend，一起实现避免 backend 接口返工；ls 体量小，随同切片交付。

### `ls`

- [x] 新增 `ls.ts`，参数为可选 `path` 和 `limit`。
- [x] 定义 `LsOperations.exists/stat/readdir`，默认使用 Node filesystem。
- [x] 校验 limit 是有限正整数；默认 500。
- [x] 路径相对 cwd 解析，missing path 和 non-directory 给出不同错误。
- [x] 包含 dotfiles。
- [x] 按 case-insensitive 字母序稳定排序。
- [x] 目录条目追加 `/`。
- [x] 无法 stat 的单个 entry 跳过，不让整个 listing 失败。
- [x] 按 entry limit 和 50KB 限制输出，写入 `entryLimitReached`/`truncation` details。
- [x] 空目录返回 `(empty directory)`。

### `grep`

- [x] 新增 `grep.ts`，参数为 `pattern`、可选 `path/glob/ignoreCase/literal/context/limit`。
- [x] 默认 limit 100，context 默认 0。
- [x] 校验 context 是非负整数，limit 是正整数。
- [x] 定义可注入 backend，至少隔离 executable resolve/spawn 和 context file read。
- [x] 默认 backend 使用 `rg --json --line-number --color=never --hidden`。
- [x] `--` 必须出现在 pattern/path 之前，flag-like pattern 不得成为 rg option。
- [x] rg exit 0 为有匹配，exit 1 为无匹配，其他 exit code 为执行错误。
- [x] 单文件搜索仍显示 basename 和 line number。
- [x] 目录搜索输出相对 search root 的 POSIX path。
- [x] 无 context 时直接使用 rg match event 的文本。
- [x] 有 context 时按文件读取内容并格式化前后行。
- [x] match 行格式为 `path:line: text`，context 行格式为 `path-line- text`。
- [x] 每个输出行通过 `truncateLine()` 限制到 500 chars。
- [x] 达到 match limit 时停止子进程并记录 `matchLimitReached`。
- [x] 最终输出按 50KB head truncation，并记录 `truncation`。
- [x] 无匹配返回 `No matches found`。

### `find`

- [x] 新增 `find.ts`，参数为 `pattern`、可选 `path/limit`。
- [x] 默认 limit 1000，校验为正整数。
- [x] 默认 backend 使用 `rg --files --hidden --sort path`；`--no-require-git` 仅在 search root 不在 git repo 内时添加（修订：固定添加会把父级 `.gitignore` 应用进 nested repo）。
- [x] 固定排除 `.git` 和 `node_modules`；不要排除其他未被 gitignore 的 dotfiles。
- [x] 用户 glob 不传给 rg（修订：正向 `--glob` override ignore 规则），在 WIDI 层对相对路径做 glob 匹配；用户输入仍不经 shell。
- [x] 输出相对 search root 的 POSIX path。
- [x] 结果排序必须确定：使用 `rg --sort path`，limit 早停得到确定性前缀。
- [x] 达到 result limit 时停止读取并记录 `resultLimitReached`。
- [x] 最终输出按 50KB head truncation。
- [x] 无结果返回 `No files found matching pattern`。

Characterization 结论（已固定为 `coding-find-tool.test.ts` 中的测试）：git repo 内 rg 默认让父级 `.gitignore` 停在 nested repo 边界，`--no-require-git` 则会跨边界应用父级规则，因此该 flag 只在 repo 外使用；正向 `--glob` override 全部 ignore 逻辑，因此用户 glob 移到 WIDI 层匹配。两项合计达到了上游 `fd` 语义，未引入 `fd`。

### 注册与测试

- [x] 在 `builtin.ts` 注册 `ls`、`grep`、`find`；runtime 传入可选 rg executable path。
- [x] `coding-ls-tool.test.ts`：排序、dotfiles、目录后缀、空目录、limit、missing 和 abort。
- [x] `coding-grep-tool.test.ts`：regex、literal、ignoreCase、glob；单文件 basename、目录相对路径；context lines 和 match limit；long line truncation；gitignore、hidden file 和无匹配；flag-like pattern 注入防护；rg missing、rg error 和 abort。
- [x] `coding-find-tool.test.ts`：path-containing glob、hidden file、gitignore、nested repo boundary、invalid glob、limit、missing path 和 abort。

## 切片 3：`read` 图片能力与全局图片 policy

保持独立切片：photon 依赖、worker/WASM 构建风险和跨 runtime 的 blockImages policy 都与其他切片无关。

### MIME 探测

- [ ] 把当前 `read.ts` 内部 image signature 判断抽成 `image/mime.ts` 或等价纯函数模块。
- [ ] 支持 JPEG、PNG、GIF、WEBP、BMP 的内容探测，不按扩展名猜测。
- [ ] 拒绝异常 JPEG、animated PNG 或无法安全解析的伪装文件。
- [ ] MIME 探测只读取小段 header；operations 注入需要允许远程 backend 自定义探测。
- [ ] 非图片仍走严格 UTF-8 文本或 binary unsupported 分支。

### 图片处理

- [ ] 在 `apps/widi-pi/package.json` 直接声明 `@silvia-odwyer/photon-node`，不依赖未声明的上游传递依赖。
- [ ] 参考 Pi 的 Photon 实现移植图片 normalize、EXIF orientation、conversion 和 resize helper，去除 TUI 相关逻辑。
- [ ] PNG/JPEG/GIF/WEBP 可以直接作为 provider 支持格式；BMP 转为 PNG。
- [ ] 默认按 provider inline 限制进行尺寸和编码大小压缩。
- [ ] CPU 密集的 decode/resize 默认在 worker thread 执行，并提供 worker 不可用时的 in-process fallback。
- [ ] 构建配置必须包含 worker entry 和 Photon WASM 资产；源码运行与 `dist` 运行都要验证。
- [ ] `ReadToolOptions` 增加 `autoResizeImages` 和 typed image processor operations，测试不加载真实 WASM。

### Read result

- [ ] 图片读取成功时返回一条 text note 加一个 `ImageContent` block。
- [ ] Text note 写明最终 MIME；发生转换或缩放时包含转换、原始尺寸和显示尺寸提示。
- [ ] 图片处理失败时返回 text-only omitted note，不抛出伪文件读取错误。
- [ ] `ReadToolDetails` 对图片记录原始 bytes、原始/最终 MIME、是否转换、是否缩放和尺寸信息。
- [ ] 更新 `read` description，明确支持的图片格式和文本截断规则。
- [ ] `offset/limit` 对图片忽略还是拒绝必须固定为一种行为；建议拒绝并给出明确参数错误，避免静默忽略模型输入。

### Model 和禁图策略

- [ ] 不把当前 model 塞进 WIDI `ToolExecutionContext`。Pi AI 的 `transformMessages()` 已会在非视觉模型请求中把 tool image block 降级为 text placeholder。
- [ ] `images.blockImages` 必须成为真实 runtime policy，而不是只在 `read` 中局部生效。
- [ ] 在进入 provider request 前统一过滤 user/tool images，保证"阻止所有图片发送给 provider"的设置语义成立。
- [ ] `read` 在 blockImages 开启时返回 text-only blocked note，不生成 base64 image block，避免无用的 session 体积。
- [ ] `images.autoResize` 从 `SettingManager.getImageSettings()` 接入 read definition。
- [ ] 非视觉模型、blockImages 和普通 vision model 三条路径分别测试。

### 测试与构建验证

扩展 `coding-read-tool.test.ts`；image helper 中适合共享测试的部分进 `coding-tools-shared.test.ts`。

- [ ] MIME signature：合法和伪装 JPEG/PNG/GIF/WEBP/BMP。
- [ ] BMP 转 PNG、EXIF orientation、超尺寸 resize、无需 resize。
- [ ] Processor failure 返回 text-only note。
- [ ] `ImageContent` base64 和 MIME 正确。
- [ ] Registry adapter 和 Pi session tool result 能保存 image content。
- [ ] 非视觉模型 provider request 中图片被替换为 placeholder。
- [ ] blockImages 时 user input 和 tool result 图片均不进入 provider payload。
- [ ] 运行 `npm --workspace apps/widi-pi run build` 并验证 worker/WASM 可加载；单纯 typecheck 无法发现 worker 或 WASM 资产缺失。

## 切片 4：prompt guidance、注册收尾与验收

### Prompt guidance

`promptSnippet` 和 `promptGuidelines` 目前未被任何 system prompt composition 消费；先补唯一 composition 路径，再依赖这些字段改善 tool selection。

- [ ] 补 WIDI system prompt composition 对 `promptSnippet`/`promptGuidelines` 的消费。
- [ ] `read` guideline 优先读取文件，不用 bash `cat/sed`。
- [ ] `grep` guideline 用于内容搜索，`find` 用于路径搜索，`ls` 用于单层目录浏览。
- [ ] `write` 只用于新文件或完整重写；局部变更使用 `edit`。
- [ ] `bash` 用于构建、测试、版本控制和无法由专用工具表达的命令，不替代精确的 read/grep/find。

### 注册收尾

- [ ] `builtin.ts` 注册顺序固化为 `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`。
- [ ] Runtime service 测试断言七个 core tool names、source 和 registration order。
- [ ] Profile 未声明 `tools` 时七个工具默认可见；显式 profile allowlist 继续只控制 visibility。
- [ ] Session resume 的旧 active tool names 继续通过 ToolRegistry 校验，不做兼容别名。
- [ ] 根据实际外部消费者决定是否增加 `coding/index.ts`。只有存在跨模块批量 import 需求时才添加，避免纯 barrel 文件。

### 验收与文档

- [ ] 运行完整 package tests 和 `npm --workspace apps/widi-pi run build`。
- [ ] 从仓库根运行 `npm run check`。
- [ ] 用真实临时目录做一次七工具 smoke test，不依赖 TUI。
- [ ] 更新 [TODO.md](TODO.md)、[DESIGN.md](DESIGN.md) 和相关机制文档中的"最小集/未来 bash"陈述。
- [ ] Bash 落地后复核 [BACKLOG.md](BACKLOG.md) 中 `user_bash` hook 的 consumer 条件，但不在本任务顺带实现 hook。

## 完成标准

- ToolRegistry 默认解析出七个 core coding tools，且没有 diagnostics。
- 七个工具都通过 WIDI `ToolDefinition` 和 registry adapter 执行，不包含 TUI import。
- Bash 支持 streaming update、abort、timeout、非零退出、tail truncation 和完整输出落盘。
- Grep/find 不经过 shell 拼接用户参数，并尊重既定 ignore、limit 和 truncation 语义。
- Read 能返回 provider-compatible `ImageContent`，并正确处理 resize、conversion、非视觉模型和 blockImages。
- 所有本地 backend 都可通过 typed operations 替换。
- Package tests、build 和根 `npm run check` 全部通过。

## 非目标

- Multi-agent collaboration tools。
- TUI tool call/result renderer。
- 自动下载 `rg`、`fd` 或 shell。
- 在 core tool 中实现通用 sandbox policy。
- 为旧工具名、旧参数或未发布行为保留兼容层。
- 修改 `pi/packages/coding-agent` 或其他 `pi/*` vendor 源码。
