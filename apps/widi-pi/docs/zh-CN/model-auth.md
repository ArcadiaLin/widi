# Model、Auth 与配置值

本文记录 `ModelRegistry`、`AuthStorage` 和 `ConfigValueResolver` 的当前边界。WIDI 使用 pi-ai 的 provider runtime，不维护一套平行静态 model/provider 表。

## Runtime ownership

pi-ai `Models` runtime 负责：

- 内置 provider 与 model 查询。
- `Provider.auth` 解析。
- credential refresh 与请求委派。
- dynamic model refresh。

WIDI 负责应用侧组合：

- 读取并合并 `models.json`。
- 用 `AuthStorage` 实现 pi-ai `CredentialStore`。
- 把 env/file lookup 接入 `AuthContext`。
- 解析 provider/model request auth config。
- 管理 runtime 与 extension provider registrations。
- 把 model/auth failure 转为 `CoreDiagnostic`。

`ModelRegistry` 是 pi-ai `MutableModels` 的应用层包装，不替代它。

## 依赖关系

```text
ExecutionEnv
  -> models.json / auth.json file I/O
  -> !command execution
  -> AuthContext.fileExists

ConfigValueResolver
  -> literal / env / command resolution
  -> command result cache
  -> AuthContext.env

AuthStorage
  -> pi-ai CredentialStore
  -> API key / OAuth persistence
  -> in-process credential modification lock

ModelRegistry
  -> built-in + configured + dynamic providers
  -> WIDI request auth wrapper
  -> diagnostics
```

环境变量读取不进入 `ExecutionEnv`；它由 `ConfigValueResolver.getEnv()` 表达，使 filesystem/shell backend 与 env source 可以独立替换。

## Model sources 与 merge

Model runtime 包含四类来源：

1. pi-ai built-in providers。
2. `models.json` custom provider/model 与 overrides。
3. runtime `registerProvider()` dynamic providers。
4. extension 激活期 `registerProvider()` contributions。

`models.json` 读取或 schema 校验失败时，registry 保留 built-in models，并发布 `model.load_failed`。

配置合并顺序：

```text
built-in providers
  -> provider baseUrl/compat override
  -> model override
  -> custom models
  -> dynamic/extension providers after refresh
```

Custom model 按 provider + model id 合并。普通 runtime dynamic registration 可以表达完整 provider 或 override；extension registration 更严格：只允许新 provider name，必须携带完整 models，并记录 provenance。

Extension provider 是 process-global model fact，但生命周期绑定 runner。多个 agent 激活同一 contribution 时使用 registrant reference count；reload/dispose 撤销对应 registration。Extension 不能静默 override built-in/models.json provider，冲突产生 `extension.provider_conflict`。

## Auth runtime

请求期认证主路径：

```text
model
  -> Models.getAuth()/stream()
  -> Provider.auth
  -> AuthStorage credential
  -> expired OAuth refresh inside CredentialStore.modify()
  -> AuthContext env/file checks
  -> WIDI provider/model request auth wrapper
  -> apiKey + headers + baseUrl + source
```

`AuthStorage` 持久化 API key 与 OAuth credential，支持 runtime override，并通过串行化 `modify()` 保证单进程内 refresh 的 read-modify-write 一致性。

`getApiKeyAndHeaders(model)` 是仍需显式 request auth 的兼容入口。它关闭 AuthStorage fallback 后自行解析 WIDI request config，避免同一配置重复参与。

Auth status 查询只判断“是否配置”，不主动执行有副作用的 `!command`。真正的请求路径执行完整解析与 OAuth refresh。

## 配置值解析

`ConfigValueResolver` 支持：

- `!command`：通过 `ExecutionEnv.exec()` 执行，使用 trimmed stdout。
- `$ENV_NAME` 与 `${ENV_NAME}`：通过 `getEnv()` 读取。
- 普通字符串：literal value。
- `$$` 与 `$!`：字面量转义。

Env missing/empty、command failure/non-zero 或 empty stdout 返回 `undefined`。严格入口 `resolveConfigValueOrThrow()` / `resolveHeadersOrThrow()` 把失败转成带配置来源的 error。

Command result cache 属于 resolver instance；`resolveConfigValueUncached()` 绕过 cache，`clearConfigValueCache()` 显式清理。

Provider apiKey、provider headers 和 model headers 在请求期使用同一 resolver。Extension provider config 中的 `!command` 会执行代码，因此 registration 必须通过 project trust gate；literal 与 env reference 不需要该执行权限。

## Diagnostics

- Settings：`settings.load_failed`、`settings.write_failed`。
- Auth：`auth.load_failed`、`auth.persist_failed`、`auth.oauth_refresh_failed`。
- Model：`model.load_failed`、`model.auth_missing`、`model.auth_resolution_failed`。
- Extension provider：invalid、conflict、trust denied 等 `extension.provider_*` codes。

Registry/storage 可以保留旧 error accessors 作为内部兼容，但 runtime event 统一发布 `CoreDiagnostic`。

## 并发边界

Auth backend 的 lock 只覆盖同一进程内 credential mutation。多个 WIDI 进程并发写 auth/settings/models 配置不在当前支持边界。统一跨进程 lock/transaction/lease 应由 runtime backend 或 Pi upstream 提供。

## 非职责

- ModelRegistry 不直接访问 Node shell 或随意读取 `process.env`。
- AuthStorage 不拥有 model catalog。
- Extension 不拥有 credential persistence，也不能覆盖已有 provider。
- ConfigValueResolver 不决定 project trust policy；caller 在允许执行命令前完成门控。
