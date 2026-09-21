import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: { bindings: {
      NOTION_CLIENT_ID: "fake-client-id",
      NOTION_CLIENT_SECRET: "fake-client-secret",
      NOTION_REDIRECT_URI: "https://oauth.example.test/oauth/callback",
      LOCAL_RETURN_ORIGIN: "http://127.0.0.1:3000",
      LOCAL_API_KEY: "k".repeat(43),
    } },
  })],
  test: { include: ["tests/*.test.ts"] },
});
