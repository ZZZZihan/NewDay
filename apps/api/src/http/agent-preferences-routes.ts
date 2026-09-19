import type { FastifyInstance } from "fastify";
import { updatePreferencesRequestSchema } from "@newday/core/contracts/agent-planning";
import type { PlannerPreferencesService } from "../services/planner-preferences-service.js";

export function registerAgentPreferencesRoutes(app: FastifyInstance, preferences: PlannerPreferencesService) {
  app.get("/api/agent/preferences", async () => preferences.getPreferences());
  app.put("/api/agent/preferences", async (request) => preferences.updatePreferences(updatePreferencesRequestSchema.parse(request.body)));
}
