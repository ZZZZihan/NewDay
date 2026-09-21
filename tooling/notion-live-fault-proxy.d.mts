import type { Server } from "node:http";

export type NotionFaultAction = "drop_before_upstream" | "drop_after_upstream" | "respond_status" |
  "partial_pagination_after_upstream" | "schema_missing_properties_after_upstream";

export interface NotionFaultRule {
  id: string;
  method: string;
  pattern: RegExp;
  action: NotionFaultAction;
  times: number;
  after: number;
  status?: number;
  retryAfter?: string;
}

export function createNotionFaultProxy(options: {
  rules: NotionFaultRule[];
  evidencePath: string;
  fetcher?: typeof fetch;
}): Server;
