import type { FastifyInstance } from "fastify";
import type { PlannerService } from "../services/planner-service.js";
import {
  backupRequestSchema, clientIdSchema, commandRequestSchema, dayQuerySchema,
  seriesParamsSchema, stopPreviewSchema, undoRequestSchema,
} from "./planner-schemas.js";

export function registerPlannerRoutes(app: FastifyInstance, planner: PlannerService) {
  app.get("/api/health", async () => ({ status: "ok" }));

  app.get("/api/planner/day", async (request) => planner.day(dayQuerySchema.parse(request.query)));

  app.get("/api/planner/series/:id", async (request) =>
    planner.series(seriesParamsSchema.parse(request.params).id));

  app.post("/api/planner/commands", async (request) => {
    const clientId = clientIdSchema.parse(request.headers["x-newday-client"]);
    const body = commandRequestSchema.parse(request.body);
    return planner.commands(body.commands, clientId, body.expectedTask);
  });

  app.post("/api/planner/undo", async (request) => {
    const clientId = clientIdSchema.parse(request.headers["x-newday-client"]);
    return planner.undo(undoRequestSchema.parse(request.body).receipt, clientId);
  });

  app.get("/api/planner/backup", async () => planner.backup());
  app.post("/api/planner/backup", async (request) => planner.restore(backupRequestSchema.parse(request.body).source));
  app.post("/api/planner/stop-preview", async (request) => planner.stopPreview(stopPreviewSchema.parse(request.body)));
  app.post("/api/planner/migrate", async (request) => planner.migrate(backupRequestSchema.parse(request.body).source));
}
