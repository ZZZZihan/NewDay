import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { ApiError } from "./api-error.js";
import type { NotionOAuthService } from "../services/notion-oauth-service.js";

const opaqueToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const claimSchema = z.strictObject({ state: opaqueToken, ticket: opaqueToken });
const cancelSchema = z.strictObject({ state: opaqueToken });
const disconnectParams = z.strictObject({ workspaceId: z.string().min(1).max(128) });

export function registerNotionOAuthRoutes(app: FastifyInstance, oauth: NotionOAuthService | null): void {
  app.get("/api/notion/status", () => ({ configured: oauth !== null, connections: oauth?.listConnections() ?? [] }));

  app.post("/api/notion/oauth/start", async (request) => {
    z.strictObject({}).parse(request.body);
    return required(oauth).start();
  });

  app.post("/api/notion/oauth/claim", async (request) => {
    const { state, ticket } = claimSchema.parse(request.body);
    return { connection: await required(oauth).claim(state, ticket) };
  });

  app.post("/api/notion/oauth/cancel", (request) => {
    const { state } = cancelSchema.parse(request.body);
    required(oauth).cancel(state);
    return { ok: true };
  });

  app.post("/api/notion/connections/:workspaceId/disconnect", (request) => {
    z.strictObject({}).parse(request.body);
    const { workspaceId } = disconnectParams.parse(request.params);
    return { ok: true, removed: required(oauth).disconnect(workspaceId) };
  });

  app.post("/api/notion/connections/:workspaceId/refresh", async (request) => {
    z.strictObject({}).parse(request.body);
    const { workspaceId } = disconnectParams.parse(request.params);
    return { connection: await required(oauth).refresh(workspaceId) };
  });
}

function required(oauth: NotionOAuthService | null): NotionOAuthService {
  if (!oauth) throw new ApiError(503, "Notion 授权尚未配置");
  return oauth;
}
