#!/usr/bin/env node
// Publishes the public workspace packages to npm.
//
// Why this exists instead of `changeset publish` / `pnpm publish`:
// pnpm's publish can only obtain a one-time password interactively, so when the
// npm account (or the @frites org) enforces 2FA on publish it aborts with
// ERR_PNPM_OTP_NON_INTERACTIVE and there is no way to feed it a code. `npm
// publish` accepts an OTP via `--otp` (and supports OIDC trusted publishing in
// CI), so we upload with npm. npm can't resolve pnpm's `workspace:*` protocol,
// so each package is first packed with `pnpm pack` (which rewrites
// `workspace:*` to the real version in the tarball) and then uploaded with
// `npm publish <tarball>`.
//
// Set NPM_OTP to a current authenticator code when 2FA is required:
//   NPM_OTP=123456 pnpm release
// Re-runs are safe: versions already on npm are skipped. Pass --dry-run to
// pack and validate without uploading.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DRY = process.argv.includes("--dry-run");
const OTP = process.env.NPM_OTP; // current authenticator code, when 2FA is enforced

// Publish order: every package is uploaded after the packages it depends on.
const DIRS = [
  "packages/core",
  "packages/agents",
  "packages/isolation",
  "apps/gateway",
  "apps/cli",
];

const readPkg = (dir) =>
  JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8"));

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });

function alreadyPublished(name, version) {
  try {
    const out = execFileSync("npm", ["view", `${name}@${version}`, "version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === version;
  } catch {
    return false; // 404 / no such version → not published yet
  }
}

let published = 0;
for (const dir of DIRS) {
  const pkg = readPkg(dir);
  if (pkg.private) continue;
  const tag = `${pkg.name}@${pkg.version}`;

  if (!DRY && alreadyPublished(pkg.name, pkg.version)) {
    console.log(`• skip ${tag} (already on npm)`);
    continue;
  }

  // Pack with pnpm so `workspace:*` deps resolve to real versions in the tarball.
  const dest = mkdtempSync(join(tmpdir(), "frites-pack-"));
  run("pnpm", ["pack", "--pack-destination", dest], { cwd: join(ROOT, dir) });
  const tgz = readdirSync(dest).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error(`pnpm pack produced no tarball for ${pkg.name}`);

  // Upload with npm — accepts an OTP via --otp (pnpm can't take one non-interactively).
  const args = ["publish", join(dest, tgz), "--access", "public"];
  if (OTP) args.push(`--otp=${OTP}`);
  if (DRY) args.push("--dry-run");
  run("npm", args);

  // changesets/action detects published packages from these lines.
  console.log(`🦋  New tag:  ${tag}`);
  published++;
}

console.log(
  DRY
    ? `\nDry run complete — would publish ${published} package(s).`
    : `\nPublished ${published} package(s).`,
);
