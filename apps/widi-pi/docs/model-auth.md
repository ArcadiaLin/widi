# Model 与 Auth 管理

本文记录 `apps/widi-pi/src/core/model-registry.ts`、`auth-storage.ts` 和
`resolve-config-value.ts` 当前已经落地的设计。WIDI 已采纳 `pi-ai` 新的
provider runtime：模型、provider、认证解析和 stream 委派都围绕 `Provider`
与 `Models` 运行，而不是围绕一组静态 model/provider 表。

## 当前定位

`@earendil-works/pi-ai` 负责模型请求的核心 runtime：

- `Provider` 是具体运行单元，拥有 `id`、`name`、模型列表、stream 行为和
  `Provider.auth`。
- `Models` 是 provider 集合，由 `createModels()` 创建，负责 provider 查询、模型查询、
  动态模型刷新、认证解析和请求委派。
- `Models.getAuth(model)` 是 pi-ai 层的权威认证解析入口，返回一次请求需要的
  `apiKey`、headers、`baseUrl` 和来源标签。
- 内置 provider 来自 pi-ai 的 provider factories；WIDI 加载它们后再应用本地配置。

WIDI 自己负责应用运行时边界：

- 读取 `models.json`，合并内置 provider、custom model、provider override 和 model
  override。
- 提供 `AuthStorage` 作为 pi-ai `CredentialStore`。
- 提供 `AuthContext`，把 env 与 file-exists 查询接入 WIDI runtime。
- 解析 `models.json` 中的 `apiKey`、headers、`authHeader` 等 request auth 配置。
- 管理动态 provider 注册、注销和刷新后的重建。
- 将 auth/model 加载和请求期错误转成 `CoreDiagnostic`。

这意味着 WIDI 不再把 model/auth 设计为一份独立静态注册表。`ModelRegistry` 是
WIDI 对 pi-ai `Models` runtime 的应用层包装。

## 运行时依赖关系

`ModelRegistry.create()` 以 `ExecutionEnv` 作为主入口依赖。如果调用方没有显式传入
`AuthStorage` 或 `ConfigValueResolver`，registry 会基于同一个 `ExecutionEnv` 创建它们：

```ts
const configValueResolver = new ConfigValueResolver(executionEnv);
const authStorage = AuthStorage.create(executionEnv, { configValueResolver });

const runtime = createModels({
  credentials: authStorage,
  authContext: {
    env: async (name) => await configValueResolver.getEnv(name),
    fileExists: async (path) => {
      const result = await executionEnv.exists(path);
      return result.ok ? result.value : false;
    },
  },
});
```

这形成了三层边界：

```text
ExecutionEnv
  -> read/write models.json
  -> read/write auth.json
  -> check files for AuthContext.fileExists()
  -> execute !command config values

ConfigValueResolver
  -> resolve literal / $ENV / ${ENV}
  -> resolve !command through ExecutionEnv.exec()
  -> provide AuthContext.env()

pi-ai Models runtime
  -> read credentials through AuthStorage
  -> resolve Provider.auth through AuthContext
  -> apply auth to stream requests
```

环境变量读取没有直接塞进 `ExecutionEnv`。它由 `ConfigValueResolver.getEnv()` 负责，
默认读取 `process.env`，也可以在构造 resolver 时覆盖。文件系统、shell 与 env 来源
因此仍然保持分离。

## 模块边界

`ModelRegistry` 负责 WIDI 的模型运行时装配：

- 创建并持有 pi-ai `MutableModels`。
- 加载 pi-ai 内置 provider。
- 读取 `models.json` 并应用 provider/model override。
- 创建 `models.json` 中声明的 custom provider。
- 管理运行时 `registerProvider()` 注册的 dynamic provider。
- 包装 provider auth，把 WIDI request auth 配置合并进 pi-ai `Provider.auth`。
- 暴露 `getRuntime()`，供 orchestrator 直接使用 pi-ai `Models` 接口。
- 暴露 `getApiKeyAndHeaders()`，供仍需要显式 `{ apiKey, headers }` 的调用点使用。
- 发布 model/auth diagnostics。

`AuthStorage` 负责凭据生命周期，同时实现 pi-ai `CredentialStore`：

- 持久化 API key 和 OAuth credential。
- 支持 runtime API key override。
- 支持 `read()`、`modify()`、`delete()` 三个 pi-ai credential store 方法。
- 在 `read()` 中解析保存于 `auth.json` 的 config-valued API key。
- 在 `modify()` 中提供串行化 read-modify-write，供 pi-ai OAuth refresh 使用。
- 保留 WIDI 自己的 login/logout、status、legacy API key 查询能力。

`ConfigValueResolver` 负责配置字符串解析：

