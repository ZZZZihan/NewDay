import { basename, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// src/config.ts and dist/server.js both live one level below apps/api.
export const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

export type ApiConfig = {
  host: string;
  port: number;
  databasePath: string;
  webOrigins: readonly string[];
  notionOAuth: {
    workerOrigin: string;
    workerApiKey: string;
    vaultPath: string;
    encryptionKey: Buffer;
  } | null;
  agent: {
    provider: "disabled" | "openai-compatible" | "scripted";
    baseUrl: string;
    modelId?: string;
    apiKey?: string;
    allowHttpOrigin?: string;
    reasoningEffort?: "none" | "low" | "medium" | "high";
    timeoutMs: number;
    maxOutputTokens: number;
  };
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  const rawPort = environment.NEWDAY_API_PORT ?? "3001";
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65_535) {
    throw new Error("NEWDAY_API_PORT must be an integer between 1 and 65535");
  }
  const configuredOrigin = environment.NEWDAY_WEB_ORIGIN;
  const webOrigins = configuredOrigin
    ? [parseWebOrigin(configuredOrigin)]
    : ["http://localhost:3000", "http://127.0.0.1:3000"];
  const databasePath = environment.NEWDAY_DATABASE_PATH ?? "data/newday.sqlite";
  const resolvedDatabasePath = databasePath === ":memory:" ? databasePath : resolve(repositoryRoot, databasePath);
  const provider = environment.NEWDAY_AGENT_PROVIDER ?? "disabled";
  if (!["disabled", "openai-compatible", "scripted"].includes(provider)) throw new Error("NEWDAY_AGENT_PROVIDER is invalid");
  if (provider === "scripted" && (environment.NEWDAY_TEST_RUN !== "1" ||
    dirname(dirname(resolvedDatabasePath)) !== resolve(tmpdir()) || !/^newday-e2e-/.test(basename(dirname(resolvedDatabasePath))))) {
    throw new Error("Scripted Agent is restricted to disposable E2E databases");
  }
  const baseUrl = environment.NEWDAY_AGENT_BASE_URL ?? "https://api.openai.com/v1";
  const parsedBaseUrl = new URL(baseUrl);
  if (!["http:", "https:"].includes(parsedBaseUrl.protocol) || parsedBaseUrl.username || parsedBaseUrl.password || parsedBaseUrl.search || parsedBaseUrl.hash) {
    throw new Error("NEWDAY_AGENT_BASE_URL must be an HTTP(S) URL without credentials, query or fragment");
  }
  if (provider === "openai-compatible" && (!environment.NEWDAY_AGENT_API_KEY || !environment.NEWDAY_AGENT_MODEL)) {
    throw new Error("OpenAI-compatible Agent requires NEWDAY_AGENT_API_KEY and NEWDAY_AGENT_MODEL");
  }
  const reasoningEffort = environment.NEWDAY_AGENT_REASONING_EFFORT;
  if (reasoningEffort !== undefined && !["none", "low", "medium", "high"].includes(reasoningEffort)) {
    throw new Error("NEWDAY_AGENT_REASONING_EFFORT must be none, low, medium or high");
  }

  const workerOrigin = environment.NEWDAY_NOTION_WORKER_ORIGIN;
  const rawKey = environment.NEWDAY_NOTION_CREDENTIAL_KEY;
  const workerApiKey = environment.NEWDAY_NOTION_WORKER_API_KEY;
  if ([workerOrigin, rawKey, workerApiKey].some(Boolean) && ![workerOrigin, rawKey, workerApiKey].every(Boolean)) {
    throw new Error("Notion OAuth requires NEWDAY_NOTION_WORKER_ORIGIN, NEWDAY_NOTION_WORKER_API_KEY and NEWDAY_NOTION_CREDENTIAL_KEY");
  }
  let notionOAuth: ApiConfig["notionOAuth"] = null;
  if (workerOrigin && rawKey && workerApiKey) {
    const url = new URL(workerOrigin);
    if (url.protocol !== "https:" || url.origin !== workerOrigin) {
      throw new Error("NEWDAY_NOTION_WORKER_ORIGIN must be an HTTPS origin without a path");
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(rawKey)) {
      throw new Error("NEWDAY_NOTION_CREDENTIAL_KEY must be a base64url-encoded 32-byte key");
    }
    const encryptionKey = Buffer.from(rawKey, "base64url");
    if (encryptionKey.length !== 32 || encryptionKey.toString("base64url") !== rawKey) {
      throw new Error("NEWDAY_NOTION_CREDENTIAL_KEY must be a base64url-encoded 32-byte key");
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(workerApiKey)) {
      throw new Error("NEWDAY_NOTION_WORKER_API_KEY must be a base64url-encoded 32-byte key");
    }
    const vaultPath = resolve(repositoryRoot, environment.NEWDAY_NOTION_CREDENTIAL_PATH ?? "data/notion-vault/credentials.sqlite");
    if (vaultPath === resolvedDatabasePath) throw new Error("Notion credential vault must be separate from the planner database");
    notionOAuth = { workerOrigin, workerApiKey, vaultPath, encryptionKey };
  }

  return {
    host: environment.NEWDAY_API_HOST ?? "127.0.0.1",
    port: Number(rawPort),
    databasePath: resolvedDatabasePath,
    webOrigins,
    notionOAuth,
    agent: {
      provider: provider as ApiConfig["agent"]["provider"], baseUrl,
      modelId: environment.NEWDAY_AGENT_MODEL, apiKey: environment.NEWDAY_AGENT_API_KEY,
      allowHttpOrigin: environment.NEWDAY_AGENT_ALLOW_HTTP_ORIGIN,
      reasoningEffort: reasoningEffort as ApiConfig["agent"]["reasoningEffort"],
      timeoutMs: integerSetting(environment.NEWDAY_AGENT_TIMEOUT_MS, 30_000, 1, 30_000, "NEWDAY_AGENT_TIMEOUT_MS"),
      maxOutputTokens: integerSetting(environment.NEWDAY_AGENT_MAX_OUTPUT_TOKENS, 1200, 100, 4000, "NEWDAY_AGENT_MAX_OUTPUT_TOKENS"),
    },
  };
}

function integerSetting(raw: string | undefined, fallback: number, min: number, max: number, name: string) {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return Number(raw);
}

function parseWebOrigin(value: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== value) {
    throw new Error("NEWDAY_WEB_ORIGIN must be an HTTP(S) origin without a path");
  }
  return url.origin;
}
