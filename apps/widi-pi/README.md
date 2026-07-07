# widi-pi

`widi-pi` is the core of WIDI: a multi-agent runtime built natively on Pi's
`AgentHarness` (`@earendil-works/pi-agent-core`).

Pi's harness is kept as the single-agent execution kernel — model turns, the
session tree, resources, tools, and stream lifecycle. `widi-pi` adds the
runtime around it, with one design rule throughout: multi-agent orchestration
is a first-class, observable, recoverable capability of the runtime, not an
external script or subprocess trick.

## What the core provides

- **Orchestrator** (`src/core/agent-orchestrator.ts`): cross-agent lifecycle,
  harness assembly, input-triggered commands, human request routing, client
  event fanout, and structured diagnostics on one observable main path.
- **Agent profiles** (`src/core/agent-profile.ts`): declarative agent
  configuration (system prompt, tools, skills, prompt templates, extensions)
  with a registry that handles source priority, duplicates, and parse or
  validation diagnostics.
- **Sessions** (`src/core/session-manager.ts`, `src/storage/`): persistent
  JSONL sessions that keep Pi's session tree semantics and can be resumed into
  a fresh harness — including reloading the profile the session was created
  with (see "Session storage" below).
- **Tool registry** (`src/core/tool-registry.ts`, `src/core/tools/`): built-in
  coding tools and agent collaboration tools registered as core tools, with a
  patch pipeline so extensions can rewrap any tool's backend.
- **Extension loader/runner** (`src/core/extension/`): hooks to register and
  patch tools, observe or intercept runtime events, and keep small
  session-local state via Pi custom entries.
- **Runtime composition** (`src/core/runtime-service.ts`): wires settings,
  profiles, resources, model/auth, sessions, tools, extensions, and the
  orchestrator into one runtime.

## Status

Work proceeds in consumer-driven milestones (see
[`docs/TODO.md`](docs/TODO.md)):

- **M1 — command consolidation: done.** Trigger-based command input is an
  orchestrator capability; the separate command runtime experiment was
  retired after review.
- **M2 — boundary convergence and the first real consumer: in progress.**
  Core built-in coding tools (read done; write/edit next) and a minimal
  stdout/CLI adapter that exercises the runtime outside of tests.
- **ME — extension surface** and **M3 — agent collaboration tools** follow.

## Session storage

Persistent sessions are plain Pi JSONL session files. The only difference is
an optional, opaque `metadata` object on the header line, used to store the
context needed to rebuild a harness on resume — currently the agent profile
reference, readable at list time without scanning entries.

Upstream Pi has no extension point for this today, so `src/storage/` carries a
copy of upstream `jsonl-storage.ts`/`jsonl-repo.ts` whose diff is kept minimal
on purpose: it doubles as the proposed upstream change, prototyped on
[`ArcadiaLin/pi#jsonl-header-metadata`](https://github.com/ArcadiaLin/pi/tree/jsonl-header-metadata).
Design notes: [`docs/session-storage.md`](docs/session-storage.md).

## Documentation

Design documents currently live in Chinese under [`docs/`](docs/); the code,
identifiers, and diagnostics are English throughout.

- [`docs/DESIGN.md`](docs/DESIGN.md) — core design boundaries and settled
  decisions (command, coding tools, collaboration).
- [`docs/core/`](docs/core/) — per-mechanism notes: orchestrator, runtime
  lifecycle, extensions, profiles and resources, tools and capabilities,
  diagnostics, sessions.
- [`docs/core/pi-upstream-roadmap.md`](docs/core/pi-upstream-roadmap.md) —
  primitives WIDI deliberately does not fake locally and hopes to see settle
  in Pi upstream (session metadata, ExecutionEnv locking, harness queue
  control).
- [`../../CONTEXT.md`](../../CONTEXT.md) — the glossary that pins down core
  terms (in English).

## Bootstrap

Set up the upstream Pi submodule before installing and testing WIDI:

```bash
git submodule update --init --recursive
npm install
```

Build the local Pi workspace packages before running WIDI tests:

```bash
npm --workspace pi/packages/ai run build
npm --workspace pi/packages/agent run build
npm --workspace pi/packages/tui run build
npm --workspace apps/widi-pi run test
```

Run the monorepo check before committing code changes:

```bash
npm run check
```
