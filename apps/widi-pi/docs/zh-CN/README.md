# WIDI Pi 文档

Language: zh-CN

本目录记录 `widi-pi` 当前有效的设计边界、运行机制、扩展开发方式和近期规划。机制文档只描述当前事实与长期裁决；已经完成的实施过程由 Git 历史保存。

## 总览

- [核心设计](DESIGN.md)：产品定位、架构分层与长期边界。
- [近期里程碑](TODO.md)：三个顺序推进的总体目标。
- [候选事项](BACKLOG.md)：尚未进入里程碑且需要真实需求举证的问题。

## 核心机制

- [Runtime](core/runtime.md)：runtime composition、orchestrator、agent 生命周期、command input 与事件传递。
- [Extensions](core/extensions.md)：extension 公开契约、hook、贡献面、scoped actions 与状态边界。
- [Profiles And Resources](core/profiles-and-resources.md)：profile registry、resource loading 与恢复策略。
- [Sessions And Runtime](core/sessions-and-runtime.md)：Pi session tree、metadata、custom entry 与持久化边界。
- [Tools And Capabilities](core/tools-and-capabilities.md)：ToolRegistry、built-in tools、visibility、patch 与结果契约。
- [Diagnostics](core/diagnostics.md)：结构化 diagnostic 的契约、产生位置与发布边界。
- [Pi Upstream Roadmap](core/pi-upstream-roadmap.md)：应由 Pi 上游提供的底层原语。

## 开发指南

- [Extension 开发指南](extension-authoring.md)：第三方 extension 的发现、激活、API 与推荐做法。
- [Model 与 Auth](model-auth.md)：model、provider、auth storage 与配置值解析。
