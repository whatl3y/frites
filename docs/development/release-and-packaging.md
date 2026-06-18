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

Each publishable package declares `"license": "Apache-2.0"` and carries its own `LICENSE` file so the npm tarball includes the full Apache License 2.0 text. The repository root also has the canonical `LICENSE` file for the source tree.

Inter-package dependencies use `workspace:*` (e.g. `@frites/cli` depends on `@frites/agents`, `@frites/core`, `@frites/gateway`, `@frites/isolation`); `pnpm pack` rewrites these to the exact current version inside each tarball when a release is built (see [Cutting a release](#cutting-a-release)).

## Build artifacts

Building is the prerequisite for publishing. The root `prepack` script runs `pnpm build`, which compiles the five packages in dependency order (`core → agents → isolation → gateway → cli`). Each package's `tsconfig.build.json` flips `noEmit` off and emits declarations + source maps from `src/` into `dist/`, exactly the directory listed in `files`.

## Versioning

All five publishable packages use **fixed (lockstep) versioning** — they always share one version number and are released together. This is enforced by the `fixed` group in `.changeset/config.json`. Lockstep matters because `@frites/cli` depends on the other four at runtime: a user who runs `npm install -g @frites/cli` must receive a mutually compatible set, and `workspace:*` is rewritten to the exact current version at publish time.

`@frites/mcp` and the repo root are `private: true` and are never versioned or published; `@frites/mcp` is additionally listed under `ignore` in the Changesets config.

Versioning and publishing are managed with [Changesets](https://github.com/changesets/changesets). npm versions are immutable — an existing version can never be republished — so every release needs a fresh version bump, which is exactly what the flow below produces.

## Cutting a release

There are two paths; both end with all five packages published to npm at the same version.

### How packages reach npm

Publishing is done by [`scripts/publish.mjs`](../../scripts/publish.mjs) (the root `release` script), not `changeset publish`. For each public package, in dependency order, it:

1. runs `pnpm pack`, which builds a tarball with `workspace:*` rewritten to the exact current version, then
2. uploads that tarball with `npm publish`.

The upload uses **npm rather than `pnpm publish`** on purpose: when 2FA is enforced on publish, `pnpm publish` can only obtain the one-time password interactively and aborts non-interactively with `ERR_PNPM_OTP_NON_INTERACTIVE`, whereas `npm publish` accepts a code via `--otp` and supports OIDC trusted publishing in CI. The script skips any version already on npm, so it is safe to re-run after a partial failure.

### Recommended: automated via CI

1. **Describe the change.** In the PR that makes a user-facing change, run `pnpm changeset`, choose the bump (patch / minor / major), and write a one-line summary. Commit the generated file under `.changeset/`.
2. **Merge to `main`.** The release workflow (`.github/workflows/release.yml`) sees the pending changeset and opens a **"Version Packages"** PR that bumps every package version and updates changelogs.
3. **Merge the "Version Packages" PR.** With no changesets left, the same workflow builds and runs `pnpm release`, packing and `npm publish`ing all five packages in dependency order; `changesets/action` then creates the GitHub releases and git tags.

CI must authenticate to npm in a way that satisfies publish-time 2FA — which an interactive OTP can't provide in a workflow. The recommended setup is **OIDC trusted publishing**: register this repo as a trusted publisher for each `@frites/*` package on npmjs and grant the publish job `id-token: write`; npm then trusts the GitHub Actions identity with no stored secret. A stored **`NPM_TOKEN`** only works if that token is exempt from publish-time 2FA — a token that isn't exempt fails in CI with `EOTP`, since no code can be entered there.

### Manual: from a clean local checkout

If you need to publish by hand, from a clean `main`:

```bash
npm login                    # once; the account must have publish rights to @frites
pnpm install
pnpm version:packages        # applies pending changesets: bumps versions + changelogs
pnpm release:dry             # optional: pack + `npm publish --dry-run`, sends nothing
NPM_OTP=123456 pnpm release  # builds, packs, npm-publishes; set NPM_OTP only if 2FA is enforced
pnpm changeset tag           # tag the published versions (e.g. @frites/core@0.0.1)
git push --follow-tags
```

`pnpm release` always builds first, so `dist/` is fresh before anything is published. `NPM_OTP` is a current authenticator code, needed only when the account or `@frites` org enforces 2FA on publish; omit it otherwise. `pnpm release:dry` runs `node scripts/publish.mjs --dry-run`, packing each package and running `npm publish --dry-run` so you can confirm the package set, versions, and rewritten `workspace:*` ranges without sending anything.

> The initial `0.0.1` release sets the lockstep baseline and its version fields were edited directly. Every release after that should go through `pnpm changeset` so versions and changelogs stay in sync.

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
