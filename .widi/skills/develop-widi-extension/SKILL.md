---
name: develop-widi-extension
description: Use when developing, modifying or debugging a WIDI extension - registering tools, providers, profiles, interceptors and observers, slash commands, shortcuts, TUI components, divisions, or the dual-entry core/TUI split. Gives the scaffold, the API boundary, a worked tool example, the verification loop and the traps.
---

# Developing a WIDI extension

A WIDI extension speaks WIDI's own runtime protocol, **not** the Pi coding-agent `ExtensionAPI`. Any `pi.registerTool()` / `pi.on()` shaped code is wrong here, however familiar it looks.

## 0. Read before writing

In order. Do not write API calls from memory:

1. `apps/widi/docs/extensions.md` - the authoritative contract. This skill does not restate it; it gives the workflow and the failure modes.
2. `apps/widi/src/core/extension/api.ts` - the author-facing core exports. Use nothing outside them.
3. `apps/widi/src/core/extension/types.ts` - full signatures: `ExtensionActivationApi`, `ExtensionContext`, `ExtensionActions`, the observed-event and interceptor names.
4. `apps/widi/src/tui/extension-host/types.ts` - `WidiTuiExtensionApi`.
5. `.widi/extensions/drill/` - the repository's dual-entry reference implementation and the behavioural baseline.

Depend only on `core/extension/api.ts` and the TUI host types. Never import orchestrator, loader or runner internals, and never hold on to an internal object.

## 1. Decide the shape first

| What you need | Which half |
| --- | --- |
| Tools, model providers, profiles, system prompt, interceptors, observers, session state | Core half (default export, activated once per agent) |
| Slash commands, shortcuts, widgets/layout, tool and message renderers, theme, editor text | TUI half (named `tui` export, activated once per application) |
| Both | Dual entry, talking over the extension event bus |

If only one half is needed, ship only that half. Do not add an empty counterpart for symmetry.

## 2. Scaffold

```text
.widi/extensions/<id>/
├── index.ts        # the two exports, no logic
├── protocol.ts     # dual entry only: event names and JSON payload types
├── core/           # core half
├── tui/            # TUI half
└── tsconfig.json
```

The extension id is the directory name. Entry resolution: the first entry of `widi.extensions` in `package.json`, else `index.ts` / `index.js` / `index.mjs` / `index.cjs`. Entries load through jiti, so TypeScript needs no precompilation.

`index.ts`:

```ts
import { EXTENSION_API_VERSION, type ExtensionDefinition } from "../../../apps/widi/src/core/extension/api.ts";
import type { TuiExtensionModule } from "../../../apps/widi/src/tui/extension-host/index.ts";
import { activateCore } from "./core/index.ts";
import { activateTui } from "./tui/index.ts";

const extension: ExtensionDefinition = {
	apiVersion: EXTENSION_API_VERSION,
	divisions: [{ id: "feature", label: "Optional feature" }],
	activate: async (api) => await activateCore(api),
};

export const tui: TuiExtensionModule = { apiVersion: 1, activate: (api) => activateTui(api) };

export default extension;
```

The import depth above holds for `.widi/extensions/<id>/` only; adjust it for any other location.

Copy `tsconfig.json` from `.widi/extensions/drill/tsconfig.json` and fix the relative `extends` and `paths` for the directory depth. The app's own `npm run check` does not cover runtime-loaded extensions, so this file is what type-checks them.

Enable it in `.widi/settings.json`:

```json
{ "enabledExtensions": ["drill", "<id>"] }
```

Omitting the key loads every discovered extension; an empty array loads none. Project-local extensions load only after the project is trusted.

## 3. Core half

`activate(api)` is the **declaration phase**, not an operating context for the current agent. Register here; act in handlers. Available: `registerTool`, `patchTool`, `registerProvider`, `registerProfile`, `appendSystemPrompt`, `observe`, `intercept`, `onExtensionEvent`, `onDispose`, `division`.

### A worked tool

`name`, `label`, `description`, `parameters` and `execute` are required. `execute(toolCallId, params, context)` returns `{ content, details }`; `context` carries `signal`, `workspace.cwd`, `onUpdate`, `extension` and `human`.

```ts
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Type } from "typebox";
import { EXTENSION_API_VERSION, type ExtensionDefinition } from "../../../apps/widi/src/core/extension/api.ts";

const MAX_OUTPUT_CHARS = 8_000;
const DEFAULT_LINES = 40;

interface FileHeadDetails {
	readonly path: string;
	readonly linesReturned: number;
	readonly truncated: boolean;
}

const extension: ExtensionDefinition = {
	apiVersion: EXTENSION_API_VERSION,
	activate: (api) => {
		api.registerTool({
			name: "file_head",
			label: "File Head",
			description: "Read the first lines of a text file in the workspace.",
			parameters: Type.Object({
				path: Type.String({ description: "File path, relative to the workspace root." }),
				lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
			}),
			async execute(_toolCallId, params, context) {
				context.signal?.throwIfAborted();

				// cwd belongs to the agent whose turn is running, so it is read at
				// execution time and never captured at registration.
				const target = isAbsolute(params.path) ? params.path : resolve(context.workspace.cwd, params.path);
				const raw = await readFile(target, "utf8");

				const selected = raw.split("\n").slice(0, params.lines ?? DEFAULT_LINES);
				const joined = selected.join("\n");
				const truncated = joined.length > MAX_OUTPUT_CHARS;
				const text = truncated ? `${joined.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]` : joined;

				const details: FileHeadDetails = { path: target, linesReturned: selected.length, truncated };
				return { content: [{ type: "text", text }], details };
			},
		});
	},
};

export default extension;
```

