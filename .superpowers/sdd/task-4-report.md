# Task 4 Report: TUI 切换到 CommandEngine

## Status

DONE

## Implementation

- `WidiTuiApplication` 现在持有基于 `builtInCommands` 的 `CommandEngine`，提交输入时直接处理 `pass`、`expanded`、`executed`、`failed` 和 `needs-argument` 结果。
- 普通及内联展开后的提示通过 `promptAgent` 提交，并携带 `PromptExpansion`；命令执行状态由 TUI 本地写入 `command-result` timeline item。
- 删除了 TUI 的动态命令刷新、旧 command event 投影、旧导航结果解析和 bare selector 匹配逻辑。
- autocomplete 改为从 engine 按当前 agent status 列出命令，并通过 engine command completer 获取参数候选。
- completion menu 直接消费 engine 返回的候选；`/fork` 菜单保留“当前位置”空参数选项。
- command-result 状态模型和渲染改为 `running | completed | failed`，失败直接显示 `CommandError.message`。
- 清理 `AgentViewState.commands`、`commandRevision`、`PendingInput.lineCommandCandidate`、command event timeline 判定和 diagnostic key 中的 `commandId`。
- 更新 TUI 测试，覆盖内建命令 autocomplete、selector menu、completed/failed command-result 渲染及新 PendingInput 形状。

## TDD RED/GREEN Evidence

### RED

在补齐遗留测试迁移前运行：

```text
npm --workspace apps/widi-pi run check
```

结果：exit 2。

```text
tests/tui/event-projector.test.ts(86,4): error TS2353:
'lineCommandCandidate' does not exist in type 'PendingInput'.
```

这证明旧 event-projector 测试夹具仍依赖已删除字段。

将 autocomplete 测试切换到真实 `builtInCommands` 后，第一次相关测试运行还暴露了测试自身取模糊排序首项的问题：`/st` 的首项是 `/status`，不是 `/steer`。断言改为按 `/steer` label 定位后复跑通过；未修改生产逻辑。

### GREEN

删除旧测试字段并补充 command-result 渲染测试后：

```text
npm --workspace apps/widi-pi exec vitest run \
  tests/tui/views.test.ts \
  tests/tui/autocomplete.test.ts \
  tests/tui/completion-menu.test.ts \
  tests/tui/event-projector.test.ts
```

结果：4 files passed，32 tests passed，exit 0。

```text
npm --workspace apps/widi-pi run check
```

结果：exit 0。

遗留生产实现早于本次续接；新增 completed/failed view 测试首次运行即通过，因此将其记录为对既有实现的验收覆盖，不虚构 production RED。

## Verification

- `npm --workspace apps/widi-pi run test`
  - 39 test files passed
  - 500 tests passed
  - exit 0
- `npm run check`
  - Biome checked 132 files
  - TypeScript check passed
  - exit 0
- `git diff --check`
  - exit 0

## Files

- `apps/widi-pi/src/tui/application.ts`
- `apps/widi-pi/src/tui/autocomplete.ts`
- `apps/widi-pi/src/tui/completion-menu.ts`
- `apps/widi-pi/src/tui/components/timeline-item.ts`
- `apps/widi-pi/src/tui/event-projector.ts`
- `apps/widi-pi/src/tui/state.ts`
- `apps/widi-pi/tests/tui/autocomplete.test.ts`
- `apps/widi-pi/tests/tui/completion-menu.test.ts`
- `apps/widi-pi/tests/tui/event-projector.test.ts`
- `apps/widi-pi/tests/tui/views.test.ts`
- `.superpowers/sdd/task-4-report.md`

## Self-review

- 对照 Task 4 brief 逐项核对 state、application、event projector、autocomplete、completion menu、timeline renderer 和测试要求。
- `apps/widi-pi/src/tui` 与对应测试中不存在 `../core/command.ts` / `core/command` 新依赖。
- 不存在 `commandGeneration`、`refreshCommands`、`matchBareSelectorCommand`、`commandRevision` 或 `lineCommandCandidate` 残留。
- 扫描 Task 4 源码与测试，未发现字面 C0/DEL 控制字节；BACKSPACE 使用 `"\u007f"` 转义。
- 未修改 `pi/*`，未修改续接记录 txt，未包含任务外文件。

## Concerns

None.
