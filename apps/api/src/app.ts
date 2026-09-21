import Fastify from "fastify";
import { ZodError } from "zod";
import { loadConfig } from "./config.js";
import { ApiError } from "./http/api-error.js";
import { registerPlannerRoutes } from "./http/planner-routes.js";
import { registerLifeRoutes } from "./http/life-routes.js";
import { PlannerService } from "./services/planner-service.js";
import { LifeService } from "./services/life-service.js";
import { SQLitePlannerStore } from "./storage/sqlite-planner-store.js";
import { AgentApiError } from "./http/agent-error.js";
import type { PlanningModel } from "./agent/planning-model.js";
import { createPlanningModel } from "./create-planning-model.js";
import { AgentRunService } from "./services/agent-run-service.js";
import { AgentExecutionService } from "./services/agent-execution-service.js";
import { PlannerContextService } from "./services/planner-context-service.js";
import { PlannerPreferencesService } from "./services/planner-preferences-service.js";
import { PlannerHistoryService } from "./services/planner-history-service.js";
import { registerAgentRunRoutes } from "./http/agent-run-routes.js";
import { registerAgentExecutionRoutes } from "./http/agent-execution-routes.js";
import { registerAgentContextRoutes } from "./http/agent-context-routes.js";
import { registerAgentPreferencesRoutes } from "./http/agent-preferences-routes.js";
import { registerAgentHistoryRoutes } from "./http/agent-history-routes.js";
import { dateInTimeZone } from "@newday/core/contracts/agent-planning";
import { NotionCredentialVault } from "./storage/notion-credential-vault.js";
import { NotionOAuthService } from "./services/notion-oauth-service.js";
import { registerNotionOAuthRoutes } from "./http/notion-oauth-routes.js";
import { NotionStructureService } from "./services/notion-structure-service.js";
import { NotionSdkStructureGateway, type NotionStructureGateway } from "./services/notion-structure-gateway.js";
import { NotionSdkReadGateway, type NotionReadGateway } from "./services/notion-read-gateway.js";
import { NotionReadService } from "./services/notion-read-service.js";
import { registerNotionReadRoutes } from "./http/notion-read-routes.js";
import type { ApiConfig } from "./config.js";

export type AppOptions = {
  databasePath?: string;
  webOrigins?: readonly string[];
  logger?: boolean;
  bodyLimit?: number;
  clock?: () => number;
  planningModel?: PlanningModel | null;
  agentTimeoutMs?: number;
  notionOAuth?: ApiConfig["notionOAuth"];
  notionFetcher?: typeof fetch;
  notionStructureGateway?: NotionStructureGateway;
  notionReadGateway?: NotionReadGateway;
};

export function createApp(options: AppOptions = {}) {
  const config = loadConfig();
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: options.bodyLimit ?? 10 * 1024 * 1024 });
  const store = new SQLitePlannerStore(options.databasePath ?? config.databasePath);
  const notionOptions = options.notionOAuth === undefined ? config.notionOAuth : options.notionOAuth;
  const notionVault = notionOptions ? new NotionCredentialVault(notionOptions.vaultPath, notionOptions.encryptionKey) : null;
  const notionOAuth = notionOptions && notionVault
    ? new NotionOAuthService(notionOptions.workerOrigin, notionOptions.workerApiKey, notionVault, options.notionFetcher, options.clock)
    : null;
  const notionStructure = notionVault
    ? new NotionStructureService(store, notionVault, options.notionStructureGateway ?? new NotionSdkStructureGateway(), options.clock)
    : null;
  const notionRead = notionVault
    ? new NotionReadService(store, notionVault, options.notionReadGateway ?? new NotionSdkReadGateway(), options.clock)
    : null;
  const planner = new PlannerService(store, options.clock);
  const life = new LifeService(store, options.clock);
  const context = new PlannerContextService(store, options.clock);
  const preferences = new PlannerPreferencesService(store, options.clock);
  const history = new PlannerHistoryService(store, options.clock);
  const model = options.planningModel === null ? undefined : options.planningModel ?? createPlanningModel(config.agent);
  const runs = new AgentRunService(store, context, model, { clock: options.clock, timeoutMs: options.agentTimeoutMs ?? config.agent.timeoutMs });
  const execution = new AgentExecutionService(store, options.clock);
  const allowedOrigins = new Set(options.webOrigins ?? config.webOrigins);

  app.addHook("onRequest", async (request) => {
    const origin = request.headers.origin;
    // Responses carry no CORS headers. A browser uses the web service's /api
    // reverse proxy; an untrusted website may not read or mutate this local API.
    if (origin !== undefined && !allowedOrigins.has(origin)) throw new ApiError(403, "请求来源不受允许");
    if (request.headers["sec-fetch-site"] === "cross-site") throw new ApiError(403, "请求来源不受允许");
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
        throw new ApiError(415, "请使用 application/json 请求格式");
      }
    }
  });

  app.addHook("onSend", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AgentApiError) return reply.code(error.statusCode).send({ code: error.code, status: error.statusCode, message: error.message, retryable: error.retryable, correlationId: error.correlationId });
    if (error instanceof ApiError) return reply.code(error.statusCode).send({ message: error.message });
    if (error instanceof ZodError) return reply.code(400).send({ message: error.issues[0]?.message ?? "请求数据无效", ...(request.url.startsWith("/api/agent/") ? { code: "INVALID_INPUT", status: 400, retryable: false } : {}) });
    const status = typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : undefined;
    if (status === 413) return reply.code(413).send({ message: "请求内容过大" });
    if (status === 400) return reply.code(400).send({ message: "请求格式无效" });
    if (status === 415) return reply.code(415).send({ message: "不支持的请求格式" });
    request.log.error({ err: error }, "Planner request failed");
    return reply.code(500).send({ message: "服务器暂时无法完成请求", ...(request.url.startsWith("/api/agent/") ? { code: "INTERNAL_ERROR", status: 500, retryable: true } : {}) });
  });

  app.addHook("onReady", async () => { await runs.initialize(); notionRead?.startPolling(); });
  app.addHook("onClose", async () => { notionRead?.close(); await runs.close(); notionVault?.close(); store.close(); });
  registerPlannerRoutes(app, planner);
  registerLifeRoutes(app, life);
  registerAgentRunRoutes(app, runs);
  registerAgentExecutionRoutes(app, execution);
  registerAgentContextRoutes(app, context);
  registerAgentPreferencesRoutes(app, preferences);
  registerAgentHistoryRoutes(app, history);
  registerNotionOAuthRoutes(app, notionOAuth, notionStructure);
  registerNotionReadRoutes(app, notionRead);
  app.get("/api/agent/status", () => store.transaction(async () => {
    const prefs = await preferences.getPreferences();
    return { configured: runs.isConfigured(), modelId: model?.modelId ?? null, timeZone: prefs.timeZone,
      today: prefs.timeZone ? dateInTimeZone((options.clock ?? Date.now)(), prefs.timeZone) : null };
  }));
  return app;
}
