# Model 与 Auth 管理

本文记录 `apps/widi-pi/src/core/model-registry.ts`、`auth-storage.ts` 和 `resolve-config-value.ts` 当前已经落地的设计。

## 当前定位

WIDI 复用 `@earendil-works/pi-ai` 提供的模型和 OAuth 基础能力：

- 内置 provider 与 model 来自 `getProviders()`、`getModels()`。
- OAuth provider、登录、刷新 token 等能力来自 `pi-ai/oauth`。
- 动态 provider 通过 `registerApiProvider()` 和 `registerOAuthProvider()` 接入。

WIDI 自己负责的是更靠近应用运行时的部分：

- 如何读取 `models.json`。
- 如何存储和刷新用户凭据。
- 如何把 `apiKey`、headers、OAuth、runtime override 合并成一次模型请求需要的认证信息。
- 如何让这些 I/O 与 shell 行为统一通过应用传入的 `ExecutionEnv` 运行。

## 运行时依赖关系

`ModelRegistry.create()` 以 `ExecutionEnv` 作为主入口依赖。如果调用方没有显式传入
`AuthStorage` 或 `ConfigValueResolver`，registry 会基于同一个 `ExecutionEnv` 创建它们：

```ts
const configValueResolver = new ConfigValueResolver(executionEnv);
const authStorage = AuthStorage.create(executionEnv, { configValueResolver });
```

这样 `ModelRegistry`、`AuthStorage`、`ConfigValueResolver` 会共享同一个 runtime 边界：

- `ModelRegistry` 用 `ExecutionEnv.exists()` 和 `ExecutionEnv.readTextFile()` 读取 `models.json`。
- `FileAuthStorageBackend` 用 `ExecutionEnv.exists()`、`readTextFile()`、`writeFile()` 读写 `auth.json`。
- `ConfigValueResolver` 用 `ExecutionEnv.exec()` 解析 `!command` 配置值。

环境变量读取没有塞进 `ExecutionEnv`。它由 `ConfigValueResolver.getEnv()` 负责，默认读取 `process.env`，也可以在构造 resolver 时覆盖。这一点保持了 runtime I/O 与配置 env 来源的分离。

## 模块边界

`ModelRegistry` 负责模型注册表和请求认证装配：

- 加载内置模型。
- 加载 `models.json` 中的自定义模型、provider override、model override。
- 管理动态 provider 的注册和注销。
- 根据模型解析请求所需的 API key 和 headers。
- 暴露 provider auth status，供 UI 或 orchestrator 判断模型是否可用。

`AuthStorage` 负责凭据生命周期：

- 持久化 API key 和 OAuth credential。
- 支持 runtime API key override。
- 支持 fallback resolver，例如 `models.json` 中声明的 provider API key。
- 登录、登出 OAuth provider。
- 在 token 过期时刷新 OAuth token。

`ConfigValueResolver` 负责配置字符串解析：

- literal value。
- `$ENV` 和 `${ENV}`。
- `$$` 和 `$!` 转义。
- `!command`，通过 `ExecutionEnv.exec()` 执行并缓存结果。
- provider headers 与 model headers 也使用同一套解析语义。

## 模型来源与合并规则

模型列表由三类来源组成：

1. `pi-ai` 内置模型。
2. `models.json` 中定义的自定义模型与 override。
3. 运行时通过 `registerProvider()` 注册的动态 provider。

`models.json` 是可选文件。读取失败或 schema 校验失败时，错误会保存在
`ModelRegistry.getError()`，但 registry 仍然保留内置模型，避免一个损坏的自定义配置让整个模型列表不可用。

合并规则：

- provider-level override 可以覆盖内置 provider 的 `baseUrl` 和 `compat`。
- model-level override 会在 provider-level override 后应用。
- 自定义模型按 `provider + id` 与内置模型合并，冲突时自定义模型胜出。
- OAuth provider 可以在凭据存在时通过 `modifyModels()` 调整模型元数据。
- 动态 provider 如果声明了 models，会替换同 provider 下已有模型。
- 动态 provider 如果只声明 `baseUrl` 或 headers，则作为 override 应用到已有模型。

