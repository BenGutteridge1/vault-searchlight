import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      obsidian: `${import.meta.dirname}/src/test/obsidian-stub.ts`,
    },
  },
  test: {
    exclude: [...configDefaults.exclude, "outputs/**", "work/**"],
  },
});
