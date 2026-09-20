import { defineConfig } from "vitest/config";

// tests/browser/**/*.test.mjs are node:test files (run via
// `npm run test:browser` / `node --test`, docs/specs/40-browser-test-
// harness.md) — excluded here so vitest's own default include glob
// doesn't also try to collect them (a node:test file has no vitest
// suite in it, which vitest reports as a failure, not a skip).
export default defineConfig({
  test: {
    exclude: ["node_modules/**", "dist/**", "tests/browser/**"],
  },
});
