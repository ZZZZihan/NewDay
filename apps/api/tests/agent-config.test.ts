import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("Agent defaults to disabled and requires an explicit provider model and key", () => {
  assert.equal(loadConfig({}).agent.provider, "disabled");
  assert.throws(() => loadConfig({ NEWDAY_AGENT_PROVIDER: "openai-compatible" }), /requires/);
  assert.throws(() => loadConfig({ NEWDAY_AGENT_PROVIDER: "other" }), /invalid/);
  assert.throws(() => loadConfig({ NEWDAY_AGENT_TIMEOUT_MS: "30001" }), /30000/);
  assert.throws(() => loadConfig({ NEWDAY_AGENT_BASE_URL: "https://user:pass@example.test/v1" }), /credentials/);
});

test("the scripted provider cannot be enabled against normal development data", () => {
  assert.throws(() => loadConfig({ NEWDAY_AGENT_PROVIDER: "scripted" }), /disposable/);
  assert.throws(() => loadConfig({ NEWDAY_AGENT_PROVIDER: "scripted", NEWDAY_TEST_RUN: "1", NEWDAY_DATABASE_PATH: ":memory:" }), /disposable/);
  const config = loadConfig({ NEWDAY_AGENT_PROVIDER: "scripted", NEWDAY_TEST_RUN: "1", NEWDAY_DATABASE_PATH: join(tmpdir(), "newday-e2e-config", "planner.sqlite") });
  assert.equal(config.agent.provider, "scripted");
});

test("provider-specific transport and reasoning options remain explicit", () => {
  const defaults = loadConfig({}).agent;
  assert.equal(defaults.allowHttpOrigin, undefined);
  assert.equal(defaults.reasoningEffort, undefined);
  assert.equal(defaults.requestProfile, "openai-structured");
  const config = loadConfig({
    NEWDAY_AGENT_ALLOW_HTTP_ORIGIN: "http://192.168.1.10:8080",
    NEWDAY_AGENT_REASONING_EFFORT: "none",
    NEWDAY_AGENT_REQUEST_PROFILE: "deepseek-json",
  });
  assert.equal(config.agent.allowHttpOrigin, "http://192.168.1.10:8080");
  assert.equal(config.agent.reasoningEffort, "none");
  assert.equal(config.agent.requestProfile, "deepseek-json");
  assert.throws(() => loadConfig({ NEWDAY_AGENT_REASONING_EFFORT: "unlimited" }), /REASONING_EFFORT/);
  assert.throws(() => loadConfig({ NEWDAY_AGENT_REQUEST_PROFILE: "automatic" }), /REQUEST_PROFILE/);
  assert.throws(() => loadConfig({
    NEWDAY_AGENT_REQUEST_PROFILE: "deepseek-json", NEWDAY_AGENT_REASONING_EFFORT: "medium",
  }), /none, low or high/);
});
