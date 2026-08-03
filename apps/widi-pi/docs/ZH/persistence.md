# Persistence 使用指南

代码位置：`apps/widi-pi/src/core/persistence/`。

这一层回答一个问题：**会话被回退、被分叉、被删除时，它附带的状态该怎么办。**

答案只有一句话：**会话树是权威。** 一份状态由分支上的一条 entry 命名，所以回退到那条 entry 之前它自动失效，分叉一条分支就自动带走它能看见的全部状态。没有任何一种状态可以为回退或分叉定义自己的规则。

其余所有设计——目录布局、内容寻址的对象日志、namespace 契约——都只是为这一句话服务。

---

## 1. 磁盘布局

```
<root>/                                  # 例如 .widi/runs
  --root-projs-widi--/                   # 按项目 cwd 分组，encodeCwd()
    20260801T120345Z_root/               # 一个顶层会话目录
      session.jsonl                      # 对话历史，唯一的权威
      persistence/
        core__jobs/objects.jsonl         # 一个 namespace 的对象日志
      agents/                            # 这个会话 spawn 出来的子会话
        20260801T120400Z_coder-1/
          session.jsonl
          persistence/...
          agents/...
```

三条布局规则：

- **会话目录拥有自己的一切**：历史、custom storage、以及它 spawn 出的子会话目录。所有权、生命周期、可复制性都跟着目录走。删除根会话就删掉整棵子树；fork 根会话就复制一棵子树。（namespace 可以用 `locate` 把自己的目录挪到任何地方，那样它就退出了这条规则的保护范围——见 6.2。）
- **子会话在 `agents/` 下，不与 `session.jsonl` 平级**。这样列目录时永远不用判断某个子目录是子会话还是保留目录。保留名：`agents`、`persistence`、`jobs`（遗留 sidecar）。
- **嵌套深度上限 8 层**（`MAX_SESSION_DEPTH`）。路径每层长两段，Windows 仍有 260 字符限制。超深的 spawn 会降级成顶层会话并报一条 `persistence.nesting_limit`，而不是生成一个谁都打不开的路径。

目录名是 `<紧凑时间戳>_<sessionId>`。时间戳不是装饰：sessionId 等于创建它的 AgentId，只在单次运行内唯一，被 resume 的根会话再 spawn 一次 `coder-1` 就会撞上上一轮的目录。

**`SessionKey` 是会话的逻辑地址**，形如 `["20260801T120345Z_root", "20260801T120400Z_coder-1"]`——只有目录名，不含 `agents/`。持久化记录里指向另一个会话时永远存 `SessionKey`，绝不存文件系统路径，这样磁盘布局可以改而不必重写每一条记录。`SessionAddress = { cwd, key }` 是完整定位。

---

## 2. 会话存储：`JsonlSession`

`session.jsonl` 是 pi 的 v3 JSONL 格式，`JsonlSession` 是 pi `JsonlSessionStorage` 的移植，格式**逐字节兼容**——`tests/core/persistence-session.test.ts` 用差分测试保证这一点：同一份字节同时用两个实现打开，比对元数据、条目、leaf、统计、标签、游标，并双向往返。

第一行是 header（格式版本、会话 id、创建时间、cwd、父会话文件路径、metadata），其后每行一条 `SessionTreeEntry`。entry 有 `id` 和 `parentId`，所以文件是一棵树而不是一条线：`setLeafId` 回退到某个祖先之后继续追加，就长出一条新分支，旧分支仍在文件里。

### 唯一一处必须区分的地方

pi 有 `getPathToRootOrCompaction()`，从 leaf 往根走但**在 compaction 检查点停下**。那是给模型上下文用的。

持久化必须用 **`getFullBranch()`**，走完整的 root→leaf 路径。

理由：compaction 只截断模型看得见的东西，不截断事实。一条比检查点更早的 ref 仍然生效——模型忘记一件事，不代表这件事不成立。真实会话里这个差异很大（实测有 84 比 1、27 比 1 的分支长度差）。

