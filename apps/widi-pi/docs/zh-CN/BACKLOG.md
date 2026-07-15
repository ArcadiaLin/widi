# WIDI Backlog

本文只记录尚未进入近期 milestone、且需要真实 consumer 举证的问题。每项描述未解决的能力缺口或裁决点，不保存完成历史。

## Extension

- Extension 间 EventBus：需要先证明 extension 之间直接通信优于通过 orchestrator facts 或 shared external service 协作。
- `setLabel`：需要明确 Pi session label 与 WIDI session name 的产品语义差异。
- `user_bash` hook：需要独立于普通 bash tool call、`tool_call` interceptor 和 tool patch 的真实 consumer。
- `custom_message`：需要“持久化、进入 model context、extension 归因”这一独立组合的 consumer，并定义排队与 namespace 语义。
- Per-extension directory/KV：需要大型或跨 session state consumer，并同时定义多进程写入、reload 和 project trust 边界。
- `before_provider_payload`：需要直接修改 wire payload 的 consumer，并定义 unknown payload 的类型、审计和失败语义。
- Session read-only facade：需要读取完整 branch history 的 extension consumer，并定义 entry filter、branch path 与 custom namespace 关系。
- Context usage facts：需要 compaction/policy extension consumer，并确定 token usage 的来源与新鲜度。
- `message_end` mutation：需要替换最终 assistant message 的脱敏等 consumer，并定义 WIDI-owned hook 与失败语义。
- Tool metadata query：需要 parameters schema、prompt guidance 和 provenance 的 extension consumer；当前 name snapshot 不扩张。
- OAuth login initiation：需要可发起人类 OAuth 流程的产品入口，并定义 URL、code input 与 cancellation facts。
- Provider controlled override：需要企业代理类 extension consumer，并定义 provenance、确认和撤销语义。

## Session、Profile 与 Resources

- Session header metadata schema version/migration：出现第二个独立写入者或需要长期兼容时再建立。
- Core resource duplicate identity：定义 agent-dir、project 与 explicit roots 之间 skill/template 重名的 severity 和 disposition。
- Resource provenance persistence：当前 inspect facts 已提供 resolved source；进入 session metadata 或 recovery reference 需要恢复场景举证。
- `capabilities` 命名：评估是否改为 permissions/policy，避免与 core capability 混淆。
- Profile frontmatter reference：补充稳定 schema 与示例，包括 command policy；在公开分发 profile 前完成。

## Model、Auth 与 Settings

- `models.json` reference：补充 schema、custom provider/model、override 与 request auth 示例。
- 通用 settings command：出现第三个需要通过 command 修改 runtime/settings 的真实需求后，再评估受控 key surface；不直接暴露 SettingManager。

## Product Policy

- 第一版 product preset：确定默认 profile、model policy、coding tool visibility 与 extension set。
- Team/flow/goal ownership：出现具体产品模式后，裁决它们属于 extension、preset 还是二者组合。
