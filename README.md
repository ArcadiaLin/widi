# widi

[![CodSpeed](https://img.shields.io/endpoint?url=https://codspeed.io/badge.json)](https://app.codspeed.io/ArcadiaLin/widi?utm_source=badge)

`widi` is an npm workspace monorepo derived from `pi`. The active product code
lives in `apps/widi-pi`, the WIDI terminal coding harness built on
`pi-agent-core`.

## Workspace layout

- `apps/widi-pi`: WIDI terminal coding harness (active product code).
- `pi/packages/ai`: local workspace source for `@earendil-works/pi-ai`.
- `pi/packages/agent`: local workspace source for `@earendil-works/pi-agent-core`.
- `pi/packages/tui`: local workspace source for `@earendil-works/pi-tui`.

The checked-in `pi/` directory is an upstream submodule kept in-tree so WIDI can
track upstream changes while resolving the Pi packages locally.

## Development

```bash
npm install          # install workspace dependencies
npm run build        # build all workspace packages
npm run check        # Biome formatting/linting and TypeScript checks
npm run test         # run workspace tests
```

## Benchmarks

Performance is tracked continuously with [CodSpeed](https://codspeed.io). The
benchmarks use [vitest](https://vitest.dev) bench through the
`@codspeed/vitest-plugin` and live in `apps/widi-pi/bench`.

Run them locally:

```bash
npm --workspace apps/widi-pi exec -- vitest bench --run
```

On every push to `main` and every pull request, the CodSpeed GitHub Actions
workflow runs the benchmarks in CPU simulation mode and reports performance
changes.
