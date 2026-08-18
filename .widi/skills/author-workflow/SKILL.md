---
name: author-workflow
description: Use when writing, debugging or pricing a WIDI workflow - a YAML flow in .widi/workflows run by the `workflow` extension. Covers the four step kinds, the state model, JSON output schemas, the static budget audit, the JSONL journal, and how a flow is run from the TUI or over RPC.
---

# Authoring a WIDI workflow

A flow is a YAML file in `.widi/workflows/`. The `workflow` extension browses that directory, prices every flow it finds, and runs the one you name. Nothing about a flow is compiled into the extension: write the file, run `/workflows`, and it is there.

## 0. What a flow is for, and what it is not for

A flow is an executor with a cost you can read before you run it. The engine owns the control flow - which steps, how many passes, how wide a fan-out, how many at a time - and the model owns nothing but the contents of one JSON answer.

Use a flow when the shape of the work is known and only the content varies: survey a question, grade a batch, extract fields from a pile of documents, run the same three prompts over fifty inputs.

Do not use a flow when the next action depends on what was found. There is no conditional branching and no unbounded loop, deliberately: the moment a workflow language grows arbitrary jumps it stops having a static cost and becomes an agent loop in a worse notation. Work that genuinely needs to decide as it goes is an agent's job.

## 1. Skeleton

```yaml
name: survey                 # what /workflow names; unique across the directory
version: 1
description: One line, shown by /workflows.

budget:                      # the worst case you allow. Checked before the run.
  modelCalls: 20
  agentSpawns: 10
  wallClockMs: 600000

state:                       # every slot a step may read or write
  angles:   { type: list }
  asked:    { type: set }
  brief:    { type: text }

persist:                     # optional; nothing is written unless you ask
  path: runs/survey.jsonl
  records: [run, step, output, result]

steps: [ ... ]               # see below

report:                      # what the finished run shows in the terminal
  summary: state.brief
  items: state.findings
```

Unknown keys are errors, not warnings. In a format nobody type-checks, a silently ignored `maxItem:` is the difference between a bound and no bound at all.

## 2. State is the only channel

Steps do not pass values to each other. Every step reads from and writes to declared state slots, so what a step depends on is visible in the file.

| Type | Holds | Written by |
| --- | --- | --- |
| `list` | anything, in order | `set`, `append`, `take`, `clear`, `move` |
| `set` | membership keys, deduplicated | `append`, `clear`, `move` |
| `text` | one string | `set`, `clear` |

Set membership and `dedupe` compare a normalised form of the value - trimmed, whitespace collapsed, lowercased for strings, JSON for anything else. The original value is what gets stored; the normalised form is only for comparison. That is what makes `against: state.asked` actually catch a model that answered "Token Usage" the second time it said "token usage".

## 3. References

Five, and they are lookups only. There is no arithmetic and no conditions.

| Reference | Available |
| --- | --- |
| `$input` | everywhere - the text the run was started with |
| `$item` | inside a `fanout` body only |
| `$iteration` | the current loop pass, 0 outside a loop |
| `$output.<field>` | in an `agent` step's `assign`, after the answer validates |
| `$state.<slot>` | everywhere |

In a `task:` they are substituted into the text; anything that is not already a string is rendered as JSON, which is also what the model is being asked to answer in. In `assign` they are the value itself.

Write targets are never expressions: `into:`, `over:`, `against:`, `take:`, `move:` and `until.empty` all name a slot as `state.<key>` with no `$`.

## 4. The four step kinds

### `agent` - the only kind that costs a model call

```yaml
- id: plan
  kind: agent
  maxAttempts: 2               # a retry is a model call; the budget prices it
  role:
    label: Survey Planner
    systemPrompt: You split a question into distinct angles of enquiry.
    model: vllm/qwen3.6-35b-a3b   # optional; the host agent's model when absent
    tools: []                     # see below before adding any
  task: |
    Question: $input
    Name up to 4 angles worth investigating.
  output:                      # required, and must be an object schema
    type: object
    required: [angles]
    properties:
      angles:
        type: array
        maxItems: 4
        items: { type: string, maxLength: 120 }
  assign:
    - { into: state.angles, set: $output.angles, dedupe: true, limit: 4 }
```

The engine spawns a throwaway agent on that role, appends the schema to its system prompt, prompts it once, parses one JSON object out of the reply, checks it against the schema, applies `assign`, and disposes the agent. Nothing survives the step except what `assign` wrote.

A failed parse or a schema violation is handed back to the same agent as the next attempt's instruction, so it can see what it got wrong. After `maxAttempts` the step fails and the run fails with it.

### `fanout` - run a body over a list

```yaml
- id: probe
  kind: fanout
  over: state.angles
  maxItems: 4                  # the list is truncated to this
  maxConcurrency: 2            # how many run at once
  body: [ ... ]                # $item is the current entry
```

`maxItems` is a truncation, not an assertion: a flow whose state grew past its own bound overruns nothing.

### `loop` - bounded repetition

```yaml
- id: rounds
  kind: loop
  maxIterations: 2
  until: { empty: state.angles }   # optional early exit
  body: [ ... ]
```

`until` is the only predicate, and it can only shorten a run.

### `transform` - free, in process

