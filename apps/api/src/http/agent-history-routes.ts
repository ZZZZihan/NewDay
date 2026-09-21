import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { feedbackRequestSchema, importAgentBackupRequestSchema } from "@newday/core/contracts/agent-planning";
import { localDateSchema } from "@newday/core/domain/planner-model";
import type { PlannerHistoryService } from "../services/planner-history-service.js";

const historyQuerySchema = z.strictObject({ date: localDateSchema });

export function registerAgentHistoryRoutes(app: FastifyInstance, history: PlannerHistoryService) {
  app.get("/api/agent/history", async (request) => history.history(historyQuerySchema.parse(request.query).date));
  app.post("/api/agent/feedback", async (request) => history.feedback(feedbackRequestSchema.parse(request.body)));
  app.delete("/api/agent/history", async (request) => {
    z.strictObject({}).parse(request.body ?? {});
    return history.clearHistory();
  });
  app.get("/api/agent/backup", async () => history.backup());
  app.post("/api/agent/backup", async (request) => {
    const { source, importPreferences } = importAgentBackupRequestSchema.parse(request.body);
    return history.importBackup(source, importPreferences);
  });
}
