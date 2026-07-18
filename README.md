# widi

[![CodSpeed](https://img.shields.io/endpoint?url=https://codspeed.io/badge.json)](https://app.codspeed.io/ArcadiaLin/widi?utm_source=badge)

WIDI is a multi-agent runtime built on the `AgentHarness` module of [Pi](https://github.com/earendil-works/pi) (`pi-agent-core`). Pi's harness owns single-agent concerns — model turns, the session tree, resources, tools, stream lifecycle. WIDI adds the runtime above it: agent lifecycle and orchestration, declarative profiles, session resume, model/auth registries, structured diagnostics, and an extension surface over all of it.

To be precise about what this repository is today: a runtime core with a documented architecture and a test suite, not yet a usable coding-agent product. What might still make it worth reading:

**It is a real consumer of Pi's harness module.** `pi-coding-agent` runs on its own `AgentSession` runtime and does not use `AgentHarness`; the harness is a clean module without a first-party product consumer so far. WIDI builds its entire runtime on it — session tree, resume, compaction, queue semantics — and feeds the gaps it hits back upstream instead of patching the submodule. Missing primitives are recorded in the [`Pi upstream roadmap`](apps/widi-pi/docs/zh-CN/core/pi-upstream-roadmap.md); WIDI now consumes Pi's JSONL session repository directly, including opaque header metadata used for recovery references.

**Agents are runtime entities, not processes.** Pi's experimental orchestrator package supervises full coding-agent instances as RPC subprocesses. WIDI takes the other branch of that trade-off: multiple harnesses live in one process and share a tool registry, profile registry, session repo, and diagnostics channel, so agent lifecycle, availability, and recovery are observable inside the runtime rather than across process boundaries. This costs the isolation a process model gives you; the bet is that first-class orchestration semantics are worth it, and it is a bet — the collaboration tools that would prove it are still on the roadmap.

**Decisions are recorded, including the failed ones.** Milestones stay at planning level and only admit work with a concrete runtime goal ([`TODO.md`](apps/widi-pi/docs/zh-CN/TODO.md)). Settled boundaries live in canonical mechanism documents; detailed implementation history stays in Git. For example, command input is documented as an interaction-layer engine owned by the TUI rather than the orchestrator in [`runtime.md`](apps/widi-pi/docs/zh-CN/core/runtime.md), and session/auth/config storage explicitly declares a single-process write assumption rather than shipping a half-locked file protocol.

## At a glance

Three ways to get more than one agent out of the Pi codebase today:

| | `pi-coding-agent` | pi `orchestrator` (experimental) | WIDI |
| --- | --- | --- | --- |
| Execution kernel | its own `AgentSession` runtime | one full coding-agent per instance | Pi `AgentHarness` |
| An "agent" is | the app session | an RPC subprocess | a runtime entity: profile + harness + session + status |
| Shared across agents | — (single agent) | nothing — per-process state | tool registry, profile registry, session repo, diagnostics channel |
| Failure surface | app/UI messages | process exit, RPC errors | structured diagnostics (`profile.*`, `model.*`, `extension.*`) with recoverability flags |
| Extension scope | single-agent app events (shipped, mature) | — | API v1: tool register/patch, resources/providers, scoped actions, observers/interceptors |

Two pipelines that are already landed and tested. Input handling — an interaction-layer command engine owned by the TUI and shared with the CLI, not an orchestrator protocol:

```text
client input ──→ CommandEngine ──→ /command ──→ atomic orchestrator method ──→ event fanout
                    │                │
                    │                └─ /quit /exit ──→ ApplicationCommandHost ──→ app shutdown
                    │
                    └──→ inline expansion <prompt:…> <skill:…> ──→ promptAgent ──→ harness turn
                          └─ original input preserved as a session custom entry
```

Session resume — the reason WIDI needs [header metadata](https://github.com/ArcadiaLin/pi/tree/jsonl-header-metadata) on line 1 of the JSONL file:

```text
sessions/*.jsonl ──→ list(): read line 1 only ──→ candidates (id, cwd, metadata.profile)
                                                        │
        profile registry ←── parse profile reference ←──┘
              │
              ├─ missing / disabled ──→ structured diagnostic, no harness created
              │
              └─ resolved ──→ session.buildContext() ──→ messages, model, thinking level,
                                                         active tools ──→ new AgentHarness
```

## Status

The runtime foundation, seven core coding tools, command input, structured diagnostics, and extension API v1 are implemented. Current milestones are deliberately high-level: close the minimal multi-agent collaboration loop, move diagnostic construction toward domain runtimes, then improve core readability. See the [Chinese milestones](apps/widi-pi/docs/zh-CN/TODO.md).

Documentation uses a stable [language entry point](apps/widi-pi/docs/README.md); the current canonical set is Simplified Chinese. Code, identifiers, and diagnostics are English throughout. See [`apps/widi-pi/README.md`](apps/widi-pi/README.md) for the module-by-module overview.

## Workspace layout

- `apps/widi-pi`: the WIDI runtime core (active product code), exposing the `widi-harness` binary from `dist/cli.js`.
- `pi/packages/ai`: local workspace source for `@earendil-works/pi-ai`.
- `pi/packages/agent`: local workspace source for `@earendil-works/pi-agent-core`.
- `pi/packages/tui`: local workspace source for `@earendil-works/pi-tui`.

The checked-in `pi/` directory is the upstream Pi repository as a git submodule, resolved locally as workspace packages. WIDI treats `pi/*` as vendor code and does not modify it; gaps are fed back upstream or recorded in the [upstream roadmap](apps/widi-pi/docs/zh-CN/core/pi-upstream-roadmap.md).

## Development setup

Prerequisites: Node.js >= 22.19 and npm. Then:

```bash
git submodule update --init --recursive   # check out the pi submodule
npm install                               # install workspace dependencies
node pi/packages/ai/scripts/generate-models.ts   # generate pi's built-in model data
npm run build        # build all workspace packages
npm run check        # Biome formatting/linting and TypeScript checks
npm run test         # run workspace tests
```

Notes on the moving parts:

- **Pi's model data is generated, not checked in.** `pi-ai` imports provider model catalogs from `pi/packages/ai/src/providers/data/*.json`, which are gitignored upstream. Type checks and builds fail until they exist. `npm run build` regenerates them as part of the pi-ai build; the standalone `generate-models.ts` run above is only needed when you type-check without building.
- **`npm run check` covers `apps/widi-pi`.** To type-check the whole monorepo including the pi packages, run `npx tsgo --noEmit -p tsconfig.json`.
- The root TypeScript config maps `@earendil-works/pi-*` imports to the pi sources and uses `module: NodeNext`, matching upstream's own config (required for pi's JSON import attributes).

### Updating the pi submodule

Pi tracks upstream `main`. After pulling the submodule to a new commit:

```bash
git -C pi fetch origin
git -C pi checkout origin/main
node pi/packages/ai/scripts/generate-models.ts   # re-run after every pi update
```

If the generator also rewrites tracked files (it refreshes `*.models.ts` when a provider's live model list has drifted since upstream last committed), restore them with `git -C pi checkout -- <files>` — the generated `data/*.json` stay valid, and a clean submodule keeps future pulls trivial. Then run `npm run check` and the test suite; upstream API breaks surface as type errors in `apps/widi-pi`.

## Benchmarks

Performance is tracked continuously with [CodSpeed](https://codspeed.io). The benchmarks use [vitest](https://vitest.dev) bench through the `@codspeed/vitest-plugin` and live in `apps/widi-pi/bench`.

Run them locally:

```bash
npm --workspace apps/widi-pi exec -- vitest bench --run
```

On every push to `main` and every pull request, the CodSpeed GitHub Actions workflow runs the benchmarks in CPU simulation mode and reports performance changes.
