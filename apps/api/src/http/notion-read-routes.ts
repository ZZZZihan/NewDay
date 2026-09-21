import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { ApiError } from "./api-error.js";
import type { NotionReadService } from "../services/notion-read-service.js";

const paramsSchema = z.strictObject({ workspaceId: z.string().min(1).max(128) });

export function registerNotionReadRoutes(app: FastifyInstance, read: NotionReadService | null): void {
  app.get("/api/notion/connections/:workspaceId/read", async (request) => {
    const { workspaceId } = paramsSchema.parse(request.params);
    if (!read) throw new ApiError(503, "Notion 只读同步尚未配置");
    return read.status(workspaceId);
  });
  app.post("/api/notion/connections/:workspaceId/read/scan", async (request) => {
    z.strictObject({}).parse(request.body);
    const { workspaceId } = paramsSchema.parse(request.params);
    if (!read) throw new ApiError(503, "Notion 只读同步尚未配置");
    return read.scan(workspaceId);
  });
}
