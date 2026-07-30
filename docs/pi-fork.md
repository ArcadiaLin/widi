# Forking Pi's agent package

## Why the fork exists

WIDI's runtime is built on `AgentHarness`. Upstream plans to replace it: `packages/agent/docs/harness-v2.md` specifies a full rewrite of `packages/agent/src/harness` and a greenfield SQLite schema, under a compatibility policy that keeps exactly one guarantee - old coding-agent v3 JSONL sessions must open and restore idle. Everything else in the harness and storage surface may break.

WIDI cannot ride that rewrite while it lands. The orchestrator consumes the harness deeply: sixteen harness methods, five hooks, and the whole event vocabulary. So the harness is frozen at a known-good upstream release and owned locally, while the two packages that keep improving without breaking us stay on the registry.

This is a freeze, not a divorce. Re-sync is expected; the conditions are at the end of this document.

## The split, and why it falls here

| Package | How we consume it | Why |
| --- | --- | --- |
| `packages/agent` (`@widi/agent-core`) | vendored into this repo | The only package harness-v2 rewrites, and the one we extend. |
| `@earendil-works/pi-ai` | published tarball, exact version | Fast-moving, additive for us. harness-v2 only adds `fetchDeferred`/`cancelDeferred`. |
| `@earendil-works/pi-tui` | published tarball, exact version | Independent: its only dependencies are `get-east-asian-width` and `marked`. Untouched by harness-v2. |
| `reference/pi` | untracked local clone, read only | Source of upstream history for cherry-picks, and the reference implementation we calibrate behavior against. |

The dependency graph makes this clean: `pi-tui` depends on neither of the others, and `pi-agent-core` depends only on `pi-ai` (sixteen import sites, all through the package root, no deep paths). There is no diamond - `pi-ai` does not depend on the agent package.

Upstream `packages/storage/sqlite-node` is deliberately not vendored: WIDI persists sessions as JSONL through `SessionDirectoryRepo`, and harness-v2 replaces that schema wholesale anyway.

## Baseline and complete divergence

Vendored from upstream commit `845d6ff1f6643aba440341cce877ce1c43ebbc39` (`v0.83.0`). The `version` field in `packages/agent/package.json` tracks that release and is bumped only on re-sync.

`packages/agent/src` is byte-identical to upstream except for one addition:

- `src/harness/agent-harness.ts`: `AgentHarness.promoteFollowUpsToSteer()`. A follow-up is only read where the agent would otherwise stop, so a user who queued one and then cannot wait has no way to promote it; re-sending the text as a steer would deliver it twice, and only the harness can take the message back out. Used by `agent-orchestrator.ts` via `steerQueuedFollowUps`.

`packages/agent/test` diverges in three places:

- `test/harness/agent-harness.test.ts`: two tests for the promotion path, plus `textFromUserMessages` widened to `content?: unknown` so an `AgentMessage[]` - a union whose bash-execution member carries no `content` - can be passed directly. Without the widening the promotion test does not type-check against v0.83.0.
- `test/harness/session-test-utils.ts`: the package self-reference now names `@widi/agent-core`.
- `test/harness/sqlite-migrations.test.ts` and `test/harness/sqlite-node.test.ts`: removed. They import `packages/storage/sqlite-node`, which is not vendored.

Nothing in `packages/agent/src` references SQLite, so removing those tests costs no source coverage.

Upstream's own `docs/` is kept inside the package because it documents the code the package now owns. `LICENSE` is upstream's MIT notice and stays with the code.

## Carrying upstream work across

`reference/pi` is the upstream mirror: an ordinary clone, untracked and gitignored, that nothing builds from. Clone it when it is missing:

```bash
git clone https://github.com/earendil-works/pi.git reference/pi
```

Cherry-picks are file-level, not git-level, because the paths differ (`packages/agent/...` in a different repository):

```bash
git -C reference/pi fetch origin
git -C reference/pi log --oneline 845d6ff1..origin/main -- packages/agent/src packages/agent/test
git -C reference/pi diff 845d6ff1..<commit> -- packages/agent/src/harness/foo.ts
```

Apply the hunks by hand into `packages/agent`, keep upstream's formatting (see invariants), then run `npm run check` and `npm run test`. Record anything that changes the divergence list above.

To audit the divergence list at any time, diff the two trees directly:

```bash
diff -r reference/pi/packages/agent/src packages/agent/src
diff -rq reference/pi/packages/agent/test packages/agent/test
```

That only reads as our divergence while `reference/pi` sits at the baseline commit. After pulling it forward, compare against `845d6ff1` instead: `git -C reference/pi worktree add ../pi-baseline 845d6ff1`.

Keeping the vendored files byte-identical to upstream is what makes this cheap. Every gratuitous reformat turns a clean hunk into a conflict.

### Upstreaming our own work

The rule that fell out of the fork: **a patch to code harness-v2 deletes is not worth a pull request; a requirement harness-v2 has not settled is worth an issue.**

`promoteFollowUpsToSteer` is the first case. It sits on the `promote-followups-to-steer` branch of `reference/pi` (based on `v0.83.0`, pushable to the `fork` remote `ArcadiaLin/pi`), and it is deliberately not filed upstream: it edits `agent-harness.ts`, which harness-v2 lists as "the harness being replaced". Upstream has no reason to review code it is deleting, and we would not consume the merge - the shipping copy is `packages/agent`. The branch is kept only as a historical marker.

What is worth sending upstream is the requirement behind it. harness-v2's lane queues are `steer`/`followUp`/`nextRun` with no promotion path, and its open questions are still collecting input, so the queue semantics are not frozen. An issue against the design costs nothing and targets live code.