- literal value。
- `$ENV` 和 `${ENV}`。
- `$$` 和 `$!` 转义。
- `!command`，通过 `ExecutionEnv.exec()` 执行并缓存结果。
- provider headers 与 model headers 也使用同一套解析语义。

## 模型来源与合并规则

当前模型列表由四类来源组成：

1. pi-ai 内置 provider。
2. `models.json` 中定义的 custom provider/model 与 override。
3. 运行时通过 `registerProvider()` 注册的 dynamic provider。
4. extension 经激活期 `registerProvider()` 贡献的 provider（ME 切片 9）：
   `registerExtensionProvider()` 走严格校验路径（只许新 provider 名、必须带完整
   models），按 (extension, agent) 记账，runner reload/dispose 时经
   `unregisterExtensionProviders()` 撤销；契约见
   [Extensions](core/extensions.md)。

`models.json` 是可选文件。读取失败或 schema 校验失败时，错误会保存在
`ModelRegistry.getError()`，但 registry 仍然保留内置模型，避免一个损坏的自定义配置
让整个模型列表不可用。同一失败也会记录为 `model.load_failed` diagnostic，可通过
`getLoadDiagnostic()` 或 `drainDiagnostics()` 读取。

合并顺序：

```text
pi-ai built-in providers
  -> provider-level baseUrl / compat override
  -> model-level override
  -> custom models merged by provider + model id
  -> dynamic providers reapplied after refresh()
```

合并规则：

- provider-level override 可以覆盖内置 provider 的 `baseUrl` 和 `compat`。
- model-level override 在 provider-level override 后应用。
- custom model 按 `provider + id` 与内置模型合并，冲突时 custom model 胜出。
- custom provider 会通过 `createProvider()` 构造成 pi-ai `Provider`。
- dynamic provider 如果声明了 models，会替换同 provider 下已有 provider runtime。
- dynamic provider 如果只声明 `baseUrl` 或 headers，则作为 override 应用到已有模型。

## pi-ai Auth Runtime

pi-ai 的认证模型由三部分组成：

```text
Provider.auth
  -> apiKey.resolve({ model, ctx, credential })
  -> oauth.refresh()/toAuth()

CredentialStore
  -> read(providerId)
  -> modify(providerId, fn)
  -> delete(providerId)

AuthContext
  -> env(name)
  -> fileExists(path)
```

`Models.getAuth(model)` 的请求期流程可以概括为：

```text
model
  -> find provider by model.provider
  -> read stored credential from CredentialStore
  -> if stored OAuth expired: refresh inside CredentialStore.modify()
  -> else resolve api key / ambient env / provider file checks through Provider.auth
  -> return { auth: { apiKey, headers, baseUrl }, source }
```

WIDI 的 `AuthStorage` 就是这个 `CredentialStore`。因此 OAuth refresh 的正确入口已经从
WIDI 自己的零散读取逻辑收敛到 pi-ai `Models.getAuth()` 的 locked refresh pattern。
WIDI 仍保留 `getApiKey()`，主要用于尚未完全切到 pi-ai runtime 的旧调用点和显式状态查询。

## `models.json` 中的认证配置

provider 配置可以声明：

- `apiKey`：支持 literal、env template、`!command`。
- `headers`：每个 header value 使用 `ConfigValueResolver` 解析。
- `authHeader`：将解析出的 API key 写入 `Authorization: Bearer ...`。

这些 request auth 信息不会直接塞进 `Model.headers`。它们保存在
`providerRequestConfigs` 和 `modelRequestHeaders` 中，在请求期才解析。

WIDI 会把这层配置包进 provider auth：

```text
base Provider.auth
  -> resolve stored/env/ambient auth from pi-ai
  -> WIDI resolve provider apiKey / provider headers / model headers
  -> WIDI apply authHeader if requested
  -> return merged ModelAuth to pi-ai Models runtime
```

这样做有两个原因：

- env 和 command 配置可以延迟到真正请求前解析。
- 错误信息可以带上 provider/model/header 的上下文，并进入统一 diagnostics。

## 认证解析路径

现在存在两条认证解析路径。

第一条是主路径，供 orchestrator 和 agent runtime 使用：

```text
orchestrator
  -> modelRegistry.getRuntime()
  -> Models.stream()/complete()/getAuth()
  -> Provider.auth
  -> AuthStorage + AuthContext
  -> WIDI request auth wrapper
```

第二条是兼容路径，供仍需要显式 request auth 的调用点使用：

```text
modelRegistry.getApiKeyAndHeaders(model)
  -> authStorage.getApiKey(provider, { includeFallback: false })
  -> resolve models.json provider apiKey / headers
  -> resolve model headers
  -> apply authHeader
  -> return { apiKey, headers }
```

