# 基于 Session Tree 的统一持久化方案

状态：模型已定型，实现进行中
日期：2026-08-01

## 结论

WIDI 将 `session.jsonl` 的对话树作为「某一时刻哪些 custom state 有效」的权威依据。
subagent tree、background job、extension state 不再各自定义一套与对话树脱节的恢复
规则。

每个可持久化对象由两部分组成：

1. 对话树上的 **persistence ref**：声明该分支点起，某个 namespace 的状态变为哪个
   state root；
2. session 目录下的 **custom storage**：保存 state root 及其可达依赖的数据。

恢复某个 leaf：读完整 root-to-leaf 路径 → 收集路径上的 ref → 每个 namespace 取最后
一条 ref 决定的 state root → 交给对应 namespace 解析。

fork：复制对话 entries → 从**源会话的完整分支**投影出各 namespace 的 state root →
递归复制其可达闭包（对象 + 子会话目录）→ 给新会话补写 ref。

「随对话树回退」和「fork 后可独立恢复」因此成为所有 persistence kind 共享的机制，
每个 kind 只声明自己的数据格式、依赖和 fork 策略。

## 边界

不修改 vendored 的 `packages/agent`：

- `AgentHarness` 继续拥有 live session branch 的写权；
- 不向 pi 的 `SessionTreeEntry` 联合添加类型，ref 用既有 `CustomEntry` 表达；
- `CustomEntry<T>` 的泛型不是运行时 schema，所有落盘 data 由 WIDI 自己做版本、JSON
  可序列化性和大小校验。

## 目录布局

```text
.widi/runs/<encoded-cwd>/
└── <ts>_<session-id>/                    # 顶层会话 = main agent，/resume 只列这一层
    ├── session.jsonl                     # 对话树与 persistence refs
    ├── persistence/
    │   └── <namespace>/objects.jsonl     # 内容寻址的不可变对象日志
    └── agents/
        └── <ts>_<child-id>/              # 子会话，结构同上，可再嵌套
```

规则：

- **子会话嵌在父目录里**。所有权、生命周期、可复制性都跟随目录：删根即删整棵子树，
  fork 根即复制一棵子树。
- **子会话放在 `agents/` 容器下**，不与 `session.jsonl` 平级，这样列举目录不需要靠
  保留名黑名单区分「子会话」和「保留目录」。
- 目录段名保留时间戳前缀。session id 等于创建它的 AgentId，只在单次运行内唯一，
  没有前缀会让 resume 后再次 spawn 的同名 agent 撞上上次的目录。
- 嵌套深度上限 8。每层增加两个路径段，Windows 的 260 字符限制是真约束；超限的
  spawn 降级为顶层会话并出诊断。
- namespace 目录名把 `:` 编码为 `__`（`core:subagent` → `core__subagent`）。`:` 在
  Windows 上非法，用 `-` 替换会与 `core-subagent` 撞名。
- **`agents/` 嵌套是 session 层的规定**，只属于 `jsonl-session.ts`。custom storage 在
  自己的 namespace 目录里想怎么组织都行，框架只承诺给它一个目录。

对话树给不了分支可见性，所以 ref 仍然必需：

- **目录**决定所有权、生命周期、可复制性；
- **ref** 决定某个分支点上哪些子会话/哪些状态算数。

根会话回退到 spawn 之前，子目录还在盘上，但不能被恢复。

## persistence ref

普通 custom entry，`customType: "widi:persistence-ref"`：

```text
data: { version, namespace, stateRoot, anchorEntryId? }
```

- ref 是对话树的普通节点，天然有 `id`、`parentId` 和时间，天然只在其后代分支可见；
- `stateRoot` 是内容寻址哈希，`null` 表示从这里起清除该 namespace；
- **依赖不放在 ref 里**，放在它指向的对象里。两处都存必然漂移，而 fork 遍历无论如何
  都要打开 storage；
- `anchorEntryId` 仅供诊断。turn 内的 session 写入被 harness 缓冲到 `turn_end` 统一
  落盘，ref 落在 flush 时刻的 leaf 之下，不与触发它的 entry 相邻，任何逻辑都不得依赖
  相邻性；
- ref 是指针不是载荷，上限 2 KB，超了直接抛错而不是截断。

同一 namespace 在路径上出现多条 ref 时，**最后一条生效**。想要"归约整个序列"的
namespace 把归约结果写进 state root，框架只保留一条规则，这样解析结果不依赖当前
build 注册了哪些 namespace。

## custom storage

框架承诺 namespace 三件事：一个自己的目录、一个能被分支命名的方式、分支 fork 时的
递归复制。namespace 回答四个问题：state root 是什么意思、依赖什么、fork 时怎么办、
旧版本怎么读。

唯一硬要求是 **state root 不可变**：分支命名了它，那么即使分支不再是当前分支，它也
必须解析回当初被命名的东西。

默认实现 `JsonlObjectStore` 是内容寻址的 append-only 日志（header 行 + 每行一个
对象），大多数 namespace 用它就够；需要别的形状的自己实现 `CustomStorage`。

依赖有两种：

