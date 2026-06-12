# Config Value Resolver 设计

本文记录 `apps/widi-pi/src/core/resolve-config-value.ts` 的设计边界。文件名是 TypeScript 实现，但这里讨论的是配置值解析这一层的抽象。

## 目标

`ConfigValueResolver` 用来把配置文件中的字符串值解析成运行时可用的值，例如 API key、provider header、模型配置中的动态字段等。

它保留 Pi coding-agent 原来的配置语义，但把运行时依赖从模块级全局能力改为显式注入：

- shell 命令通过 `ExecutionEnv.exec()` 执行。
- 环境变量通过 resolver 自己的公开方法 `getEnv()` 获取。
- 命令结果缓存归属于 resolver 实例。

这样做的目的，是让 WIDI 之后可以为不同模块或不同运行环境提供不同的 execution runtime，而不是把 `process.env`、`child_process` 或 Node shell 行为散落在配置解析逻辑中。

## 配置语义

resolver 支持四类配置值：

- `!command`：执行 `command`，使用 stdout 的 trim 结果。
- `$ENV_NAME`：读取环境变量。
- `${ENV_NAME}`：读取环境变量。
- 普通字符串：按 literal 处理。

在非命令字符串中支持转义：

- `$$` 表示字面量 `$`。
- `$!` 表示字面量 `!`。

如果环境变量不存在、环境变量为空字符串、命令失败、命令返回非零 exit code，或者命令 stdout 为空，解析结果为 `undefined`。

## Runtime 边界

`ExecutionEnv` 只负责 shell 和文件系统能力。对 config resolver 来说，目前只使用其中的 shell 能力：

```ts
executionEnv.exec(command, { timeout: commandTimeoutSeconds })
```

`getEnv()` 不属于 `ExecutionEnv`。它是 `ConfigValueResolver` 的公开方法，并且可以通过构造参数覆盖：

```ts
new ConfigValueResolver(executionEnv, {
  getEnv: (name) => process.env[name],
});
```

这个边界是刻意保留的：

- `ExecutionEnv` 不需要扩展成“配置解析 runtime”。
- 未来 Python、Go 或 sandbox runtime 只需要实现 shell/file 行为。
- 环境变量来源可以由 resolver 子类、构造参数或应用入口单独决定。

## API 形状

核心类型：

```ts
export type MaybePromise<T> = T | Promise<T>;
export type GetEnv = (name: string) => MaybePromise<string | undefined>;

export interface ConfigValueResolverOptions {
  commandTimeoutSeconds?: number;
  getEnv?: GetEnv;
}
```

核心方法：

- `getEnv(name)`：公开的环境变量读取边界。
- `resolveConfigValue(config)`：解析配置值，命令结果使用实例缓存。
- `resolveConfigValueUncached(config)`：解析配置值，但命令不读写缓存。
- `resolveConfigValueOrThrow(config, description)`：解析失败时抛出带来源说明的错误。
- `resolveHeaders(headers)`：解析 header map，跳过无法解析的 header。
- `resolveHeadersOrThrow(headers, description)`：解析 header map，任何 header 无法解析都会抛错。
- `clearConfigValueCache()`：清理当前 resolver 实例的命令缓存。

辅助方法用于诊断和 UI：

- `getConfigValueEnvVarName(config)`
- `getConfigValueEnvVarNames(config)`
- `getMissingConfigValueEnvVarNames(config)`
- `isCommandConfigValue(config)`
- `isConfigValueConfigured(config)`
- `isLegacyEnvVarNameConfigValue(config)`

## 为什么是实例而不是模块函数

Pi coding-agent 可以暴露模块级函数，是因为它隐式绑定了 Node 运行时：

- 环境变量来自 `process.env`。
- 命令执行来自 `child_process`。
- 缓存是模块级全局状态。

WIDI 引入 `ExecutionEnv` 后，解析配置时必须知道“使用哪个运行环境”。因此 resolver 需要一个上下文。当前选择 `class ConfigValueResolver`，主要是为了自然持有：

- `executionEnv`
- `getEnv`
- 命令 timeout
- 命令缓存

这不是唯一设计。也可以做成 `createConfigValueResolver()` factory，但仍然会返回一个带上下文的 resolver 对象。相比之下，继续暴露模块级全局函数会重新引入隐式全局 runtime，不符合 WIDI 当前想要的模块化边界。

## 使用建议

应用入口或 runtime service 负责创建 resolver：

```ts
const configValueResolver = new ConfigValueResolver(executionEnv, {
  getEnv: (name) => process.env[name],
});
```

业务模块不要直接读取 `process.env` 或执行 shell。需要解析配置值时，接收一个 resolver 实例，或接收更窄的函数依赖，例如 `resolveConfigValueOrThrow`、`resolveHeadersOrThrow`。

`ModelRegistry` 这类模块后续应依赖 resolver，而不是直接依赖 Node API。
