# Testing

frites has two gates you run from the repo root: a typecheck and a unit-test suite. For prerequisites and the surrounding dev loop, see [local-development.md](local-development.md).

## Typecheck

```bash
pnpm typecheck
```

This runs `tsc --noEmit` against the whole workspace using the root `tsconfig.json` (strict mode, ES2023/ESNext, Bundler resolution). It compiles `packages/*/src`, `packages/*/test`, `apps/*/src`, `apps/*/test`, and `eval/**`, resolving the `@frites/*` packages from source via the `paths` aliases, so no build is needed first.

## Unit tests

```bash
pnpm test          # vitest run (one-shot)
pnpm test:watch    # vitest (watch mode)
```

Tests run under [Vitest](https://vitest.dev) in a Node environment (`vitest.config.ts`). The include globs are:

```
packages/*/test/**/*.test.ts
apps/*/test/**/*.test.ts
```

Like the typecheck, the runner aliases `@frites/core`, `@frites/isolation`, and `@frites/agents` to each package's `src/index.ts`, so tests exercise source directly without a build step.

### Where tests live

Each package keeps its tests in a sibling `test/` directory:

| Location | Test files (examples) |
|---|---|
| `packages/core/test` | `engine.test.ts`, `agent-loop.test.ts`, `answer-council.test.ts`, `synthesis.test.ts`, `config.test.ts` |
| `packages/agents/test` | `completion-stream.test.ts`, `env-sandbox.test.ts`, `pricing.test.ts`, `runner-usage.test.ts`, `timeout.test.ts` |
| `packages/isolation/test` | `worktree.test.ts` |
| `apps/gateway/test` | `logger.test.ts`, `progress.test.ts` |
| `apps/mcp/test` | `runtime.test.ts` |

### Current count

The suite currently passes **126/126 unit tests** (per the project README's status). These are fast, host-independent unit tests. They do not spawn real child agents.

## Live smoke tests

Unit tests cover the engine, config, oracle, and telemetry without hitting real models. To validate end-to-end behavior, frites is also exercised with **live smoke tests against a real `claude` client**. For example, a real `claude` client pointed at the gateway driving a fix end-to-end, and (for worktree mode) an opt-in synthesis smoke that runs two inexpensive children against a tiny fixture repo.

**When to run them.** Live smoke tests are **metered**: each turn fans out to real child CLIs that draw on your subscriptions. Run them only when you need end-to-end confidence (after changes to the gateway transport, the agent runners, the worktree/oracle path, or synthesis), not on every edit. Keep them opt-in and small (a fixture repo, the cheapest children) so a routine `pnpm typecheck` + `pnpm test` stays free and fast as the default loop.

For the larger metered harnesses (the value-gate A/B and the bench matrix), see [evaluation.md](evaluation.md).
