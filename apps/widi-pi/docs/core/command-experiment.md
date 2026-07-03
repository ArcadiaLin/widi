# Command Experiment

Command 是 `widi-pi` core 中的实验性 runtime 设计。它尝试把 core 能力描述成一组可执行 command，让 runtime consumer、extension、adapter 和未来 product preset 可以围绕同一组 capability 做组合，而不需要先落到具体 UI、终端交互或 RPC 形态。

这个设计还不应被理解为稳定 API，也不应被理解为所有调用者必须经过的唯一入口。它更像是在 `AgentOrchestrator` 之上试探另一层 runtime：一层能描述请求来源、目标 agent、输入协议、执行结果和诊断事实的 command runtime。

## Motivation

Core 里已经存在许多原子能力：prompt agent、steer running agent、resume session、fork branch、reload extension、request human、修改 active tools 等。直接暴露这些方法足够精确，但不容易作为一个 capability 集合被检查、注册、组合和交给 extension 扩展。

Command 的意义是提供一个更可描述的中间层：

- 用 command request 描述 core 能力，而不是把能力散落在 UI handler 或 adapter 私有逻辑里。
- 让 built-in capability、extension contribution、adapter/preset contribution 有机会进入同一套 resolve 和 inspect 事实。
- 让 extension 可以注册 human/client-facing 能力，同时避免要求 extension 知道 TUI、keybinding、modal、toast、autocomplete 等交互细节。
- 让 product harness 可以选择复用一套 command runtime，也可以绕过它直接组合 orchestrator 原子能力。

## Current Shape

当前实现位于 `src/core/command`：

- `CommandRequest` 是 typed operation request。
- `Command.execute()` 调用 orchestrator runtime 执行 typed command。
- `Command.executeInput()` 解析 `/name args`，在 `inputInvoke` 开启时解析 built-in 或 extension input command。
- `Command.listInputCommands()` 输出 client/debug 可消费的 UI-neutral visible command facts。
- extension 通过 `registerCommand()` 贡献 `inputInvoke` 和 handler。

`AgentOrchestrator.dispatch()` 仍负责 command lifecycle event：`command_accepted`、`command_completed`、`command_rejected`。Command 不拥有 client fanout，不替代 harness queue，也不持久化 command log。事件传递顺序见 [Runtime Lifecycle](./runtime-lifecycle.md)。

## Experimental Boundaries

Command 是可选组合层，不是 mandatory runtime boundary。

Runtime consumer 可以选择：

- 使用 `Command` 作为 high-level operation runtime。
- 直接调用 `AgentOrchestrator` 的原子方法，自己决定输入解析、UI 行为、事件呈现和扩展点。
- 在产品层定义自己的 command/preset，再只复用部分 core command 类型或 helper。

长期如果稳定下来，Command 更适合成为可选导出，例如：

```ts
import { Command } from "@widi-pi/command";
```

这比默认从主入口全部导出更合适。主 runtime 可以继续暴露 orchestrator 和 services；需要 command runtime 的 consumer 再显式选择它。这样可以避免 core 一开始就把 Command 固化为唯一 façade。

## Extension Surface

Command 给 extension 的价值不在于提供 UI widget，而在于提供 UI-neutral executable capability。

`inputInvoke` 只描述输入协议：

- slash name。
- description。
- argument hint。

它不描述：

- keybinding。
- picker、modal、toast、autocomplete。
- terminal line editor 行为。
- RPC method shape。

这让 extension 可以注册更多能力，同时让 TUI、stdout、RPC 或其他 adapter 自己决定如何呈现和触发这些能力。

## Future Direction

如果继续推进，Command 应逐步从 MVP 走向 contribution/resolve/execute 模型：

- built-in、extension、adapter/preset 都贡献 command definition。
- Command resolve input names、reserved names、冲突 suffix、visibility 和 source provenance。
- inspect facts 能说明 command 来自哪里、如何被触发、冲突如何处理。
- diagnostics 能报告重复、隐藏、不可用或失败的 command contribution。
- extension command context 是否继续沿用完整 extension context，需要根据真实稳定性压力再决定。

这个方向和 ToolRegistry 相似，但不对称。ToolRegistry 面向 LLM-facing tools，最终输出 `AgentTool[]` 给 harness。Command 面向 human/client-facing capability，直接组合 orchestrator runtime 行为。

## Non-Goals

- 不定义最终 UI 交互。
- 不替代 `AgentOrchestrator`。
- 不提供独立 message bus。
- 不提供第二套 agent queue。
- 不要求所有 runtime consumer 必须使用 Command。
- 不把实验性 command API 提前承诺为稳定 public API。