## `models.json` 中的认证配置

provider 配置可以声明：

- `apiKey`：支持 literal、env template、`!command`。
- `headers`：每个 header value 使用 `ConfigValueResolver` 解析。
- `authHeader`：将解析出的 API key 写入 `Authorization: Bearer ...`。

这些 request auth 信息不会直接塞进 `Model.headers`。它们保存在
`providerRequestConfigs` 和 `modelRequestHeaders` 中，在 `getApiKeyAndHeaders()` 时才解析。

这样做有两个原因：

- env 和 command 配置可以延迟到真正请求前解析。
- 错误信息可以带上 provider/model/header 的上下文。

## API Key 优先级

`AuthStorage.getApiKey()` 当前优先级是：

1. runtime override，例如 CLI `--api-key`。
2. `auth.json` 中保存的 API key。
3. `auth.json` 中保存的 OAuth token，必要时刷新。
4. `pi-ai` 约定的环境变量。
5. fallback resolver，除非调用方显式关闭。

`ModelRegistry.getApiKeyAndHeaders()` 会先向 `AuthStorage` 查询，并关闭 fallback：

```ts
authStorage.getApiKey(model.provider, { includeFallback: false })
```

如果没有拿到 key，再解析 `models.json` provider config 里的 `apiKey`。这样可以避免 `AuthStorage` 的 fallback 和 `ModelRegistry` 自己的 provider request config 重复参与同一轮解析。

## Auth Status 与实际解析

`hasConfiguredAuth()` 和 `getProviderAuthStatus()` 偏向“配置是否存在”的检查，而不是完整请求解析：

- 存在 runtime key、stored credential、env key、fallback 时，认为 provider 有 auth 来源。
- `models.json` 中的 `!command` 会被报告为 configured，但不会在 status 查询阶段执行。
- env template 会检查变量是否存在。
- OAuth token 是否需要刷新，由 `getApiKey()` 在真正取 key 时处理。

这个分层可以避免 UI 或模型发现阶段触发昂贵或有副作用的命令执行和 OAuth refresh。

## 锁与并发边界

当前 `FileAuthStorageBackend` 内部有一个 in-process `AsyncLock`，用于串行化同一个进程内对 `auth.json` 的 read-modify-write。

这个锁目前不能解决多进程并发写入问题。代码中已经把锁边界放在 backend 上：

```ts
withLockAsync(fn)
```

后续如果 WIDI 支持多个 agent、多个 orchestrator 或多个进程同时操作同一份 auth/config 文件，应优先在 backend 或 runtime service 层扩展锁能力，而不是让 `AuthStorage` 直接理解平台文件锁。

可选方向：

- 实现带文件锁的 `FileAuthStorageBackend`。
- 在默认 `ExecutionEnv` 外包一层 config I/O runtime，统一串行化配置读写。
- 在应用入口创建一个 runtime service，集中分发 `executionEnv`、`configValueResolver`、`authStorage`、`modelRegistry`。

## 设计判断

最初可能会认为 `ExecutionEnv` 只应该给 `AgentHarness` 执行工具使用。但现在 `models.json`、`auth.json`、JSONL storage、`!command` 配置值都需要文件系统或 shell 能力，因此让 core 配置与存储模块也依赖同一个 `ExecutionEnv` 是合理的。

关键边界是：

- `ExecutionEnv` 只表达 runtime I/O 与 shell 能力。
- `ConfigValueResolver.getEnv()` 单独表达环境变量来源。
- `AuthStorageBackend` 表达凭据存储与锁。
- `ModelRegistry` 不直接读写 auth 文件，也不直接访问 `process.env` 或 Node shell。

## TODO

- 设计带多进程锁的 auth/config storage backend。
- 明确 runtime service 的形状，以及它是否负责统一创建 `ExecutionEnv`、`ConfigValueResolver`、`AuthStorage` 和 `ModelRegistry`。
- 梳理 `models.json` schema 文档和示例。
- 评估多 agent 场景下是共享一套 runtime 与 auth storage，还是按 profile/workspace 隔离。
