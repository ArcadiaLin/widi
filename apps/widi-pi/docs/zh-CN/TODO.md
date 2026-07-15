# WIDI Milestones

本文只保留当前阶段严格顺序推进的总体目标。Milestone 不预先定义 API、类型、文件拆分或实施切片；具体方案在进入对应工作时，基于当前代码和真实 consumer 单独设计。

## 1. MultiAgent 协作

目标：形成 agent 之间可组合、可观察、可恢复的最小协作闭环，使 multi-agent 成为 WIDI core 的真实能力。

范围边界：

- Orchestrator 统一拥有协作、生命周期和跨 agent 可观察性。
- Built-in collaboration tools 只暴露受控的 core 协作能力。
- Extension 通过受限接口组合协作能力，不直接持有其他 agent 或 raw harness。

总体完成标准：一个 agent 可以发起并完成跨 agent 协作，异常、取消与不可用状态能够沿现有 event/diagnostic/session 边界被解释和恢复。

## 2. Diagnostics 产出下沉

目标：降低 orchestrator 中 diagnostic 构造、转换和上下文拼装的复杂度，让问题事实由最接近它的 runtime owner 产生。

范围边界：

- Registry、loader、runtime collaborator 和其他 domain owner 负责自己的 diagnostic decision 与 source facts。
- 共享的 construction、format、dedupe 和 error conversion 进入明确的 diagnostics 边界。
- Orchestrator 主要补充 operation context、汇总并统一发布。

总体完成标准：diagnostic code、severity、disposition 和发布语义保持稳定，同时 orchestrator 中不再集中承载可由具体 runtime 独立解释的复杂诊断逻辑。

## 3. 代码细节与可读性优化

目标：在核心能力收敛后改善模块内聚性、命名、控制流和测试可理解性，降低后续产品开发的阅读与修改成本。

范围边界：

- 以 runtime ownership 为依据处理大文件和职责混杂，不按行数机械拆分。
- 删除无 consumer 的字段、重复 helper 和失真的兼容路径。
- 优化难读控制流、局部类型和测试设施，保持行为与公开契约稳定。

总体完成标准：主要 core 模块的职责可以从公开边界直接理解，修改局部实现不需要跨越无关模块，现有行为由更清晰的测试和 diagnostics 事实保护。
