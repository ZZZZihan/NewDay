import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/unit/**/*.test.{ts,tsx}", "tests/architecture/**/*.test.ts", "tests/agent/unit/**/*.test.ts", "apps/web/src/**/*.test.{ts,tsx}"],
    exclude: ["tests/e2e/**", "node_modules/**"],
  },
});
