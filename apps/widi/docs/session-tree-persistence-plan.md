# 基于 Session Tree 的统一持久化方案

状态：模型已定型，实现进行中
日期：2026-08-01

## 结论

WIDI 将 `session.jsonl` 的对话树作为「某一时刻哪些 custom state 有效」的权威依据。
background job、extension state 不再各自定义一套与对话树脱节的恢复规则。

agent 树不在此列：它的父子关系由会话目录嵌套表达，不由任何分支状态表达，见
`docs/ZH/agent-tree-persistence.md`。

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

## 职权范围

恢复一个会话分三步，persistence 只管前两步。

| 步骤 | 含义 | 归属 |
| --- | --- | --- |
| **投影 projection** | 分支点上哪个 state root 生效 | 框架，不允许 namespace 覆写 |
| **解析 resolution** | 该 root 对应什么数据 | namespace |
| **激活 activation** | 拿到数据之后做什么 | 下游，本层不提供钩子 |

投影必须归框架：否则 rewind 的语义会因 namespace 而异，用户无法推理「我退回去了到底退掉了什么」。

激活必须归下游，因为正确行为依赖本层看不见的东西——进程是否还活着、当前配置是否还允许该 extension、这次是 `/resume` 还是 fork 后首次运行。在这里放 `onResume` 钩子，等于强迫每个 namespace 去猜这些，猜错了框架也发现不了。

注意这与 fork 有 policy 并不矛盾：fork 时 persistence 是动作的发起者，它在搬字节，必须知道搬不搬；resume 时它只被读取。

本层欠下游的，是**只有它知道的事实**：

- `StateProvenance`（`current` / `forked` / `degraded` / `migrated`）——这份状态是本分支自己写的，还是从别处继承来的；
- 每一条降级的诊断（`PersistenceDiagnostic`），可定位到 namespace 与 state root。

下游负责的：

- 激活策略（要不要重新拉起 agent、要不要重连进程、怎么向用户呈现）；
- `/resume` 的 UI 层级（固定在顶层会话，与持久化树深度无关）；
- 磁盘回收，见下节。

## 未注册 namespace 与 GC 禁令

**未注册 namespace 不是错误，是常态。** 空注册表也必须能打开、列举、读取会话，只是它携带的状态不解析。这不是为容错加的，是必需的：extension 未安装、extension 加载失败、用户临时禁用、旧 build 读新会话——本层看到的全都是「注册表里没有这一格」，四种情况在这里**无法区分**。

处置固定为一种：

- ref 留在分支上不动。分支是 append-only；且删掉一条 ref 会让一个已存在的 leaf 解析出不同结果；
- namespace 目录留在盘上不动。卸载通常是临时的（升级、禁用、换 profile），重装即原样恢复；
- 报 `persistence.unknown_namespace`，**severity 为 warning 而非 error**，这样 `hasErrors` 不会因为「用户没装某个 extension」而为真，下游拿它报警不会误报；
- fork 时跳过该 namespace，其余照常。

**GC 禁令：磁盘回收绝不能由注册表状态驱动。** 「注册表里没有就删」会让一次 extension 加载失败永久销毁用户数据。回收只能由显式用户动作触发（删除会话、显式清理某个 extension 的数据），且必须能看见它在删什么。本层不实现 GC，也不提供任何以「未注册」为条件的删除入口。

**namespace 目录带 owner。** namespace 名全局唯一但不被保留：extension A 卸载后，extension B 可以注册同名 namespace，从而读到 A 的对象并按自己的 schema 解释。所以 objects.jsonl 的 header 记录 owner（extension id），open 时不匹配就封存该 storage——读降级为空，写直接抛错。owner 必须是**稳定身份，不含版本号**：extension 升级只 bump `formatVersion`，若 owner 随版本变，升级后的 build 会被锁在自己的数据外面。

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
- namespace 目录名把 `:` 编码为 `__`（`core:jobs` → `core__jobs`）。`:` 在
  Windows 上非法，用 `-` 替换会与 `core-jobs` 撞名。
- **`agents/` 嵌套是 session 层的规定**，只属于 `jsonl-session.ts`。custom storage 在
  自己的 namespace 目录里想怎么组织都行，框架只承诺给它一个目录。

对话树给不了分支可见性，所以 ref 仍然必需：

- **目录**决定所有权、生命周期、可复制性；
- **ref** 决定某个分支点上哪些子会话/哪些状态算数。

根会话回退到 spawn 之前，子目录还在盘上，但不能被恢复。

## persistence ref

普通 custom entry，`customType: "widi:persistence-ref"`：

```text
data: { version, namespace, stateRoot, anchorEntryId?, origin? }
```

