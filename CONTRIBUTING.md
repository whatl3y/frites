# Contributing to frites

Thanks for your interest in contributing! This guide covers how to propose changes, the local
workflow, and what we expect in a pull request. Setup and architecture details live in the
[README](README.md#development) and [docs/development/](docs/development/) — this page is the front
door, not a duplicate of them.

This project follows a [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you're expected to
uphold it.

## Ways to contribute

- **Report a bug or request a feature** — open a [GitHub issue](../../issues). Include what you
  expected, what happened, and steps to reproduce.
- **Propose a non-trivial change** — open an issue to discuss it _before_ writing a large PR, so we
  can agree on the approach. Small fixes (typos, obvious bugs) can go straight to a PR.

## Development setup

frites is a [pnpm](https://pnpm.io) monorepo (`apps/*` + `packages/*`) targeting Node >= 22. pnpm is
pinned via the root `packageManager` field — enable it with `corepack enable` if you don't have it.

```bash
pnpm install        # install workspace deps
pnpm build          # compile all packages (core → agents → isolation → gateway → cli)
pnpm test           # run the unit suite (vitest)
pnpm typecheck      # type-check without emitting
pnpm frites ...     # run the CLI from source via tsx (no build needed)
```

More detail: [Repository structure](docs/development/repository-structure.md),
[Local development](docs/development/local-development.md), and
[Testing](docs/development/testing.md).

## Making a change

1. **Fork and branch.** Branch off `main` with a descriptive name (e.g. `fix/gateway-sse-flush`).
2. **Write the change** with tests where it makes sense. Match the style of the surrounding code.
3. **Keep it green.** Before pushing:
   ```bash
   pnpm typecheck && pnpm test
   ```
4. **Add a changeset** if your change affects published behavior of any `@frites/*` package:
   ```bash
   pnpm changeset
   ```
   Pick the bump (patch / minor / major) and write a one-line summary; commit the generated file in
   `.changeset/`. Skip this only for changes that don't affect published packages (docs, internal
   tooling, tests). See [Release & packaging](docs/development/release-and-packaging.md) for how
   releases work.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/). The type prefix drives a clear,
scannable history:

```
feat(gateway): stream synthesis tokens incrementally
fix(cli): resolve repo path before spawning runners
docs: clarify MCP worktree setup
chore: bump dev dependencies
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`. Keep the subject in the imperative
mood and under ~72 characters.

## Pull requests

Open your PR against `main` and include:

- A clear description of **what** changed and **why**.
- A link to the issue it addresses, if any.
- Confirmation that `pnpm typecheck` and `pnpm test` pass.
- A changeset, if the change is user-facing (see above).

Keep PRs focused — one logical change per PR is much easier to review than a large mixed one. A
maintainer will review and may request changes before merging.

## License

By contributing, you agree that your contributions will be licensed under the project's
[Apache License 2.0](LICENSE) (inbound = outbound).
