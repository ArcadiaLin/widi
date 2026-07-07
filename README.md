# widi

[![CodSpeed](https://img.shields.io/endpoint?url=https://codspeed.io/badge.json)](https://app.codspeed.io/ArcadiaLin/widi?utm_source=badge)

WIDI is a multi-agent runtime built on the `AgentHarness` module of [Pi](https://github.com/earendil-works/pi) (`pi-agent-core`). Pi's harness owns single-agent concerns — model turns, the session tree, resources, tools, stream lifecycle. WIDI adds the runtime above it: agent lifecycle and orchestration, declarative profiles, session resume, model/auth registries, structured diagnostics, and an extension surface over all of it.

To be precise about what this repository is today: a runtime core with a documented architecture and a test suite, not yet a usable coding-agent product. What might still make it worth reading:

**It is a real consumer of Pi's harness module.** `pi-coding-agent` runs on its own `AgentSession` runtime and does not use `AgentHarness`; the harness is a clean module without a first-party product consumer so far. WIDI builds its entire runtime on it — session tree, resume, compaction, queue semantics — and feeds the gaps it hits back upstream instead of patching the submodule: missing primitives are recorded in [`pi-upstream-roadmap.md`](apps/widi-pi/docs/core/pi-upstream-roadmap.md), and concrete proposals are kept as minimal diffs (current example: opaque JSONL session header metadata, prototyped on
[`ArcadiaLin/pi#jsonl-header-metadata`](https://github.com/ArcadiaLin/pi/tree/jsonl-header-metadata) with the consuming code in `apps/widi-pi/src/storage`).

**Agents are runtime entities, not processes.** Pi's experimental orchestrator package supervises full coding-agent instances as RPC subprocesses. WIDI takes the other branch of that trade-off: multiple harnesses live in one process and share a tool registry, profile registry, session repo, and diagnostics channel, so agent lifecycle, availability, and recovery are observable inside the runtime rather than across process boundaries. This costs the isolation a process model gives you; the bet is that first-class orchestration semantics are worth it, and it is a bet — the collaboration tools that would prove it are still on the roadmap.

**Decisions are recorded, including the failed ones.** Milestones only accept work that names an existing consumer or test that needs it ([`TODO.md`](apps/widi-pi/docs/TODO.md)). The command-runtime experiment was reviewed, judged a failure, and its reversal is documented with reasons ([`command-experiment.md`](apps/widi-pi/docs/core/command-experiment.md)). Boundaries are stated instead of implied — for example, session/auth/config storage declares a single-process write assumption rather than shipping a half-locked file protocol.

## At a glance

Three ways to get more than one agent out of the Pi codebase today:

| | `pi-coding-agent` | pi `orchestrator` (experimental) | WIDI |
| --- | --- | --- | --- |
| Execution kernel | its own `AgentSession` runtime | one full coding-agent per instance | Pi `AgentHarness` |
| An "agent" is | the app session | an RPC subprocess | a runtime entity: profile + harness + session + status |
| Shared across agents | — (single agent) | nothing — per-process state | tool registry, profile registry, session repo, diagnostics channel |
| Failure surface | app/UI messages | process exit, RPC errors | structured diagnostics (`profile.*`, `model.*`, `extension.*`) with recoverability flags |
| Extension scope | single-agent app events (shipped, mature) | — | tool register/patch + interceptor MVP today; orchestration-level hooks planned (ME) |

Two pipelines that are already landed and tested. Input handling (M1) — commands are an orchestrator input protocol, not a UI feature:

```text
client input ──→ gateway ──→ /command? ──→ gating ──→ atomic orchestrator method ──→ event fanout
                    │                        │
                    │                        └─ missing args ──→ argumentsCompletion
                    │                                            (human request) ──→ re-check
                    │
                    └──→ inline expansion  <prompt:…> <skill:…> ──→ expanded message ──→ harness turn
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

- **M1 — command consolidation: done.** Trigger-based command input is an orchestrator capability (inline expansion, argument completion via human requests); the separate command runtime was retired.
- **M2 — in progress.** Core built-in coding tools (read landed, write/edit next) and a minimal stdout/CLI adapter — until that adapter lands, tests are the runtime's main consumer.
- **ME (extension surface) and M3 (agent collaboration tools) follow.** Extension claims wait until ME ships; the design intent is hooks at the orchestration level (agent lifecycle, human requests, cross-agent diagnostics) that a single-agent extension API cannot see.

Design documents under [`apps/widi-pi/docs/`](apps/widi-pi/docs/) are currently written in Chinese; code, identifiers, and diagnostics are English throughout. See [`apps/widi-pi/README.md`](apps/widi-pi/README.md) for the module-by-module overview.

## Workspace layout

- `apps/widi-pi`: the WIDI runtime core (active product code).
- `pi/packages/ai`: local workspace source for `@earendil-works/pi-ai`.
- `pi/packages/agent`: local workspace source for `@earendil-works/pi-agent-core`.
- `pi/packages/tui`: local workspace source for `@earendil-works/pi-tui`.

The checked-in `pi/` directory is the upstream Pi repository as a git submodule, resolved locally as workspace packages. WIDI treats `pi/*` as vendor code and does not modify it.

## Development

```bash
git submodule update --init --recursive
npm install          # install workspace dependencies
npm run build        # build all workspace packages
npm run check        # Biome formatting/linting and TypeScript checks
npm run test         # run workspace tests
```

## Benchmarks

Performance is tracked continuously with [CodSpeed](https://codspeed.io). The benchmarks use [vitest](https://vitest.dev) bench through the `@codspeed/vitest-plugin` and live in `apps/widi-pi/bench`.

Run them locally:

```bash
npm --workspace apps/widi-pi exec -- vitest bench --run
```

On every push to `main` and every pull request, the CodSpeed GitHub Actions workflow runs the benchmarks in CPU simulation mode and reports performance changes.