**任何时候在持久化路径上写 `getPathToRootOrCompaction` 都是 bug。**

---

## 3. 仓储：`JsonlPersistenceRepo`

```ts
const registry = new PersistenceRegistry();
registry.register(myJobsNamespace);

const repo = new JsonlPersistenceRepo({ fs, root: ".widi/runs", registry });
```

namespace 名必须是 `owner:name` 这个形状——两段或更多，小写字母数字加连字符，冒号分隔。`register()` 当场校验，不合规直接抛。这是命名规则，**不是路径防线**：带 `locate` 的 namespace 自己挑路径，那条路上这个正则什么都挡不住。

注册表**不封闭**：任何时候、任何地方都可以再注册。代价是分操作的——

| 操作 | 此刻没注册 |
|---|---|
| `stageState` | 直接抛，调用方立刻知道 |
| `resolveState` | 该 namespace 缺席 + 一条 `unknown_namespace`，盘上一个字节不动，注册回来再读就有了 |
| `fork` | **状态不进闭包，新会话永远没有这条 ref。fork 不可逆，事后注册补不回来** |

所以「什么时候注册完」是接线方的责任，这一层不替它决定。

### 会话生命周期

```ts
const root = await repo.create({ cwd, sessionId: "root" });

// 带 parent 就落在 parent 的 agents/ 下
const child = await repo.create({ cwd, sessionId: "coder-1", parent: root.address.key });

await repo.open(address);              // → PersistedSession，不存在则抛 SessionError("not_found")
await repo.list({ cwd });              // → 只列顶层会话，按 createdAt 倒序
await repo.listChildren(address);      // → 直接子会话，一层
await repo.delete(address);            // → 递归删整棵子树，含 custom storage
```

`list` 只列顶层是有意的：子会话是它根会话那棵树的一部分，要通过根恢复。把它和根并列展示，等于给用户一个「打开同一段对话两次」的入口。

### 恢复

```ts
const { projection, states, diagnostics } = await repo.resolveState(address);

const jobs = states.get("core:jobs");
if (jobs) {
  jobs.state;       // namespace 自己 resolveState 出来的值
  jobs.stateRoot;   // 内容哈希
  jobs.provenance;  // "current" | "forked" | "degraded" | "migrated"
}
```

`resolveState` **逐 namespace 降级**：某个 namespace 解不开，就只是它不出现在 `states` 里，外加一条诊断。对话本身永远可读——这是整层存在的目的。

### 写状态

```ts
// 第一步：写对象，拿到 ref 数据
const ref = await repo.stageState({
  address,
  namespace: "core:jobs",
  data: { jobs: [...] },
  dependencies: [previousStateRoot],   // 同 namespace 内的对象依赖
});

// 第二步：通过 harness 把 ref 追加到分支上
await harness.appendCustomEntry(PERSISTENCE_REF_CUSTOM_TYPE, ref);
```

清除一个 namespace（`stateRoot: null`）：

```ts
await harness.appendCustomEntry(
  PERSISTENCE_REF_CUSTOM_TYPE,
  repo.clearState("core:jobs"),
);
```

---

## 4. 为什么仓储没有 `appendEntry`

**仓储读会话树、写 custom storage，但从不写活跃分支。**

`AgentHarness` 才是分支的唯一写者：它串行化写入，并在一个 turn 内把写缓冲起来最后统一 flush。仓储再开一条写路径，追加顺序和 harness 的内存 leaf 指针都会失控。

所以提交状态天生是两步，而且**只能是「先对象后 ref」这个顺序**：

- `appendCustomEntry` 在 turn 内返回 `undefined`（写被缓冲了，还没有 entry id）。所以「先写 ref 占位、拿到 id 后回填哈希」这条路根本不通。
- 对象是内容寻址的，写完就有稳定身份。先写对象，最坏情况是崩溃后留下一行没人引用的孤儿——可回收，不影响任何分支。

