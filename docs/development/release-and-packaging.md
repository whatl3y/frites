# Release & packaging

frites is published as a small set of npm packages under the `@frites/*` scope. This page describes which packages are published, how they are built, and the upgrade flow for installed users. Every claim here is grounded in the package `package.json` files; for the build order itself, see [local-development.md](local-development.md).

## Publishable packages

Five packages are publishable. Each one declares `"publishConfig": { "access": "public" }`, ships only its `dist/` directory (`"files": ["dist"]`), and builds with `tsc -p tsconfig.build.json`:

| Package | `bin` | Role |
|---|---|---|
| `@frites/cli` | `frites` | Terminal entry point. The package users install globally. |
| `@frites/gateway` | `frites-gateway` | Transparent model-provider proxy. |
| `@frites/core` | — | Shared engine, config, and types. |
| `@frites/agents` | — | Agent runner adapters and completion helpers. |
| `@frites/isolation` | — | Git worktree isolation helpers. |

Each package exposes its built entry via `"main": "./dist/index.js"`, `"types": "./dist/index.d.ts"`, and `"exports": { ".": "./dist/index.js" }`. Because `files` is restricted to `dist`, the published tarballs contain compiled JavaScript and `.d.ts` declarations only, never `src/` or `test/`.

Inter-package dependencies use `workspace:*` (e.g. `@frites/cli` depends on `@frites/agents`, `@frites/core`, `@frites/gateway`, `@frites/isolation`); pnpm rewrites these to real versions at publish time.

## Build artifacts

Building is the prerequisite for publishing. The root `prepack` script runs `pnpm build`, which compiles the five packages in dependency order (`core → agents → isolation → gateway → cli`). Each package's `tsconfig.build.json` flips `noEmit` off and emits declarations + source maps from `src/` into `dist/`, exactly the directory listed in `files`.

## The MCP server is not published

`@frites/mcp` is the exception. Its `package.json` sets `"private": true`, has **no** `publishConfig`, no `files`, and no `build` script. Its `main` and `bin` point at TypeScript source (`./src/index.ts`), and it runs via `tsx` (the root `pnpm mcp` script) rather than from a compiled `dist/`. So it is not built into `dist/` and is not published to npm. It is registered to run from the repo checkout (see [services/mcp-server.md](../services/mcp-server.md)).

## Installing

Users install the CLI package globally, which provides the `frites` binary:

```bash
npm install -g @frites/cli
```

The CLI depends on `@frites/gateway`, `@frites/core`, `@frites/agents`, and `@frites/isolation`, so installing it pulls in the gateway and the engine. From there, `frites install` sets up the always-on gateway service. See [getting-started/installation.md](../getting-started/installation.md).

## Upgrade flow

After upgrading the package (`npm install -g @frites/cli` again), restart the running gateway service so it picks up the new build:

```bash
frites restart
```

`frites restart` is the same command used after config changes. It restarts the background gateway service so the upgraded code (or new configuration) takes effect. See [getting-started/service-management.md](../getting-started/service-management.md).
