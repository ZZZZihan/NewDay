import type { FastifyInstance } from "fastify";
import { updateContextRequestSchema } from "@newday/core/contracts/agent-planning";
import type { PlannerContextService } from "../services/planner-context-service.js";

export function registerAgentContextRoutes(app: FastifyInstance, context: PlannerContextService) {
  app.get("/api/agent/context/today", async () => context.getTodayContext());
  app.put("/api/agent/context/today", async (request) => context.updateTodayContext(updateContextRequestSchema.parse(request.body)));
}
