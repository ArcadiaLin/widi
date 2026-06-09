# Development Rules

## Repository Context

`widi` is an npm workspace monorepo derived from `pi`.

Workspace packages:

- `apps/widi-pi`: WIDI terminal coding harness. This is the active product code.
- `pi/packages/ai`: local workspace source for `@earendil-works/pi-ai`.
- `pi/packages/agent`: local workspace source for `@earendil-works/pi-agent-core`.
- `pi/packages/tui`: local workspace source for `@earendil-works/pi-tui`.

The checked-in `pi/` directory is a full upstream repository kept in-tree so WIDI can track upstream changes while resolving the Pi packages locally during root type checks.

## Current Focus

- Default all runtime design and implementation work to `apps/widi-pi`.
- Treat `pi/*` as upstream/vendor code. Do not modify it unless the user explicitly asks.
- When inspecting Pi behavior, read `pi/packages/*` as reference code only.

## Project Shape

- Root package: private ESM package named `widi`.
- Node engine: `>=22.19.0`.
- Root TypeScript config maps `@earendil-works/pi-*` imports to `pi/packages/*/src`.
- Root check includes `pi/packages/{ai,agent,tui}` and `apps/widi-pi`.
- `apps/widi-pi` builds from `src` to `dist` with `tsgo`.
- `apps/widi-pi` exposes the `widi-harness` binary from `dist/cli.js`.

## Dependencies

`apps/widi-pi` depends on:

- Pi packages: `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`.
- Model/runtime packages: `openai`, `@anthropic-ai/sandbox-runtime`.
- Config/schema utilities: `dotenv`, `smol-toml`, `typebox`.
- Test tooling: `vitest`.

Before using an external API, check installed package types or source in `node_modules`; do not guess.

## Conversational Style

- Keep answers short and direct.
- Use technical prose. Avoid fluff.
- No emojis in commits, issues, PR comments, docs, or code.
- Answer user questions first before running commands or making edits.
- When responding to user feedback or analysis, explicitly say whether you agree or disagree before describing changes.

## Code Quality

- Read files in full before broad changes, before editing files not yet inspected, and when investigating or auditing.
- Do not rely on search snippets for broad changes.
- Write Human-readable code.
- Avoid `any` unless there is no practical typed alternative.
- Inline single-use, single-line helpers.
- Use top-level imports only. Do not use `await import()`, `import("pkg").Type`, or dynamic type imports.
- Never remove or downgrade code to hide type errors from outdated dependencies; upgrade the dependency instead.
- Use only erasable TypeScript syntax in code covered by the root config: no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or constructs that require JS emit.
- Use explicit fields plus constructor assignments instead of parameter properties.
- Ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks such as `matchesKey(keyData, "ctrl+x")`; add defaults to configurable keybinding maps instead.

## Commands

After code changes, run from the repository root:

```bash
npm run check
```

`npm run check` runs Biome formatting/linting and TypeScript checking for the monorepo. Documentation-only changes do not require checks unless the user asks.

Useful package commands:

```bash
npm --workspace apps/widi-pi run build
npm --workspace apps/widi-pi run check
npm --workspace apps/widi-pi run test
```

Run package tests only when relevant or requested. Do not run long-lived dev servers unless the user asks. Never commit unless the user asks.

## Git Rules

- Never use destructive commands such as `git reset --hard`, `git checkout .`, or `git clean -fd` unless the user explicitly asks.
- Do not use `git add -A` or `git add .` when committing. Stage only files intentionally changed.
- Before staging or committing, run `git status` and verify unrelated changes are not included.
- Leave unrelated local changes alone.
- If a conflict appears in a file you did not touch, stop and ask the user.

## User Override

If the user asks for something that conflicts with these rules, explain the conflict and ask for confirmation before proceeding.