兼容路径先关闭 `AuthStorage` fallback，再由 `ModelRegistry` 自己解析 `models.json`
provider config，避免同一份 provider request config 被重复参与解析。

## Auth Status 与实际解析

`hasConfiguredAuth()` 和 `getProviderAuthStatus()` 偏向“配置是否存在”的检查，而不是完整请求
解析：

- runtime key、stored credential、`models.json` api key 会被视为 auth 来源。
- `models.json` 中的 `!command` 会被报告为 configured，但不会在 status 查询阶段执行。
- env template 会检查变量是否存在。
- 对于 pi-ai provider 自带的 env、文件或 ambient 认证，status 会通过 `Models.getAuth()`
  尝试获得 source 标签。
- OAuth token 是否需要刷新，主路径由 `Models.getAuth()` 处理；兼容路径由
  `AuthStorage.getApiKey()` 处理。

这个分层可以避免 UI 或模型发现阶段触发昂贵或有副作用的命令执行，同时让真正的请求路径
仍然得到完整认证解析。

## Diagnostics

`SettingManager`、`AuthStorage` 和 `ModelRegistry` 已接入统一 `CoreDiagnostic` shape，
同时保留旧 API：

- `SettingManager.drainDiagnostics()` 返回 `settings.load_failed`、`settings.write_failed`；
  旧 `drainErrors()` 保留。
- `AuthStorage.getLoadDiagnostic()` / `drainDiagnostics()` 返回 `auth.load_failed`、
  `auth.persist_failed`、`auth.oauth_refresh_failed`；旧 `drainErrors()` 保留。
- `ModelRegistry.getLoadDiagnostic()` / `drainDiagnostics()` 返回 `model.load_failed`、
  `model.auth_missing`、`model.auth_resolution_failed`；旧 `getError()` 与
  `ResolvedRequestAuth` 返回 shape 保留。
- `ModelRegistry.getRuntime()` 返回的 runtime 会在 pi-ai request/auth 错误后触发
  diagnostics drain 与发布。

Orchestrator 在 startup boundary drain settings/auth/model load diagnostics，并在 provider
auth callback 后 drain request auth diagnostics，再通过统一 `diagnostic` event 发布给
UI/RPC/CLI。

## 锁与并发边界

当前 `FileAuthStorageBackend` 内部有一个 in-process `AsyncLock`，用于串行化同一个进程内对
`auth.json` 的 read-modify-write。

pi-ai 的 `CredentialStore.modify()` 已把 OAuth refresh 需要的锁边界显式化：

```text
Models.getAuth()
  -> credential expired
  -> CredentialStore.modify(provider, fn)
  -> fn sees current credential
  -> refresh once
  -> persist refreshed credential before releasing lock
```

这个锁目前不能解决多进程并发写入问题。代码中已经把锁边界放在 backend 上：

```ts
withLockAsync(fn)
```

后续如果 WIDI 支持多个 agent、多个 orchestrator 或多个进程同时操作同一份 auth/config 文件，
应优先在 backend 或 runtime service 层扩展锁能力，而不是让 `AuthStorage` 直接理解平台文件锁。

可选方向：

- 实现带文件锁的 `FileAuthStorageBackend`。
- 在默认 `ExecutionEnv` 外包一层 config I/O runtime，统一串行化配置读写。
- 在应用入口创建一个 runtime service，集中分发 `executionEnv`、`settingManager`、
  `configValueResolver`、`authStorage`、`modelRegistry`。

## 设计判断

最初可能会认为 `ExecutionEnv` 只应该给 `AgentHarness` 执行工具使用。但现在
`models.json`、`auth.json`、JSONL storage、`!command` 配置值都需要文件系统或 shell 能力，
因此让 core 配置与存储模块也依赖同一个 `ExecutionEnv` 是合理的。

关键边界是：

- `ExecutionEnv` 只表达 runtime I/O 与 shell 能力。
- `SettingManager` 表达 global/project settings、project trust 和配置持久化边界。
- `ConfigValueResolver.getEnv()` 单独表达环境变量来源。
- `AuthStorageBackend` 表达凭据存储与锁。
- `AuthStorage` 实现 pi-ai `CredentialStore`，但 login/logout 仍由 WIDI 应用层编排。
- `ModelRegistry` 不直接读写 auth 文件，也不直接访问 `process.env` 或 Node shell。
- `ModelRegistry` 负责把 WIDI 配置合并到 pi-ai `Models` runtime，而不是替代该 runtime。

## TODO

Model/auth/settings 后续任务按 milestone 维护在 [Milestones](TODO.md) 与 [Backlog](BACKLOG.md)。本文件只保留当前模型、
认证和配置解析边界。
