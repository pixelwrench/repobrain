import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["test/setup.ts"],
    // Every test spawns git, which can exceed the 5s default under load.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
