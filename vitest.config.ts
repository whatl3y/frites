import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@frites/core": new URL("./packages/core/src/index.ts", import.meta.url)
        .pathname,
      "@frites/isolation": new URL(
        "./packages/isolation/src/index.ts",
        import.meta.url,
      ).pathname,
      "@frites/agents": new URL(
        "./packages/agents/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    environment: "node",
  },
});
