# @frites/cli

CLI for the frites multi-agent gateway and coding council.

## Publish to npm

This package is scoped (`@frites/cli`), so npm requires it to be published with public access. The package already sets this in `publishConfig.access`, but keep the explicit `--access public` flag in release commands so the intent is clear.

From the repo root:

```sh
pnpm install
pnpm build
pnpm --filter @frites/cli publish --access public
```

For a dry run before publishing:

```sh
pnpm --filter @frites/cli publish --dry-run --access public
```

Use `pnpm publish` rather than running `npm publish` directly from this workspace package so workspace dependencies are packed correctly for npm.

## Pre-publish checklist

- Confirm `version` in `apps/cli/package.json` is the version you want to publish.
- Run `pnpm build` from the repo root.
- Run the dry run and check that only the expected files are included.
- Publish with `--access public`.
