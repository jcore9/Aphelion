import { defineConfig } from "vitest/config";

if (!("bun" in process.versions)) {
  throw new Error("Run the tests on Bun: bun --bun vitest run");
}

export default defineConfig({
  test: {
    pool: "threads",
    include: [
      "*.test.ts",
      "apps/*/src/**/*.test.{ts,tsx}",
      "packages/*/src/**/*.test.{ts,tsx}",
      "templates/*/src/**/*.test.ts",
      "docs/src/**/*.test.ts",
    ],
  },
});