The same test separates this from the JSONL header metadata work on the `jsonl-header-metadata` branch: harness-v2 defines a new v4 header and is actively designing it, so that conversation still has a live target.

## What we gave up

We can no longer patch `pi-ai` or `pi-tui` in place. This has come up before: `packages/ai/src/providers/opencode-go.ts` needed the `openai-responses` API registered because live models.dev data began serving `grok-4.5` through it. That patch is upstream as of v0.83.0.

If it recurs, in order of preference:

1. Do it in WIDI. Provider registration already lives in `model-registry.ts`, which is usually the better home anyway.
2. Send an upstream pull request. That is how the `opencode-go` case actually resolved.
3. Last resort: an npm `overrides` entry pointing at a fork tarball.

## Invariants

Breaking any of these is how this arrangement fails.

**Keep `typebox` at exactly the version published `pi-ai` pins (1.3.7 today).** `TSchema` crosses the package boundary - `ResolvedAgentHarnessTool extends AgentHarnessTool<ToolAdapterContext, TSchema, unknown>` in `tool-registry.ts`. Two copies of typebox are two structurally distinct `TSchema` types. Before the fork this was masked: every tsconfig mapped `typebox` to a single copy, so the mismatch between the app's 1.1.38 and pi's 1.3.7 never surfaced. Published `.d.ts` files resolve their own dependencies, so the mapping no longer hides it.

**Pin `pi-ai` and `pi-tui` to exact versions, never a caret range.** They iterate fast and have broken us: v0.83.0 added a five-minute proactive OAuth refresh window in `src/auth/resolve.ts`, which sent a WIDI test at the real GitHub API. Bump deliberately, with the test suite as the gate. A caret range on a fast-moving dependency is also what produced the shadowing bug below.

**A version range that the workspace cannot satisfy is silently fatal.** When `apps/widi-pi` still asked for `^0.81.1` while the workspace held 0.83.0, npm installed published 0.81.1 into `apps/widi-pi/node_modules/@earendil-works/` and shadowed the workspace packages. The root type check stayed green because it resolves through path mappings; only `tsconfig.build.json`, which resolves from `node_modules`, failed. Renaming the vendored package to `@widi/agent-core` removes the collision for the agent package - do not rename it back.

**Do not reformat `packages/agent`.** Root `biome.json` applies upstream's formatter settings (tab, width 3, line width 120) and upstream's lint relaxations to `packages/agent/**`, while `apps/**` keeps WIDI's defaults (tab, width 2, line width 80). The partition exists so `npm run check --write` cannot rewrite ten thousand vendored lines.

**Type-check from the repository root.** `npm run check` uses the root `tsconfig.json`, which covers `packages/agent/{src,test}` and `apps/widi-pi/{src,tests}`. The app's own `check` script only sees the app.

## What the fork bought us

Beyond the freeze itself, dropping `pi-ai` and `pi-tui` to published tarballs removed two long-standing chores:

- **No model-data generation.** `pi-ai` used to import generated, gitignored catalogs from `src/providers/data/*.json`, so every submodule update meant re-running a generator that fetches live models.dev data over the network. The published tarball ships `dist/providers/data/*.json`; `npm run build` no longer touches the network.
- **No pi dist rebuilds.** The app used to resolve three pi packages through dists we had to rebuild ourselves, and a stale dist silently omitted new modules - this once broke `kimi-coding` OAuth login because `dist/auth/oauth/kimi-coding.js` was never emitted. Only `packages/agent` is built locally now.

Source reading survives: both tarballs ship declaration maps with `sourcesContent` embedded, so editor navigation still lands in real TypeScript.

## Re-sync conditions

Revisit this arrangement when all of the following hold:

1. harness-v2 has landed upstream and its API has stopped moving across at least two releases.
2. The three gaps WIDI needs are answered, or we have accepted owning them:
   - **Follow-up promotion.** harness-v2's lane queues are `steer`/`followUp`/`nextRun` with no promotion. Our patch does not port as written: its rollback works by splicing in-memory arrays, and harness-v2's queues are append-only durable records, so promotion has to become a record-level operation.
   - **Human-in-the-loop suspension.** `SuspendedOperation.reason` is `crash | deferred`. WIDI's `ask_human` awaits a person inside a tool call, which harness-v2 recovery treats as an interrupted tool and closes with a synthetic result. A third reason is needed.
   - **Background jobs.** harness-v2 has no t0/t1 split. Our backgroundable tools resolve a handle at t0 and deliver the outcome later as a message; that composes with harness-v2's step model, and `queue_enqueued` would make t1 delivery durable, but job execution stays as mortal as it is today. `BackgroundJobStore` does not go away.
3. The migration is priced. The method surface maps almost one to one, including all five hooks (`before_agent_start` to `before_run`, `before_provider_request` to `before_request`/`before_payload`, `context` to `transform_context`, `tool_call` to `before_tool`, `tool_result` to `after_tool`). The real work is the storage adapter, the session snapshot and tree queries behind `SessionHydrator`, and the loss of the harness's type parameters - `WidiAgentHarness` currently instantiates four, harness-v2 keeps only the tool context, so `ResolvedAgentHarnessTool`'s extra fields need a new home.

Until then, harness-v2 is a design to mine rather than a dependency to track. Part II of that document - the record model, provisioned ids, and recovery - is backend-neutral and does not require lanes, which is the part worth adopting into our own layer first. Lanes themselves model shared history across parallel positions; WIDI isolates agents by spawn tree and passes messages, so lanes are the one piece to leave alone.
