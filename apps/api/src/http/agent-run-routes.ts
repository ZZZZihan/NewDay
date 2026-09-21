import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { answerRunRequestSchema, createRunRequestSchema } from "@newday/core/contracts/agent-planning";
import type { AgentRunService } from "../services/agent-run-service.js";

const paramsSchema = z.strictObject({ id: z.string().min(1).max(200) });

export function registerAgentRunRoutes(app: FastifyInstance, service: AgentRunService) {
  app.post("/api/agent/runs", async (request, reply) => {
    const result = await service.create(createRunRequestSchema.parse(request.body));
    return reply.code(202).send(result);
  });
  app.get("/api/agent/runs/:id", async (request) => service.get(paramsSchema.parse(request.params).id));
  app.post("/api/agent/runs/:id/answer", async (request, reply) => {
    const result = await service.answer(paramsSchema.parse(request.params).id, answerRunRequestSchema.parse(request.body));
    return reply.code(202).send(result);
  });
  app.post("/api/agent/runs/:id/cancel", async (request) => {
    z.strictObject({}).parse(request.body);
    return service.cancel(paramsSchema.parse(request.params).id);
  });
}
