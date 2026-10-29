import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["test/setup.ts"],
    // Feature worktrees hold their own copy of the tests.
    exclude: [...configDefaults.exclude, ".worktrees/**"],
    // Every test spawns git, which can exceed the 5s default under load.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
