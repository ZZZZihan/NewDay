import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  // sqlite is a prefix-only Node built-in; tsup's default removal would turn
  // node:sqlite into a lookup for an unrelated npm package named sqlite.
  removeNodeProtocol: false,
  noExternal: ["@newday/core"],
  clean: true,
});
