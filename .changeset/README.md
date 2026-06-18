# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets). It drives versioning and npm publishing for the `@frites/*` packages.

## How it works here

- **Fixed (lockstep) versioning.** Every publishable package — `@frites/cli`, `@frites/gateway`, `@frites/core`, `@frites/agents`, `@frites/isolation` — always shares the same version and is published together. This is configured via the `fixed` group in [`config.json`](./config.json), so installing `@frites/cli` always pulls a matching set of dependencies.
- `@frites/mcp` and the repo root are private and are never published (see `ignore` / `private: true`).

## Adding a changeset

When you make a change worth releasing, run:

```bash
pnpm changeset
```

Pick the bump type (patch / minor / major) and write a short summary. This drops a markdown file in this folder describing the change. Commit it with your PR.

See [Release & packaging](../docs/development/release-and-packaging.md) for the full release flow.
