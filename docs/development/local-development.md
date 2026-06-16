# Local development

This page covers working in the frites repository itself: prerequisites, the root scripts, and the build order. For the monorepo layout, see [repository-structure.md](repository-structure.md).

## Prerequisites

- **Node.js >= 22** (`engines.node` in the root `package.json`).
- **pnpm 10.24.0** — the repo pins `packageManager: "pnpm@10.24.0"`, so use Corepack or install that version.

Install dependencies from the repo root:

```bash
pnpm install
```

Only `esbuild` is allowed to run a postinstall build (`pnpm.onlyBuiltDependencies`), keeping installs deterministic.

## Root scripts

All scripts are defined in the root `package.json` and run from the repo root.

| Script | Command | What it does |
|---|---|---|
| `build` | `pnpm build` | Builds the publishable packages in dependency order (see below). |
| `clean` | `pnpm clean` | Removes every `dist/` and `*.tsbuildinfo` under `apps/*` and `packages/*`. |
| `prepack` | runs `pnpm build` | Lifecycle hook so a publish always ships fresh `dist/`. |
| `typecheck` | `pnpm typecheck` | `tsc --noEmit` across the whole workspace (no emit; see [testing.md](testing.md)). |
| `test` | `pnpm test` | `vitest run` — the unit suite. See [testing.md](testing.md). |
| `test:watch` | `pnpm test:watch` | `vitest` in watch mode. |
| `gateway` | `pnpm gateway` | Runs the gateway from source via `tsx apps/gateway/src/index.ts`. |
| `mcp` | `pnpm mcp` | Runs the MCP server from source via `tsx apps/mcp/src/index.ts`. |
| `frites` | `pnpm frites` | Runs the CLI from source via `tsx apps/cli/src/index.ts`. |
| `eval` | `pnpm eval` | Runs the value-gate harness (`tsx eval/value-gate.ts`). See [evaluation.md](evaluation.md). |
| `bench` | `pnpm bench` | Runs the bench-matrix harness (`tsx eval/bench-matrix.ts`). See [evaluation.md](evaluation.md). |

The `gateway`, `mcp`, `frites`, `eval`, and `bench` scripts all run TypeScript directly with [`tsx`](https://github.com/privatenumber/tsx) — no build step is required to run a surface locally.

## Build order

`pnpm build` compiles only the five publishable packages, and it does so in a fixed order so each package's dependencies are built before it:

```
core → agents → isolation → gateway → cli
```

```json
"build": "pnpm --filter @frites/core build && pnpm --filter @frites/agents build && pnpm --filter @frites/isolation build && pnpm --filter @frites/gateway build && pnpm --filter @frites/cli build"
```

Each package's own `build` script is `tsc -p tsconfig.build.json`, which emits `dist/` (declarations + source maps) from `src/`.

`@frites/mcp` is **not** in the build chain: it is private and runs straight from TypeScript via `tsx` (the `mcp` script), so it has no `dist/`. See [release-and-packaging.md](release-and-packaging.md) for the full publish/build distinction.

## Config files used in development

| File | Purpose |
|---|---|
| `pnpm-workspace.yaml` | Declares the `apps/*` and `packages/*` workspace globs. |
| `tsconfig.json` | Root TS config (`noEmit`, strict, ES2023/ESNext, Bundler resolution) plus `paths` aliases for `@frites/core`, `@frites/isolation`, `@frites/agents`. Used by `pnpm typecheck`. |
| `<pkg>/tsconfig.build.json` | Per-package build config extending the root; flips `noEmit` off, emits declarations + source maps into `dist/`, and excludes `test/`. |
| `vitest.config.ts` | Test runner config: Node environment, include globs for `packages/*/test` + `apps/*/test`, and the same `@frites/*` source aliases. |

The `@frites/*` path aliases in both `tsconfig.json` and `vitest.config.ts` point at each package's `src/index.ts`, so typecheck and tests resolve workspace packages from source — you do not need to build before running `pnpm typecheck` or `pnpm test`.

## Runtime configuration

frites itself reads `.frites/config.json` in the repo, layered over `~/.frites/config.json` (global). That is application configuration, not build tooling — manage it with `frites config` and see [reference/configuration.md](../reference/configuration.md).