唯一例外是 `fork`：它直接 `appendEntry` 到目标会话，因为那个会话还没有任何人持有。

### `anchorEntryId` 不是定位机制

`PersistenceRefData.anchorEntryId` 只是诊断字段。turn 内 ref 是缓冲的，落盘时挂在 flush 时刻的 leaf 上，**不会紧邻触发它的那条 entry**。任何依赖「ref 与某条 entry 相邻」的逻辑都会错。

要区分状态，靠的是 ref 自身在树上的位置，不是它指向谁。

---

## 5. 分叉

```ts
const { session, plan, diagnostics } = await repo.fork(sourceAddress, {
  sessionId: "forked",
  entryId: someEntryId,      // 可选，不给就从当前 leaf 分叉
  position: "before",        // "before"（默认）| "at"
  parent: undefined,         // 默认落到顶层
});
```

执行顺序，每一步都不是实现细节：

1. 复制对话 entries。
2. 投影**源会话的完整分支**得出每个 namespace 的 state root。注意不是投影「复制出来的 entries」——不带 fork 点时那些 entries 是**文件顺序的所有分支**，文件最后一行可能属于一条被放弃的分支。
3. 计算每个 namespace 的对象闭包（`planForkClosure`）。
4. 复制对象、应用每个 namespace 的策略、递归 fork 源会话 `agents/` 下的每一个子会话。
5. 给每个存活的 namespace 追加一条**全新的 ref**，带上 `origin`。

之后新会话不从源目录读任何东西。这是整个设计被检验的那条性质——测试里的做法是 fork 完直接把源目录删掉，再验证新会话仍能解析出自己和子会话的状态。**这条性质只对住在会话目录里的 namespace 成立**，`locate` 出去的那些自己负责（6.2）。

**子会话全部复制，不做分支筛选。** 没有任何记录点名过子会话，目录列举是唯一的答案，所以 fork 点之后才 spawn 的那些也一起带走。每个子会话停在它自己的当前 leaf——同样因为没有任何 ref 把子会话钉在父的某个时刻上。见 `docs/ZH/agent-tree-persistence.md`。

子会话仍然是**递归 fork 而不是 `cp -r`**：每一层各自投影自己的分支、算自己的闭包、应用自己的 namespace 策略。

**fork 绝不写源会话。** `degrade` 策略要造一个新对象（比如把运行中的 job 标成 interrupted），那个对象属于新会话，写进源会话会让它持有一份只有别人需要的状态。

---

## 6. Custom Storage

### 6.1 最简单的形态

大多数 namespace 只需要「记住这个值、让分支能命名它、fork 时复制它」。`JsonlObjectStore` 就是这个东西，直接用即可：

```ts
import {
  JsonlObjectStore,
  OBJECTS_FILE_NAME,
  type PersistenceNamespaceDefinition,
} from "../persistence/index.ts";

export const jobsNamespace: PersistenceNamespaceDefinition = {
  namespace: "core:jobs",
  version: 1,
  forkPolicy: "degrade",

  async openStorage(context) {
    return await JsonlObjectStore.open({
      fs: context.fs,
      dirPath: context.dirPath,
      filePath: `${context.dirPath}/${OBJECTS_FILE_NAME}`,
      namespace: "core:jobs",
      formatVersion: 1,
      sessionKey: context.sessionKey,
      diagnostics: context.diagnostics,
      owner: context.owner,
    });
  },
};
```

框架只承诺 namespace 三件事：**一个自己的目录、一种被分支命名的方式、分支被 fork 时的递归复制**。目录里的形状完全自定，`layout.ts` 的嵌套规则管的是会话层，不伸进 namespace 目录。

唯一硬性要求：**state root 必须不可变**。分支命名了它，一条不再是当前的分支仍然必须能解析出它当初命名的东西。

### 6.2 换一个存放位置：`locate`

默认目录是 `<session>/persistence/<namespace>/`。不想要这个位置，给定义加一个 `locate`：

