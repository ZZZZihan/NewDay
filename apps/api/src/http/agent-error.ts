import type { AgentErrorCode } from "@newday/core/contracts/agent-planning";

export class AgentApiError extends Error {
  constructor(
    public readonly code: AgentErrorCode,
    public readonly statusCode: number,
    message: string,
    public readonly retryable = false,
    public readonly correlationId?: string,
  ) {
    super(message);
    this.name = "AgentApiError";
  }
}
