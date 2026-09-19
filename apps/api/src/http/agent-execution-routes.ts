import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { applyProposalRequestSchema, revertOperationRequestSchema } from "@newday/core/contracts/agent-planning";
import type { AgentExecutionService } from "../services/agent-execution-service.js";
import { AgentApiError } from "./agent-error.js";

const idParamsSchema = z.strictObject({ id: z.string().min(1).max(200) });

export function registerAgentExecutionRoutes(app: FastifyInstance, execution: AgentExecutionService) {
  app.post("/api/agent/proposals/:id/apply", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = applyProposalRequestSchema.parse(request.body);
    if (input.proposalId !== id) throw new AgentApiError("INVALID_INPUT", 400, "建议标识与请求路径不一致");
    return execution.apply(input);
  });
  app.get("/api/agent/operations/:id", async (request) => execution.operation(idParamsSchema.parse(request.params).id));
  app.post("/api/agent/operations/:id/revert", async (request) => execution.revert(idParamsSchema.parse(request.params).id, revertOperationRequestSchema.parse(request.body)));
}