```yaml
- id: promote
  kind: transform
  ops:
    - { clear: state.angles }
    - { move: state.proposed, into: state.angles, against: state.asked, dedupe: true, limit: 4 }
    - { take: state.findings, count: 6 }
```

Three operations: `take` (truncate a list), `clear`, `move` (drain one slot into another, clearing the source). `move` and `append` share the modifiers `dedupe`, `against` and `limit`.

Use `take` before a step that reads a growing list. Bounding what the last model call is allowed to see is a flow's job; nothing else will do it.

## 5. Assignment

Each entry in `assign` names one target and exactly one operation.

```yaml
- { into: state.brief,    set: $output.brief }
- { into: state.findings, append: { angle: $item, answer: $output.answer } }
- { into: state.asked,    append: $item }
- { into: state.proposed, append: $output.next, when: present }
```

- `set` replaces; `append` adds one entry.
- An object literal builds a value field by field, each value a reference or a literal.
- `when: present` skips the assignment when the value is missing or empty. Use it for every optional schema field, or the slot fills with empty strings.
- `dedupe: true`, `against: state.<set>` and `limit: <n>` all decline the write rather than failing it.

## 6. The budget, and what gets refused

`/workflows` prints the worst case the audit computes: every attempt used, every fan-out full, every loop to its last pass.

```text
model calls  = sum over agent steps of (enclosing fan-out and loop bounds) x maxAttempts
agent spawns = sum over agent steps of (enclosing fan-out and loop bounds)
```

Retries multiply model calls but not spawns - a retry re-prompts the same agent, which is also why it can see its own mistake.

A flow is refused before a single agent is spawned when any of these hold:

- the worst case exceeds `budget.modelCalls` or `budget.agentSpawns`
- two steps share an `id`
- a step names a state slot that is not declared, or of the wrong type
- `$item` is read outside a fan-out
- `assign` reads `$output.x` where `x` is not in that step's schema
- a role declares `tools` but no `maxModelCalls` (a tool loop's length is not derivable, so it has to be declared)
- an `array` schema omits `maxItems`

`wallClockMs` is the one bound that cannot be checked against the declaration, so the engine enforces it as a deadline: when it expires, the agent currently mid-call is disposed and the run reports `cancelled`.

## 7. Persistence

```yaml
persist:
  path: runs/survey.jsonl      # relative paths resolve against the flow's own file
  records: [run, step, output, result]
```

One JSON object per line, appended as the run goes. `output` records the validated answer of every agent step - that is the record worth keeping, because it is the dataset the run produced.

This is deliberately not the agent session. A session entry replays into the model's context on every resume and forks into every child session; a run's records want none of that. They want to be appended once and read by whatever consumes them.

Writing needs project trust, the same bar as `exec`. Without it the run still happens and nothing is written.

## 8. Running one

```bash
/workflows                       # what is installed, what it costs, what is broken
/workflow survey <question>      # run it on the current agent
/workflow-stop                   # stop the run on the current agent
```

`/workflow` with a name but no input - or with no argument at all - opens the launcher instead of failing: a catalog screen, then a screen that shows the flow's description, its worst case and its file while you type the input. A flow the audit refused stops there and lists every problem, so nothing is spawned to find out. Whatever you had already typed follows you between the screens.

Over RPC, the same two events with no terminal involved:

```json
{"cmd":"emit_extension_event","agentId":"<id>","extensionId":"workflow","name":"workflow:run",
 "payload":{"workflow":"survey","input":"<question>"}}
```

While a run is going, the terminal shows the flow itself above the editor: every step of the outline, the active branch expanded down to the fan-out item each agent is working on, what each state slot holds, and what has been spent against the budget. It appears when a run starts and collapses to one line when it ends. `alt+w` folds it to a single line and back.

Progress arrives as `extension_event` frames: `workflow:started`, `workflow:step` (twice per step), `workflow:finished`. `workflow:list` answers `workflow:catalog` with the same audit `/workflows` prints, so a driver never has to reimplement the parser to know what a flow costs.

The catalog is re-read from disk on every request. Edit the YAML and run it again; there is nothing to reload.

## 9. Where it goes wrong

- **The model answers prose.** Raise `maxAttempts` to 2 before blaming the model - the retry carries the parse error back to it and usually lands. If it still fails, the schema is probably too large; split the step.
- **A slot fills with empty strings.** An optional schema field assigned without `when: present`.
- **The second loop pass repeats the first.** `move` appends; it does not replace. Put `{ clear: <target> }` before it.
- **The last step's prompt is enormous.** Nothing truncates a list for you. `take` before you read it.
- **The audit refuses a flow you think is cheap.** Read the worst case, not the expected case. Two attempts on a step inside a 4-wide fan-out inside a 2-pass loop is sixteen model calls.
- **`$item` in a task outside a fan-out** is caught by the audit, not at runtime, and the message says which step.

## 10. Before handing one over

- [ ] `/workflows` shows it with a worst case and no problems
- [ ] Every optional schema field's assignment carries `when: present`
- [ ] Every list read by a later step is bounded by `take` or by a fan-out's `maxItems`
- [ ] `budget` is the worst case you are actually willing to spend, not the expected one
- [ ] It ran once end to end, and the journal (if declared) has the lines you expected
