import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**", "_workspace/**"],
    environment: "node",
    // M0 has no live-browser tests. Live adviser smoke tests (M2+) are gated behind an explicit
    // opt-in and excluded from the default run so CI never depends on a ChatGPT session.
    testTimeout: 20_000,
  },
});
