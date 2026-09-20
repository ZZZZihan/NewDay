import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { NotionSyncService } from "../services/notion-sync-service.js";
import { ApiError } from "./api-error.js";

const params = z.strictObject({ workspaceId: z.string().min(1).max(512) });
const operationParams = params.extend({ operationId: z.uuid() });

export function registerNotionSyncRoutes(app: FastifyInstance, service: NotionSyncService | null) {
  app.get("/api/notion/connections/:workspaceId/sync", async (request) => {
    if (!service) throw new ApiError(503, "本机尚未配置 Notion 连接");
    return service.status(params.parse(request.params).workspaceId);
  });
  app.post("/api/notion/connections/:workspaceId/sync/drain", async (request) => {
    if (!service) throw new ApiError(503, "本机尚未配置 Notion 连接");
    return service.drain(params.parse(request.params).workspaceId);
  });
  app.post("/api/notion/connections/:workspaceId/sync/operations/:operationId/reconcile", async (request) => {
    if (!service) throw new ApiError(503, "本机尚未配置 Notion 连接");
    const { workspaceId, operationId } = operationParams.parse(request.params);
    return service.reconcile(workspaceId, operationId);
  });
  app.post("/api/notion/connections/:workspaceId/sync/resume", async (request) => {
    if (!service) throw new ApiError(503, "本机尚未配置 Notion 连接");
    return service.resume(params.parse(request.params).workspaceId);
  });
}