```ts
locate: ({ address, defaultDirPath, persistenceRoot }) =>
  `${persistenceRoot}/shared/${address.key[0]}`,
```

仓储拿它的返回值当作这个 namespace 的目录，原样读写，`context.dirPath` 收到的就是它。`repo.openDefaultStorage()` 也走同一条路，所以在自己的 `openStorage` 里调它不会绕回默认布局。

两条规则，**这一层一条都不强制**：

1. **必须是请求的纯函数，而且跨 build 保持不变。** 下一个进程里的 resolve 要算出同一个路径，fork 要算出一个**还不存在的会话**的路径。做不到这点，状态就是找不回来。
2. **返回什么就用什么。** `encodeCwd`、`sessionDirSegments`、`namespaceDirSegments` 全是导出的，所以你能寻址仓储能寻址的一切，包括别的会话的目录。路径逃逸不逃逸，这一层不看。

离开会话子树之后，下面这些**变成定义方自己的问题**：

- **回收**。`repo.delete()` 只 `rm -rf` 会话目录，它绝不删自己没放的东西。你的目录会留在盘上。
- **隔离**。默认布局保证一个会话一份日志。共享路径就没有这个保证了，并发写、owner 封存、损坏日志的影响面都归你管。
- **自足性**。「删掉源目录，fork 出来的会话仍能解析」这条性质你不再免费拥有。

fork **仍然正常工作**：它走的是 `copyReachable(source → target)` 两个 handle，从来就不是 `cp -r` 目录。共享路径下 source 和 target 是同一份存储，这次拷贝退化成自拷贝——因为对象内容寻址、`putObject` 按内容幂等，它是个无害的 no-op，新会话的 ref 照样解析得出。

### 6.3 状态不能引用子会话

一个 namespace 的状态**不能点名另一个会话**。曾经有过这个能力（`CustomStorage.listSessionDependencies` 与对象日志的 `sessionDependenciesOf` 钩子），唯一的使用者是已经取消的 `core:subagent`，随它一起删掉了。

子会话的复制不再由任何 namespace 驱动：fork 复制源会话 `agents/` 下的全部子会话，与分支上有什么无关。见第 5 节与 `docs/ZH/agent-tree-persistence.md`。

同 namespace 内的对象依赖不受影响：`putObject({ data, dependencies })`，或自定义 storage 的 `listDependencies`。**namespace 自己永远不递归**——依赖只做声明，遍历、去重、环检测在 `fork-closure.ts` 里只有一份实现。

### 6.4 fork 策略

```ts
readonly forkPolicy: "copy" | "omit" | "degrade";
```

| 策略 | 适用 | 结果 ref 的 origin |
|---|---|---|
| `copy` | 纯数据 | `fork` |
| `omit` | 指向会话外部的句柄——pid、socket、凭据。复制会把它伪装成仍然有效 | 无 ref，报 `persistence.fork_omitted` |
| `degrade` | 两者皆是。job 的历史值得带走，它的活进程不值得 | `fork_degraded` |

`degrade` 需要自己实现 `fork`：

```ts
async fork({ source, target, roots, diagnostics }) {
  const root = roots[0];
  const state = await source.resolveState(root) as JobsState;
  return {
    stateRoot: await target.putObject({
      data: { ...state, jobs: state.jobs.map(markInterrupted) },
    }),
  };
}
```

返回 `stateRoot: null` 表示新分支不为这个 namespace 带任何 ref。`origin` 可以显式覆盖，默认由 `forkPolicy` 推出——只有「`copy` 策略下实际发生了降级」才需要自己写。

### 6.5 版本与迁移

`definition.version` 是这个 namespace 自己数据的格式版本，会写进对象日志的 header。`CustomStorage.storedFormatVersion` 报告磁盘上实际是哪个版本。

盘上版本低于 definition 版本时，仓储调用 `migrate`：

```ts
async migrate({ fromVersion, stateRoot, storage }) {
  const old = await storage.resolveState(stateRoot);
  return await storage.putObject({ data: upgrade(old, fromVersion) });
}
```

