import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "qa/**/*.test.ts"],
    environment: "node",
    setupFiles: ["src/test-support/no-fsync.ts", "src/test-support/no-sampling.ts"],
  },
});
