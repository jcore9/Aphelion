import { defineConfig } from "vitest/config";

if (!("bun" in process.versions)) {
  throw new Error("Run the tests on Bun: bun --bun vitest run");
}

export default defineConfig({
  test: {
    pool: "threads",
    include: ["*.test.ts", "packages/*/src/**/*.test.{ts,tsx}"],
  },
});
