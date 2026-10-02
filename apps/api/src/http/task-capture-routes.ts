import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { applyCaptureRequestSchema, createCaptureRequestSchema } from "@newday/core/contracts/task-capture";
import type { TaskCaptureService } from "../services/task-capture-service.js";

const params = z.strictObject({ id: z.string().min(1).max(200) });

export function registerTaskCaptureRoutes(app: FastifyInstance, service: TaskCaptureService) {
  app.get("/api/agent/captures/status", () => ({ configured: service.isConfigured(), modelId: service.modelId }));
  app.post("/api/agent/captures", async (request, reply) => {
    const run = await service.create(createCaptureRequestSchema.parse(request.body));
    return reply.code(202).send(run);
  });
  app.get("/api/agent/captures/:id", async (request) => service.get(params.parse(request.params).id));
  app.post("/api/agent/captures/:id/apply", async (request) =>
    service.apply(params.parse(request.params).id, applyCaptureRequestSchema.parse(request.body)));
  app.post("/api/agent/captures/:id/cancel", async (request) => {
    z.strictObject({}).parse(request.body);
    return service.cancel(params.parse(request.params).id);
  });
}
