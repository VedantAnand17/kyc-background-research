import { defineConfig } from "vitest/config";

// `pnpm test:paid` only. Spends real Perflo credit; never included by `pnpm test` or `pnpm test:live`.
export default defineConfig({
  test: {
    include: ["test/live-paid.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 30_000,
    environment: "node",
    fileParallelism: false,
  },
});
