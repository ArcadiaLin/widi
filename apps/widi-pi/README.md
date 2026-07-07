# widi-pi

`widi-pi` is the WIDI terminal coding harness built on `pi-agent-core`.

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
