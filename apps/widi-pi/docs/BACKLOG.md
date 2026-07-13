# WIDI Backlog

非当前 milestone 的 P1/P2 与评估类条目。条目升入 [TODO](TODO.md) 的门槛是 consumer 举证：说明哪个已存在的 consumer/测试需要它。

## Diagnostics And Presentation

- UI/RPC presentation：基于现有 `agent.inspect` facts 展示 profile、resources、tools、active tools、extensions、session metadata、custom entries 摘要和 diagnostics。
- Resource diagnostics severity 定义：explicit missing、default dir missing、parse failed、duplicate identity。
- Resume 路径 diagnostics 测试补齐：profile missing/disabled、resource diagnostics、active tool missing、extension missing。
- Extension diagnostic code 标准化：全部 code（`extension.factory_missing`、`extension.load_failed`、`extension.activation_failed`、`extension.handler_failed`、`extension.version_incompatible`——后者已随 ME 切片 10 落地）已存在，剩余是命名口径统一评估（如 `factory_missing` vs 文档曾用的 `missing`）。
- Diagnostic event 增加 stable id 或 operation correlation，便于 UI/RPC 去重与回放。
- Discovery 路径规范化去重（CLI adapter 反向检验发现，2026-07-09）：当 cwd 的项目 `.widi` 与 `agentDir` 指向同一目录时，profile/extension 被重复发现——`profile.source_overridden` 出现自指消息（"X is overridden by X"）且发两次，`extension.entry_missing` 对同一 extension 发三次。Discovery 应对 root 路径做 canonicalize + 去重，或至少让 override diagnostic 跳过同路径。

## Core Layout / Refactor

- Command gateway runtime collaborator：`inputAgent`、line/inline command execution、argument completion、gateway、command/input id 与 `command_*` event emission 已具备独立状态机形态。下一步可按 [Runtime Modules](core/runtime-modules.md) 的 narrow-host 规则从 `AgentOrchestrator` 抽出；`command.ts` 保持 command facts/parser/built-in binding 表，不承载执行状态机。
- `AgentRecord` 内部状态与 public snapshot 分离：ME 切片 2 公开面收口时一起裁决，避免 `AgentRecord` 继续作为 semi-public mutable shape 泄漏。
- 大文件后续拆分候选：`model-registry.ts`（models.json load/merge vs availability/query vs auth bridge）、`agent-profile.ts`（reference 解析 vs storage backend vs registry resolve/override）、`setting-manager.ts`（IO/migrate/merge vs typed getter/setter vs trust/extension-path privileged keys）、`extension/loader.ts`（discovery vs import/activation vs diagnostics）。
- 三份 `normalizePath` 语义分叉合并评估：settings 路径键、project trust 路径身份、虚拟 FS 段解析不是同一语义；统一前需要 characterization tests。
- `create*Diagnostic` 包装工厂化评估：当前各模块 wrapper 承载 domain 默认值与 code narrowing；没有第二消费者前不做泛化。

## Extension

Extension surface 的设计与实施已收编为 [ME milestone](TODO.md#me-extension-surfacem2-之后m3-之前)，方案见 [Extension Experiment](core/extension-experiment.md)，不在 backlog 重复维护。ME 明确排除、留此待举证的：

- Product presentation：`agent.inspect` facts 的产品级 UI/RPC 呈现（随 client adapter 工作举证）。
- Extension 间 EventBus（pi `events` 对应物）。
- `setLabel`（依赖 pi session label 的 upstream 对齐）。
- `user_bash` hook（依赖未来 bash tool 能力）。
- Client adapter 的 extension host（shortcut/flag/renderer 等 UI 自由度的承载处）。
- `custom_message` 通道（pi `sendMessage`：持久 + 进模型 context + extension 归因，ME 切片 7 裁决不做）：待真实 consumer 举证；届时需一并定 deliverAs/triggerTurn 排队语义与 customType namespace。
- Per-extension storage 目录/KV API（ME 切片 7 裁决不做）：custom entry 覆盖 session 相关状态，大存储 extension 经 `exec` 自理；真实需求出现时需一并裁决多进程写入、reload 与 trust 边界。
- `before_provider_payload` hook（ME 切片 9 裁决推迟）：改 raw wire payload，`unknown` 类型、API 形状相关、最难审计；pi harness 已暴露，待真实 consumer 举证失败语义与类型契约后桥接。
- OAuth login 发起面（ME 切片 9 裁决推迟）：extension `oauth` 配置已收编（refresh/getApiKey/modifyModels 可用），但 `login(callbacks)` 是人类交互流程，widi 无 /login command；待 /login command 或 client adapter host 举证，届时需定 login 回调（URL 打开、code 输入）的 human request 形态。
- Extension provider 受控 override 入口（ME 切片 9 裁决不做）：pi 的 `registerProvider("anthropic", { baseUrl })` 代理场景不收编，override 通道归 models.json；真实企业代理 extension 场景出现时评估「override 事实记录 + human request 确认」的受控形态。

## Session And State

- Missing extension / version mismatch / restore failed 时孤儿 custom entries 的产品展示：归 client adapter。`extension.version_incompatible` 语义已随 ME 切片 10 定案（2026-07-13）：blocked 档、依赖它的 spawn/resume 失败，见 extensions.md 公开契约节。core 侧保留语义已裁决（2026-07-13）：条目原样保留、不删不隐藏、经 `getAgentSessionTree` 可达，见 extensions.md custom entry 契约节。
- Header metadata schema version/migration（在出现第二个写入者之前不做）。
- （custom entry fork/compaction/export 与 `custom_message` policy 已随 ME 切片 7 定案，2026-07-13；契约见 extensions.md，未收编项的举证缺口见上方 Extension 节。）
- Inline command 展开的 session custom entry 具体 shape（原始输入 + 展开位置，裁决见 command-experiment.md）。

## Profiles And Resources

- `capabilities` 字段更名评估（review 建议 `permissions`/`policy`，与 Core Capability 消歧）。（到 runtime policy 的映射已无剩余待举证项：`acceptsUserInput` 归 command gateway，`canRequestUser` 归 extension scoped `requestHuman`（ME 切片 3），`canSpawn` 属 M3。）
- （Resource registry 评估已随 ME 切片 8 定案并落地，2026-07-13：不建 registry 类，loader 保持轻量路径解析，extension 贡献走激活期路径声明 `contributeResources()`；见 extension-experiment.md 切片 8 记录。）
- Duplicate skill/prompt template 处理：diagnostic、覆盖、合并或保留全部。（extension 贡献与 core 资源的冲突已随 ME 切片 8 落地：first-registration-wins + `extension.resource_conflict` diagnostic；core roots 之间的重复处理仍待定。）
- Resolved resource source 进 inspect facts 已随 ME 切片 8 落地（2026-07-13，agent snapshot `resources` 事实）；是否进 harness metadata 或 session custom entry 维持待举证。
- Profile frontmatter schema 文档和示例（含 `commands` 门控字段）。

## Model / Auth / Settings

- `models.json` schema 文档和示例。
- 带多进程锁的 auth/config storage backend（依赖 M2 的单进程假设裁决）。
- 多 agent 场景下 auth/model/settings 按 workspace 共享还是按 profile/runtime 隔离。
- Provider registration 从 Pi global reset 模式收敛为 runtime scope，或记录当前全局副作用边界。（extension 注册面的全局边界已随 ME 切片 9 裁决记录：global + provenance、生命周期绑 runner；pi-ai OAuth registry 的 process-global `resetOAuthProviders` 副作用仍在，多 registry 实例并存时需收敛。）
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
