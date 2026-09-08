import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/live-model.test.ts"],
    testTimeout: 120_000,
    environment: "node",
  },
});