What the example is demonstrating, and what a reviewer will check for:

- A failed read `throw`s. Never model an error as a successful return value.
- Output is bounded by the tool itself. Nothing unbounded may reach the model context.
- The abort signal is honoured before doing work.
- Paths resolve against `context.workspace.cwd`, not `process.cwd()`.
- `details` is structured for logs and for a TUI `registerToolPresenter()`; it never has to duplicate the model-facing text.

To change an existing tool instead of adding one, use `patchTool(name, { description, parameters, strict, execute, aroundExecute })` - `aroundExecute` wraps the current implementation, which is the right hook for auditing, confirmation or sandboxing.

### Acting at runtime

Runtime operations go through the `ExtensionContext` handed to observers, interceptors and bus handlers: `context.actions` (agent tree, tools, model, `requestHuman`, `abort` / `waitForIdle` / `compact`, `exec`, `emitOutput` / `notify` / `setStatus` / `publishMessage`) and `context.session`.

The four ways to send text differ, and picking the wrong one is a bug: `prompt` (target must be idle, refuses when busy), `steer` (into the current run), `followUp` (after the current task), `precede` (written to the branch for the next turn, does not wake the agent). All four pass through the `input` interceptor again.

`context.session.appendEntry()` writes to the session branch: it replays into context on every resume, forks into every child session, and cannot be removed. Use it only for state that must survive resume, fork or audit. Ordinary caches stay in memory.

## 4. TUI half

Commands use the TUI `CommandDefinition` and must declare `kind` (`"action"` or `"prompt"`), `agentPolicy` (`runtime` / `materialize` / `active` / `pending`), `name`, `description`, plus `execute` (action) or `expand` (prompt):

```ts
api.registerCommand({
	kind: "action",
	agentPolicy: "active",
	name: "my-status",
	description: "Show extension status.",
	execute: async () => "ready",
});
```

`registerShortcut` takes a binding id, not a key sequence: the real action id is `ext.<extensionId>.<bindingId>` and users override it in `keybindings.json`. Never hardcode a key comparison in a handler.

The TUI half is bound to no agent. To drive the visible agent, use a capability or emit a bus event and let the core runtime act. `stage(text)` only parks text in the editor - the user may rewrite or drop it; it guarantees neither a session write nor that the model ever reads it. Components and renderers must tolerate failure; the host isolates their errors and keeps a diagnostic.

## 5. Dual-entry communication

Name events `owner:event`, payloads must be JSON values and are copied and frozen. The bus broadcasts to every live core runtime and every TUI subscriber, **including the sender**, so handlers usually filter on `event.sourceAgentId` or an explicit source field first. Cascade depth is limited: never design two handlers that answer each other unconditionally. Keep event names and payload types in `protocol.ts`.

`core/` and `tui/` never import each other. The first cross import is a bug, not a shortcut.

## 6. Where it goes wrong

- Never `await waitForIdle()` inside a `tool_call` or `context` interceptor: the turn cannot proceed until that handler returns, so it deadlocks.
- The `input` interceptor also sees messages injected by agents, the runtime and extensions. A policy meant for humans must check `event.source`.
- `input` and `tool_call` handlers fail closed - a thrown error blocks. Other hooks record a diagnostic and continue.
- Observed events have no ordering guarantee; a status event can arrive before `agent_spawned`. Handlers must tolerate it.
- Tools may run in parallel. A read-modify-write tool must handle concurrent calls on the same file.
- While an agent is running, `appendEntry()` and `publishMessage()` may be buffered and the returned entry id may be `undefined`. Do not treat a synchronous id as a protocol guarantee.
- `registerProvider` is first-registration-wins and cannot override a built-in; `registerProfile` is shadowed by a user profile with the same id.
- A division must appear in `divisions` to be a user-facing switch, and disabling an ancestor hard-disables its children.
- `onDispose` must release every timer, watcher and connection the extension opened. After dispose or reload, previously captured `context`, `actions` and `session` are dead.

## 7. Verify

```bash
npx tsgo --noEmit -p .widi/extensions/<id>/tsconfig.json
npx biome check .widi/extensions/<id>
npm run tui        # after core-half edits, type /reload; TUI-half edits need an app restart
```

Triage order: is the id in `enabledExtensions` and is the project trusted -> startup or `/reload` diagnostics (`extension.load_failed`, `extension.version_incompatible`, `extension.activation_failed`) -> is the division switched off (`/division <id>/<division>`) -> restart for TUI-half problems -> compare against `.widi/extensions/drill/`.

## 8. Before handing it over

- [ ] Imports stay within `core/extension/api.ts` and the TUI host types
- [ ] No cross import between `core/` and `tui/`; shared material is pure data
- [ ] `apiVersion` uses `EXTENSION_API_VERSION`, and every declared division actually registers something
- [ ] Every long-lived resource is released in `onDispose`
- [ ] Tools throw on failure and bound their own output
- [ ] No gratuitous session-branch writes; where one exists, tell the user what it writes and why the branch is the right place
- [ ] tsgo and biome pass, and the extension was exercised once under `npm run tui`