新对象写进同一个日志，旧到新的映射**每次打开重算**。**分支永远不被重写**：ref 永远命名旧 root，追加一条「更正后的 ref」会让同一个 leaf 因为打开它的 build 不同而解析出不同结果。

没有 `migrate` 就报 `persistence.unsupported_version` 并降级，不抛异常。

迁移成功的状态 `provenance` 是 `"migrated"`。

### 6.6 `owner`：namespace 名字可以被回收

namespace 名全局唯一，但**不是保留的**。一个 extension 被卸载后，另一个可以声明同样的名字，然后读到前一个写的对象，按自己的 schema 解释它们。

`owner` 写进日志 header 并在 open 时校验，把这件事变成明确的拒绝而不是静默误读。不匹配时日志被**封存**：读降级为空，写直接抛异常——因为被告知「对象已存好」的调用方会接着往分支上写一条命名它的 ref。

`owner` 必须是**稳定身份，里面不能有版本**。extension 升级应该是 bump `version` 并保留自己的状态；改 owner 会把升级后的 build 锁在自己写的数据之外。

本 build 自带的 namespace 省略 `owner`。

### 6.7 完全自己实现 storage

`CustomStorage` 接口：

```ts
resolveState(stateRoot): Promise<unknown | undefined>   // 不存在返回 undefined，不抛
listDependencies(stateRoot): Promise<readonly string[]> // 同 namespace 内的对象依赖
copyReachable(target, roots): Promise<void>             // 闭包已算好，照抄即可；重复复制必须是 no-op
putObject({ data, dependencies? }): Promise<string>     // 按内容幂等
storedFormatVersion?: number
close?(): Promise<void>
```

`copyReachable` 收到的是仓储已经闭包过的集合，**不要再走一遍**。同一个 root 被多条 ref 命名是常态而非错误，所以复制已存在的对象必须是 no-op。

### 6.8 handle 的生命周期

**谁 open 谁 close。不缓存、不引用计数。**

`openStorage` 每次调用都新建一个 handle（打开时要 replay 整个日志），共享就要判断何时失效，而仓储没有判断依据。

- 仓储内部用的 handle（`stageState`、`resolveState`、`fork`、闭包计算）由仓储自己关。
- `repo.openStorage()` / `repo.openDefaultStorage()` 交给你的 handle **归你关**：

```ts
const storage = await repo.openStorage(address, "core:jobs");
try {
  ...
} finally {
  await closeStorage(storage);
}
```

`close` 契约上**永不抛**。`closeStorage()` 会吞掉异常：close 跑在它要收尾的工作完成之后，此时已经没有东西可以失败，让一个违反契约的实现把已经成功的操作变成失败是荒谬的。

---

## 7. 恢复的三层，以及不属于这一层的事

「恢复一个会话」有三步，这里只做前两步：

| 步骤 | 内容 | 归属 |
|---|---|---|
| 投影 Projection | 分支上哪个 state root 生效 | **框架**，不接受任何 per-namespace 覆盖 |
| 解析 Resolution | 那个 root 的内容是什么 | **namespace** |
| 激活 Activation | 拿到之后做什么——要不要重启 agent、重连进程、只是警告 | **调用方，这里刻意没有钩子** |

投影不给覆盖，否则「回退」这个动作会因为会话恰好持久化了什么而含义不同。

激活不给钩子，是因为它依赖这一层看不见的东西：进程还活着吗、当前配置还允许这个 extension 吗、用户是在 resume 还是 continue 还是第一次运行一个 fork。加一个钩子等于逼每个 namespace 去猜这些，而且猜错了不会有任何提示。

这一层欠调用方的，是只有它才知道的事实，也就是 `provenance`：

| provenance | 含义 |
|---|---|
| `current` | 这条分支自己写的 |
| `forked` | fork 继承来的 |
| `degraded` | fork 时降级过 |
| `migrated` | 本次打开时迁移出来的（不记录在 ref 里，每次 resolve 重算） |

