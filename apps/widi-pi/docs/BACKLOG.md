# WIDI Backlog

非当前 milestone 的 P1/P2 与评估类条目。条目升入 [TODO](TODO.md) 的门槛是 consumer 举证：说明哪个已存在的 consumer/测试需要它。

## Diagnostics And Presentation

- UI/RPC presentation：基于现有 `agent.inspect` facts 展示 profile、resources、tools、active tools、extensions、session metadata、custom entries 摘要和 diagnostics。
- Resource diagnostics severity 定义：explicit missing、default dir missing、parse failed、duplicate identity。
- Resume 路径 diagnostics 测试补齐：profile missing/disabled、resource diagnostics、active tool missing、extension missing。
- Extension diagnostic code 标准化：`extension.missing`、`extension.load_failed`、`extension.version_incompatible`、`extension.activation_failed`、`extension.handler_failed`。
- Diagnostic event 增加 stable id 或 operation correlation，便于 UI/RPC 去重与回放。
- Discovery 路径规范化去重（CLI adapter 反向检验发现，2026-07-09）：当 cwd 的项目 `.widi` 与 `agentDir` 指向同一目录时，profile/extension 被重复发现——`profile.source_overridden` 出现自指消息（"X is overridden by X"）且发两次，`extension.entry_missing` 对同一 extension 发三次。Discovery 应对 root 路径做 canonicalize + 去重，或至少让 override diagnostic 跳过同路径。

## Extension

Extension surface 的设计与实施已收编为 [ME milestone](TODO.md#me-extension-surfacem2-之后m3-之前)，方案见 [Extension Experiment](core/extension-experiment.md)，不在 backlog 重复维护。ME 明确排除、留此待举证的：

- Product presentation：`agent.inspect` facts 的产品级 UI/RPC 呈现（随 client adapter 工作举证）。
- Extension 间 EventBus（pi `events` 对应物）。
- `setLabel`（依赖 pi session label 的 upstream 对齐）。
- `user_bash` hook（依赖 M2 coding tools 的 bash 能力）。
- Client adapter 的 extension host（shortcut/flag/renderer 等 UI 自由度的承载处）。

## Session And State

- Missing extension、version mismatch、restore failed 时如何展示已有 custom entries。
- Header metadata schema version/migration（在出现第二个写入者之前不做）。
- （custom entry fork/compaction/export 与 `custom_message` policy 已入 [ME 切片 7](TODO.md#me-extension-surfacem2-之后m3-之前)。）
- Inline command 展开的 session custom entry 具体 shape（原始输入 + 展开位置，裁决见 command-experiment.md）。

## Profiles And Resources

- Profile `capabilities` 到 runtime policy 的剩余映射：`canRequestUser`（`acceptsUserInput` 已被 command gateway 消费，`canSpawn` 属 M3）。
- `capabilities` 字段更名评估（review 建议 `permissions`/`policy`，与 Core Capability 消歧）。
- Resource registry 评估：当前 resource loader 只做轻量加载，等 resources 复杂化再决定。
- Duplicate skill/prompt template 处理：diagnostic、覆盖、合并或保留全部。
- Resolved resource source 是否进入 inspect facts、harness metadata 或 session custom entry。
- Profile frontmatter schema 文档和示例（含 `commands` 门控字段）。

## Model / Auth / Settings

- `models.json` schema 文档和示例。
- 带多进程锁的 auth/config storage backend（依赖 M2 的单进程假设裁决）。
- 多 agent 场景下 auth/model/settings 按 workspace 共享还是按 profile/runtime 隔离。
- Provider registration 从 Pi global reset 模式收敛为 runtime scope，或记录当前全局副作用边界。
- 通用 `/set <key> <value>` settings command 评估（等第三个 settings 类需求，见 command-experiment.md）。
- `enableSkillCommands` 悬空设置处置（2026-07-09 发现）：setting-manager 有字段与 getter（默认 true）但无任何消费者。字面语义（skill 名注册为 line command）与现有两条通道——`<skill:...>` inline 展开、system prompt 的 `<available_skills>` 列表——是第三种语义。要么接线并写清与前两者的分工，要么删除字段。

## UI / RPC / Product Preset

- 第一版 WIDI product preset：默认 profile、model policy、coding tools 可见性、extension set。
- 最小 CLI/TUI/RPC adapter 边界：只通过 orchestrator events + `inputAgent` + 原子方法交互（最小 stdout adapter 已落地，见 TODO M2）。
- "Active agent" 一等事实（CLI adapter 反向检验发现，2026-07-09）：`cli.ts` 的 `getNextAgentId` 被迫硬编码 `fork`/`new`/`resume` 命令名并从未类型化的 `InputResult.value` 挖 `agentId`——adapter 不该内建命令语义。候选形态：InputResult 类型化 command 结果，或 orchestrator 事件面出 "active agent changed" 事实。随 ME 切片 2/3 的公开面收口一并裁决。
- Session selector、profile selector、model auth guidance、diagnostics panel 的 product TODO。
- `/team`、`/flow`、`/goal` 作为 extension 还是 preset 的评估。
- RPC/serialization schema：等真实 RPC consumer 出现，从 `listCommands()` 事实 + 原子方法签名生成。

## Pi Upstream 对齐

内容与理由见 [Pi Upstream Roadmap](core/pi-upstream-roadmap.md)，此处只列条目（建议升级为 upstream issue/PR）：

- ExecutionEnv lock/transaction/lease。
- Interactive shell session 原语：start、poll、write stdin、cancel、yield timeout、output cursor/truncation、cleanup。
- Harness queue item id 与 queued input cancellation。
- Provider registration scope。
- `^0.79.9` 版本锚点：package.json 声明 npm 版本但实际解析到 submodule workspace，两条轨道定一个事实来源。
