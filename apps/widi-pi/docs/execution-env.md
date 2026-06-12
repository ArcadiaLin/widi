# ExecutionEnv 设计笔记

## 当前理解

`pi-agent-core` 把执行环境抽象为 `ExecutionEnv`。它由两部分能力组成：

- `FileSystem`：路径、文件读写、目录、临时文件等文件系统能力。
- `Shell`：通过 `exec()` 执行 shell 命令的能力。

这个抽象让 `AgentHarness` 不必直接依赖 Node.js 的 `fs`、`path`、`child_process` 等 API。只要实现了同一组能力，WIDI 理论上可以运行在不同 backend 上，例如 Node.js、本地 sandbox、Python bridge 或 Go bridge。

## 初版策略

初版不急着自定义新的 execution backend。`pi-agent-core` 已经通过 `@earendil-works/pi-agent-core/node` 暴露了 `NodeExecutionEnv`，它已经覆盖当前 WIDI core 需要的 Node 级别能力：

- 文件系统访问。
- 路径处理。
- shell 命令执行。
- 默认 shell env 合并。

因此 WIDI 初版可以直接使用 `NodeExecutionEnv` 作为默认 runtime。这样可以先把 orchestrator、resource loader、persistence manager、model registry 等上层边界设计清楚，再考虑替换底层 execution backend。

## 与配置解析的关系

`core/resolve-config-value.ts` 使用 `ExecutionEnv.exec()` 来解析 `!command` 形式的配置值，但它不会把环境变量读取强行塞进 `ExecutionEnv`。

当前边界是：

- `ExecutionEnv` 负责 shell/file 能力。
- `ConfigValueResolver.getEnv()` 负责环境变量读取。
- 应用入口或 runtime service 负责把两者组装起来。

这个设计避免把 `ExecutionEnv` 扩展成“配置解析 runtime”。未来如果某个 backend 的 env 来源不是 `process.env`，只需要替换 `ConfigValueResolver` 的 `getEnv` 来源。

## Runtime Service 方向

后续可以增加一个 runtime service，统一创建并分发运行时能力：

```ts
type RuntimeService = {
  executionEnv: ExecutionEnv;
  configValueResolver: ConfigValueResolver;
};
```

初版 runtime service 可以直接实例化 `NodeExecutionEnv`，并基于同一个 `executionEnv` 创建 `ConfigValueResolver`。这样每个 core 模块不需要自己决定 runtime 来源，只需要接收已经组装好的依赖。

## 未来扩展

需要继续学习和验证：

- 如何实现一个完整的非 Node `ExecutionEnv`。
- sandbox runtime 是否需要限制 shell、文件系统或 cwd。
- 多 agent 是否共享同一个 `ExecutionEnv`，还是按 agent/profile 分配不同 runtime。
- runtime service 是否需要生命周期管理，例如 cleanup、取消、资源释放。