**`provenance` 是每个 namespace 每条 ref 各自的，不是整个会话的。** fork 之后会话继续写自己的 ref，被覆盖的 namespace 就回到 `current`——一个 fork 后又自己写过状态的 namespace，那份状态就是它自己的。

未知的 `origin` 一律**不算** native。两个方向的代价不对称：把继承来的状态误判成自己的，会让调用方去操作属于别的会话的句柄；反过来只是多做一次本可以省掉的重建。

---

## 8. 未注册的 namespace，以及 GC 禁令

`resolveState` 遇到注册表里没有的 namespace 时：**ref 原样留在分支上，目录原样留在磁盘上**，只报一条 `persistence.unknown_namespace` warning。

因为这一层分不清这四种情况：

1. extension 被卸载了
2. extension 加载失败了
3. 用户手动禁用了它
4. 这个 build 从来就没实现过它

它看到的只是注册表里一个空槽位。四种情况只有一个共同的安全动作，就是什么都不动。

> **GC 绝不能由注册表状态驱动。** 一次加载失败会摧毁一个正常工作的 extension 的全部状态。回收磁盘是调用方的决定，且必须有注册表之外的依据。

extension 装回来，状态就还在——测试里明确断言了这一点：空注册表读一遍之后 `fs.files` 字节不变。

---

## 9. 诊断码

全部来自 `utils/diagnostics.ts`。这一层只要不是编程错误就降级不抛，代价是必须精确告诉调用方它没拿到什么。

| 码 | 含义 |
|---|---|
| `persistence.dangling_ref` | ref 指向的对象不在日志里 |
| `persistence.invalid_ref` | 本 build 无法解释的 ref |
| `persistence.unknown_namespace` | ref 指向没有注册的 namespace |
| `persistence.unsupported_version` | 日志格式比本 build 新，或旧版本无法迁移 |
| `persistence.owner_mismatch` | 目录属于别的代码；日志被封存 |
| `persistence.corrupt_log` | JSONL 在非最后一行处损坏 |
| `persistence.dependency_cycle` | 依赖成环，遍历就地停止 |
| `persistence.fork_degraded` | namespace 无法完整复制，降级带过去 |
| `persistence.fork_omitted` | namespace 按自己的策略被排除在 fork 之外 |
| `persistence.child_not_copied` | 子会话目录复制失败 |
| `persistence.nesting_limit` | spawn 太深，改为持久化成顶层会话 |
| `persistence.object_write_failed` | 对象没写成，状态未被记录 |

`PersistenceDiagnostics` 是一个收集器，遍历过程中报完所有问题再返回它能构建出的部分，不在第一个问题处停止。部分恢复的会话正是这个设计要让它可用的结果。

---

## 10. 往分支上写东西的成本

`session.jsonl` 上的每条 entry 都会：在每次 resume 时被重放进上下文、被 fork 进每一个子会话、并且**无法删除**。

所以 ref 只放指针，永远不放载荷。依赖信息放在它命名的对象里，不放在 ref 里——两边都放必然漂移，而 fork 的遍历反正要打开 storage。ref 有 2048 字节上限，那不是给真实数据留的余量，是用来抓住「把 ref 当存储用」的调用方。

新增任何一处 harness 会话写入调用点，都要向用户报告：写了什么、以及为什么这件事必须活在分支上。参见 `AGENTS.md` 与 `docs/pi-fork.md` 的「The session write surface」。

---

## 附：目前已知的粗糙处

- `NamespaceStorageContext` 只给 `dirPath`，namespace 要自己拼 `objects.jsonl` 的路径。`repo.openDefaultStorage()` 拼得对，但 `openStorage(context)` 里拿不到 repo。目前的写法是模板字符串加 `OBJECTS_FILE_NAME`。
- `stageState` 返回 `PersistenceRefData` 之后，把它送进 harness 那一步没有封装。等 orchestrator 和 jobs 两边都写完、确认错误处理一致之后再抽公共函数更稳妥。
