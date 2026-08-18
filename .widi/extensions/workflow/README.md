# workflow

An executor whose cost can be read off its declaration, and the repository's worked example of driving an extension from outside the terminal.

A workflow is not a better-organised agent. The engine owns the control flow - which steps, how many passes, how wide a fan-out, how many at a time - and the model supplies nothing but the text of one step's answer. That is what makes a run's worst case a number this extension can print *before* it spends anything, which an agent loop can never do.

## Running it

```bash
npm run tui        # then: /workflow what makes a workflow cheaper than an agent?
```

`/workflow-stop` ends a run wherever it has got to. Enable it in `.widi/settings.json`:

```json
{ "enabledExtensions": ["drill", "workflow"] }
```

Type-checking is separate from the app's, because the extension is loaded at runtime rather than built with it:

```bash
npx tsgo --noEmit -p .widi/extensions/workflow/tsconfig.json
npx biome check --write .widi/extensions/workflow
```

## The language

Four step kinds, and a declared bound on every one that costs anything.

| Step | What it does | What it must declare |
| --- | --- | --- |
| `agent` | spawn a role, prompt it once, take the answer, dispose it | `maxModelCalls`, but only if the role takes tools |
| `fanout` | run a body over a list of items | `maxItems`, `maxConcurrency` |
| `loop` | repeat a body | `maxIterations` |
| `transform` | edit state in process; no model, no shell, no cost | nothing |

There is no goto and no unbounded loop, and there will not be one. The moment a workflow language grows arbitrary jumps it stops having a static cost and becomes an agent loop written in a worse notation - a road GitHub Actions, Argo and early Airflow have all been down. Work that genuinely needs unbounded control flow is an agent's job; keeping the two forms distinguishable is the point.

Bounds are declarations; the plumbing between steps is TypeScript closures rather than an expression language. That keeps the part the budget depends on - the numbers - readable without a parser, and leaves `$steps.x.y` to be invented if a second workflow ever needs to be authored by someone who is not editing this directory.

## The budget

`plan/budget.ts` walks the declaration and multiplies the bounds out: every fan-out full, every loop to its last pass. For the shipped `survey` workflow that is `1 plan + 2 rounds x 4 probes + 1 brief`, so:

```text
worst case  10 model calls, 10 agent spawns
declared    10 model calls, 10 agent spawns, 600000 ms
```

Raise `MAX_ANGLES` to 5 and the worst case becomes 12, the check fails, and the run is **refused before a single agent is spawned**. That is the whole discipline: a budget discovered halfway through a run is not a budget.

Two other things fall out of the same audit, both refusals rather than warnings: a step id used twice, and a role given tools without declaring `maxModelCalls`. A tool-free run is exactly one model call, which is what makes the arithmetic above a fact; the length of a tool loop is not derivable, so it has to be declared.

The one bound that cannot be checked against the declaration is `wallClockMs`, so the engine enforces it the only way it can - as a deadline that aborts the run. Cancellation reaches inside a model call by disposing the agent making it, because nothing else out here can interrupt one.

## survey

The one workflow shipped, and the same shape as the PaSa pipeline the design was drawn from: plan, fan out, expand for a bounded number of rounds, synthesise. The external search is replaced by what the model already knows, so a run needs no API key, no network, and can be repeated for free against a local model.

Each probe ends its answer with `NEXT: <angle>`, which is how the second round gets its work - the model proposes expansions as part of answering, exactly as PaSa's crawler does, and a `transform` step deduplicates them against what has already been asked. The `trim` step before the final brief bounds what that last model call is allowed to see. A workflow bounds its own context or nothing does.

## Driving it from outside

The two inbound events are the entire trigger surface, and the TUI half has no privileged access to them. An RPC client sends the same thing:

```json
{"cmd":"emit_extension_event","agentId":"widi-dev-q485","extensionId":"workflow","name":"workflow:run",
 "payload":{"workflow":"survey","input":"what makes a workflow cheaper than an agent?"}}
```

and reads progress off the `extension_event` frames it gets back (`workflow:started`, `workflow:step`, `workflow:finished`). A benchmark driver therefore needs no terminal and no engine of its own. `protocol.ts` is the whole contract; every payload has a reader beside it that answers `undefined` for a shape it cannot use, because a malformed envelope means the other end is a different build.

Attribution is the addressing. There is one core runtime per agent and they all hear the same bus, so each one starts by asking whether `sourceAgentId` is its own agent - the TUI half's events carry the visible agent, an RPC client names an agent outright, and exactly one runtime matches either way.

## What a run leaves behind

Two published messages - the brief, and the step ledger it was counted from - plus a footer status while it runs. Nothing is written to the session branch. Intermediate workflow state has no business replaying into a model's context on every resume and forking into every child session, and the ledger is counted rather than written down, so it cannot flatter the run it describes.

The engine reads `prompt`'s `PromptOutcome` for tokens and cost, which is exact for the runs it started itself. It does not try to account for a child that spends on its own behalf; that is a cross-agent ledger, and there is no primitive for it yet.

## How an agent step works

```text
spawnAgent(profileOverride)     the role is built here, not chosen: a shipped
                                workflow cannot know what profiles the machine
                                it lands on happens to have. `persist: false` is
                                required, not preferred - a role assembled in
                                code is not one the runtime could resolve again,
                                so its session could never be resumed

prompt(task, { target })        waits for the child's own run, and returns the
                                message it ended on, with usage on it

waitForTreeIdle(childId)        a role carrying tools may have delegated, and
                                its subagents are still running when its own
                                turn ends

readReport(childId)             only then, and only if the subtree grew: the
                                child's own later turns are what its report
                                holds by that point

disposeAgent(childId)           last, always: a disposed agent has no session
                                left to read
```

The demo's roles carry no tools, so `waitForTreeIdle` always settles on the child alone and `readReport` never fires. The order is still the correct one, and it is the order a workflow with tool-using roles depends on.

## Layout

```
protocol.ts   what crosses the bus, and nothing else
plan/         the language, the budget check, and the one workflow shipped
core/         the half inside an agent: the trigger and the engine
tui/          the half in the terminal: two commands and a wait
```

`core/` and `tui/` never import each other; treat a first import across that line as a bug. Both read `plan/` and `protocol.ts`, which is only possible because those two import no runtime API at all.

The engine lives in the core half because it has to: an extension cannot call a model directly, only spawn an agent and prompt it, and both need an agent to be bound to. The trigger handler does not await the run - bus dispatch is sequential, so a handler that ran a workflow to the end would hold the emitter and every subscriber behind it for the length of it.

## Not here

- **A registry.** One workflow is named, not looked up. The second one is what justifies a table, and pre-building the general engine before it exists is how a demo becomes a framework nobody asked for.
- **`call` and `exec` steps.** The design has both - a `call` for a side-effecting function such as an HTTP search, an `exec` for a shell escape hatch - and this demo has neither behind it. A switch with no wire is worth less than an honest gap; they arrive with a workflow that needs them.
- **YAML.** The plan sketched one, and this is what it would parse into. The numbers the budget depends on are declarations either way.
