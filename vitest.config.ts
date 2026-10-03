import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Local .pi/research checkouts are not this package's test suite.
    include: ["tests/**/*.test.ts"],
    maxWorkers: 2,
  },
});