- ref 是对话树的普通节点，天然有 `id`、`parentId` 和时间，天然只在其后代分支可见；
- `stateRoot` 是内容寻址哈希，`null` 表示从这里起清除该 namespace；
- **依赖不放在 ref 里**，放在它指向的对象里。两处都存必然漂移，而 fork 遍历无论如何
  都要打开 storage；
- `anchorEntryId` 仅供诊断。turn 内的 session 写入被 harness 缓冲到 `turn_end` 统一
  落盘，ref 落在 flush 时刻的 leaf 之下，不与触发它的 entry 相邻，任何逻辑都不得依赖
  相邻性；
- ref 是指针不是载荷，上限 2 KB，超了直接抛错而不是截断；
- `origin` 只由 fork 写入（`fork` / `fork_degraded`），会话自己写状态时缺省。它记录
  **发生过什么**，不记录**该怎么办**——后者是下游的事。写侧封闭（只接受已知取值），
  读侧开放（新 build 造的取值原样保留），未知取值一律归类为「非本分支自有」：把继承来的
  状态误判为自有，会让调用方去操作别人的句柄；反过来只是多做一次重建。

provenance 是**每 namespace 每 ref** 的，不是会话的属性：fork 之后会话继续写自己的 ref，
被覆盖的 namespace 就重新变回 `current`。

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
对象），大多数 namespace 用它就够；需要别的形状的自己实现 `CustomStorage`。header 行
记录 envelope 版本、namespace、`formatVersion` 和 owner；envelope 版本高于本 build，
或 owner 不匹配，该 storage 被封存：读降级为空，写抛错——不能让调用方以为对象写成功了，
然后往分支上写一条指向不存在对象的 ref。

依赖只有一种：**对象依赖**，namespace 内部，复制进新会话的同名 storage。namespace 只
声明依赖，不自己递归。去重和环检测只有一份实现，在仓储里。

一个 namespace 的状态不能点名另一个会话。子会话的复制不由任何 namespace 驱动——fork
复制源会话 `agents/` 下的全部子会话。

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
| extension 的 JSON state / snapshot | 通常 copy |
| 已结算 job 的历史 | degrade（历史保留，标记为「在来源会话中中断」） |
| 正在执行的 job、PID、socket、lock | omit |
| credential、外部资源句柄 | omit |

子会话不是一个 namespace，不进这张表。已定的两条子语义：

- **子会话全部复制，按各自的当前 leaf**。没有任何记录点名过子会话，所以「哪些属于这棵
  树」和「回退到哪」都没有依据可查，目录列举是唯一的答案。
- **fork 的子会话保留原 session id**。寻址已经是路径，不再有歧义。

## 实施阶段

1. ~~模型骨架~~：`core/persistence/`，纯逻辑在 `utils/`。**已完成**
2. ~~模型测试~~：`test:counter` namespace 锁住 projection、object store、fork closure、
   provenance 与 owner。**已完成**
3. ~~`JsonlSession` 移植~~：从 pi 的 `jsonl-storage.ts` 逐字段搬，保持 v3 兼容。验证方式是
   **让两份实现读同一份字节并逐项比对**，而不是断言 fixture——后者只能证明移植符合测试的
   预期，前者才证明「pi 写的 WIDI 能读，WIDI 写的 pi 能读」，且 upstream 变动时仍然有效。
   **已完成**
4. ~~仓储实现~~：create/open/list/listChildren/delete/fork，含子会话递归复制。验收
   「fork 后删除源目录，新会话仍可独立恢复」已通过。**已完成**
5. ~~`core:subagent`~~：**取消**。agent 关系归目录嵌套，不做 namespace，理由与新的
   `list_agents` 语义见 `docs/ZH/agent-tree-persistence.md`。删除 `agents/tree.jsonl`
   与 `parent.json` 属于该文档的接线范围。
6. **迁移 `core:jobs`**：state root = 已结算历史快照；活着的 job 不进 ref；一个 turn 内的
   多次变更合并成一条 ref。
7. **extension persistence**：等 project trust、配额、生命周期明确后再开。

## 验收标准

- 回到对话树任意旧节点时，每个 namespace 恢复该路径可见的状态；
- fork 指定节点后，新会话在源目录已删除的情况下可独立恢复；
- 多条 ref 引用同一 root 时，fork 不重复复制对象；
- 循环依赖、未知 namespace、无效 ref、对象缺失、JSONL 尾行损坏均有确定诊断与降级，
  不破坏对话历史读取；
- fork 得到的 state 带 `forked`/`degraded` provenance，会话覆写后变回 `current`；
- namespace 未注册时会话仍可打开、列举、读取、fork，ref 与目录均不被改动；
- owner 不匹配的 namespace 目录被封存，不被误读也不被追加；
- `delete` 删除会话、其 custom storage、其全部子会话；
- runtime 不绕过 `AgentHarness` 写 live session branch；
- 不修改 `packages/agent`，既有 pi v3 session 保持可打开。