- **对象依赖**：namespace 内部，复制进新会话的同名 storage；
- **会话依赖**：整个子会话目录，由仓储递归 fork。`core:subagent` 用它回答「这个成员
  集合包含哪些子会话」，仓储因此不需要知道 spawn tree 是什么。

namespace 只声明依赖，不自己递归。去重和环检测只有一份实现，在仓储里。

## 关键约束

**写入顺序：先 object，后 ref。**

- turn 内 `harness.appendCustomEntry` 会被缓冲，返回 `undefined`，拿不到 entry id，
  所以「先写 ref 再回填 object」在运行期根本做不到；
- `stateRoot` 是对象内容的哈希，必须先有对象才能写 ref。对象再引用 ref 的 entry id
  就成了循环依赖 —— 因此规定：**对象不得包含指向自己那条 ref 的 entry id**；
- 对象内容寻址，先写只留下可回收的孤儿；先写 ref 留下的是必须降级处理的悬空引用。

API 形状固化了这一点：`JsonlPersistenceRepo.stageState()` 落盘对象并返回 ref data，
仓储没有任何方法能往 live branch 写 ref，调用方必须自己拿去过 harness。

**ref 收集永远走完整分支。** pi 的 `getPathToRootOrCompaction` 会在 compaction 检查点
截断，那是给模型上下文用的；compaction 之前的 ref 依然有效——模型忘了一件事不代表这件
事不成立。恢复和 fork 都用 `getFullBranch`。fork 的 entry 集合同理，因此 WIDI 自己拥有
`getEntriesToFork`，不复用 pi 的。

**fork 由 ref 解析结果驱动，不是 `cp -r`。** fork 点之后才 spawn 的子会话在盘上是存在
的，但不属于新树。

**fork 永不写源。** `degrade` 策略产生的新对象写进 target storage；源目录在 fork 期间
严格只读。

**migrate 不回写分支。** namespace 升版时，`migrate()` 把旧对象读出来、写成新版本对象、
返回新 state root，运行期在内存里维护 `旧root → 新root` 映射。往分支补写 ref 来"修复"
历史是不允许的——那会让同一个 leaf 在不同 build 下解析出不同结果。

**一致性只到 append-only 级别。** `FileSystem` 没有 rename、fsync、锁，也没有跨文件
事务，所以：不使用任何需要原子替换的可变单文件（格式版本写进各自 JSONL 的 header
行，没有 manifest）；每个 session 目录的持久化写入串行；JSONL 必须容忍进程被杀时的
尾行损坏，非尾部损坏要报告；custom storage 写失败不得直接让 agent turn 失败。同一
sessionsRoot 的多进程并发写入继续不受支持。

**降级永不损坏对话。** 缺对象、未知 namespace、版本不兼容、坏 ref、环、尾行损坏，
每一种都产生可定位的诊断和明确的降级状态，都不得让对话历史变得不可读。

## fork 语义

| namespace 类型 | fork 行为 |
| --- | --- |
| subagent tree 的拓扑与成员 | copy（连同子会话目录递归复制） |
| extension 的 JSON state / snapshot | 通常 copy |
| 已结算 job 的历史 | degrade（历史保留，标记为「在来源会话中中断」） |
| 正在执行的 job、PID、socket、lock | omit |
| credential、外部资源句柄 | omit |

已定的两条子语义：

- **fork 根不会回退子会话**。ref 只决定子会话是否属于这棵树；子会话按其当前 leaf 整体
  复制。要精确到子会话的某条 entry，就得在子每次 turn 后更新父的 ref，写入量不可接受。
- **fork 的子会话保留原 session id**。寻址已经是路径，不再有歧义。

## 实施阶段

1. ~~模型骨架~~：`core/persistence/`，纯逻辑在 `utils/`。**已完成**
2. **模型测试**：`test:counter` namespace 锁住 projection、object store、fork closure。
3. **`JsonlSession` 移植**：从 pi 的 `jsonl-storage.ts` 逐字段搬，保持 v3 兼容；用真实
   fixture 验证 create/open/load/list/fork。
4. **仓储实现**：create/open/list/listChildren/delete/fork，含子会话递归复制。验收是
   「fork 后删除源目录，新会话仍可独立恢复」。
5. **迁移 `core:subagent`**（需等新 orchestrator 接线，否则要在两个 orchestrator 里各写
   一遍）：state root = 成员快照；`parent.json` 改为 session header metadata；
   `agents/tree.jsonl` 保留只读兼容。
6. **迁移 `core:jobs`**：state root = 已结算历史快照；活着的 job 不进 ref；一个 turn 内的
   多次变更合并成一条 ref。
7. **extension persistence**：等 project trust、配额、生命周期明确后再开。

## 验收标准

- 回到对话树任意旧节点时，每个 namespace 恢复该路径可见的状态；
- fork 指定节点后，新会话在源目录已删除的情况下可独立恢复；
- 多条 ref 引用同一 root 时，fork 不重复复制对象；
- 循环依赖、未知 namespace、无效 ref、对象缺失、JSONL 尾行损坏均有确定诊断与降级，
  不破坏对话历史读取；
- `delete` 删除会话、其 custom storage、其全部子会话；
- runtime 不绕过 `AgentHarness` 写 live session branch；
- 不修改 `packages/agent`，既有 pi v3 session 保持可打开。
