## 2026/06/22

有明显影响，但都不是阻塞型。

1. **没有看到 WIDI 必须立刻改的 breaking change**
   `AgentHarness`、`AgentTool`、`ExecutionEnv`、session/storage 这些我们正在用的接口没有结构性变化。`apps/widi-pi` 测试通过：31 tests passed。

2. **新增 `@earendil-works/pi-agent-core/base`**
   默认 `@earendil-works/pi-agent-core` 现在显式加载 `@earendil-works/pi-ai` 的 provider side effects；`/base` 是给“只注册选定 provider”的 bundler 场景用的。
   
   对我们当前影响：先不切。WIDI 现在用默认入口是安全的。以后如果要让 WIDI 完全掌控 provider 注册，可以考虑改到 `/base`，但那会变成一个明确设计决策。

3. **`onUpdate` 语义收紧**
   `AgentToolUpdateCallback` 现在明确：tool 的 `execute()` promise settle 之后，再调用 `onUpdate` 会被 agent-loop 忽略。
   
   对我们影响：core 当前没问题。但 extension / `aroundExecute` 设计要记住这个语义。尤其我们刚迁出的 tracker example，如果要更贴合 Pi 行为，最好也加一个 `acceptingUpdates` guard，避免记录 late update。

4. **`NodeExecutionEnv` 修了 legacy WSL bash**
   现在对 `C:\Windows\System32\bash.exe` 这类 legacy WSL bash 会用 stdin 传脚本。我们当前主要依赖 `ExecutionEnv` interface/fake env，不直接用 `NodeExecutionEnv`，所以是间接利好，无需改。

结论：这次 pi-agent-core 更新对 WIDI 当前开发没有明显破坏；唯一建议跟进的是把 tracker extension 示例里的 `onUpdate` wrapper 调整成“execute 期间才记录 update”。