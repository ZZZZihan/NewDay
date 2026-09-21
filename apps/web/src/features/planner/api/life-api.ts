import type { InboxItem, LifeFolder, LifeResource, LifeWorkspace } from "@newday/core/domain/life-model";
import type { Task } from "@newday/core/domain/planner-model";
import { request } from "@/shared/http/request";

function post<T>(path: string, body: unknown = {}) {
  return request<T>(`/api/life${path}`, { method: "POST", body: JSON.stringify(body) });
}

export const lifeApi = {
  workspace(signal?: AbortSignal) { return request<LifeWorkspace>("/api/life/workspace", { signal }); },
  capture(title: string, notes: string, sourceResourceId: string | null = null) {
    return post<InboxItem>("/inbox", { title, notes, sourceResourceId });
  },
  discard(id: string) { return post<{ ok: true }>(`/inbox/${encodeURIComponent(id)}/discard`); },
  toTask(id: string, startDate: string, endDate: string) {
    return post<Task>(`/inbox/${encodeURIComponent(id)}/task`, { startDate, endDate });
  },
  toResource(id: string, folderId: string | null, kind: "note" | "link", source: string) {
    return post<LifeResource>(`/inbox/${encodeURIComponent(id)}/resource`, { folderId, kind, source });
  },
  createFolder(parentId: string | null, name: string) {
    return post<LifeFolder>("/folders", { parentId, name });
  },
  renameFolder(id: string, name: string) {
    return post<LifeFolder>(`/folders/${encodeURIComponent(id)}/rename`, { name });
  },
  createResource(input: ResourceInput) { return post<LifeResource>("/resources", input); },
  updateResource(id: string, input: ResourceInput) {
    return post<LifeResource>(`/resources/${encodeURIComponent(id)}/update`, input);
  },
  link(resourceId: string, taskId: string) {
    return post<{ ok: true }>(`/resources/${encodeURIComponent(resourceId)}/links`, { taskId });
  },
  unlink(resourceId: string, taskId: string) {
    return post<{ ok: true }>(`/resources/${encodeURIComponent(resourceId)}/links/${encodeURIComponent(taskId)}/remove`);
  },
};

export type ResourceInput = Pick<LifeResource, "folderId" | "kind" | "title" | "content" | "source">;
