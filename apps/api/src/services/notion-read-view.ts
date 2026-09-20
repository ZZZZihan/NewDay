import type { NotionTaskAttribution } from "@newday/core/domain/planner-model";
import type { SQLitePlannerStore } from "../storage/sqlite-planner-store.js";

export async function notionAttributions(store: SQLitePlannerStore): Promise<Record<string, NotionTaskAttribution>> {
  const [mappings, contexts, nodes] = await Promise.all([
    store.listNotionTaskMappings(), store.listNotionReadTaskContexts(), store.listNotionReadNodes(),
  ]);
  const contextByTask = new Map(contexts.map((context) => [context.localTaskId, context]));
  const nodeByIdentity = new Map(nodes.map((node) => [`${node.workspaceId}:${node.remotePageId}`, node]));
  const result: Record<string, NotionTaskAttribution> = {};
  for (const mapping of mappings) {
    const context = contextByTask.get(mapping.localTaskId);
    const area = context?.areaPageId ? nodeByIdentity.get(`${mapping.workspaceId}:${context.areaPageId}`) : undefined;
    const project = context?.projectPageId ? nodeByIdentity.get(`${mapping.workspaceId}:${context.projectPageId}`) : undefined;
    result[mapping.localTaskId] = {
      workspaceId: mapping.workspaceId, url: context?.url ?? null,
      areaName: area?.title ?? null, projectName: project?.title ?? null, projectUrl: project?.url ?? null,
    };
  }
  return result;
}
