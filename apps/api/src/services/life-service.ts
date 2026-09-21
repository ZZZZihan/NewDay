import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { executePlannerCommands } from "@newday/core/application/planner-command";
import type { InboxItem, LifeFolder, LifeResource, LifeWorkspace } from "@newday/core/domain/life-model";
import { ApiError } from "../http/api-error.js";
import { SQLitePlannerStore } from "../storage/sqlite-planner-store.js";
import { notionAttributions } from "./notion-read-view.js";

export class LifeService {
  constructor(private readonly store: SQLitePlannerStore, private readonly clock: () => number = Date.now) {}

  workspace(): Promise<LifeWorkspace> {
    return this.store.transaction(async () => {
      const [inboxItems, folders, resources, resourceTaskLinks, tasks] = await Promise.all([
        this.store.listAllInboxItems(), this.store.listAllFolders(), this.store.listAllResources(),
        this.store.listAllResourceTaskLinks(), this.store.listAllTasks(),
      ]);
      return { inboxItems, folders, resources, resourceTaskLinks, tasks,
        notionByTaskId: await notionAttributions(this.store) };
    });
  }

  capture(input: { title: string; notes: string; sourceResourceId?: string | null }) {
    return this.store.transaction(async () => {
      if (input.sourceResourceId && !await this.store.getResource(input.sourceResourceId)) {
        throw new ApiError(404, "来源资料不存在");
      }
      const now = this.now();
      const item: InboxItem = { id: randomUUID(), title: input.title, notes: input.notes,
        sourceResourceId: input.sourceResourceId ?? null, createdAt: now, updatedAt: now };
      await this.store.putInboxItem(item);
      return item;
    });
  }

  removeInbox(id: string) {
    return this.store.transaction(async () => {
      if (!await this.store.getInboxItem(id)) throw new ApiError(404, "收集箱条目不存在");
      await this.store.deleteInboxItem(id);
      return { ok: true as const };
    });
  }

  toTask(id: string, input: { startDate: string; endDate: string }) {
    return this.store.transaction(async () => {
      const item = await this.store.getInboxItem(id);
      if (!item) throw new ApiError(404, "收集箱条目不存在");
      const taskId = randomUUID();
      await executePlannerCommands(this.store, [{ type: "createTask", input: {
        id: taskId, title: item.title, notes: item.notes,
        startDate: input.startDate, endDate: input.endDate, now: this.now(),
      } }]);
      if (item.sourceResourceId) {
        await this.store.putResourceTaskLink({ resourceId: item.sourceResourceId, taskId });
      }
      await this.store.deleteInboxItem(id);
      return (await this.store.getTask(taskId))!;
    });
  }

  toResource(id: string, input: { folderId: string | null; kind: "note" | "link"; source: string }) {
    return this.store.transaction(async () => {
      const item = await this.store.getInboxItem(id);
      if (!item) throw new ApiError(404, "收集箱条目不存在");
      await this.requireFolder(input.folderId);
      const now = this.now();
      const resource: LifeResource = { id: randomUUID(), folderId: input.folderId, kind: input.kind,
        title: item.title, content: item.notes, source: input.source, createdAt: now, updatedAt: now };
      await this.store.putResource(resource);
      await this.store.deleteInboxItem(id);
      return resource;
    });
  }

  createFolder(input: { parentId: string | null; name: string }) {
    return this.store.transaction(async () => {
      await this.requireParent(input.parentId);
      await this.assertNameAvailable(input.parentId, input.name);
      const now = this.now();
      const folder: LifeFolder = { id: randomUUID(), parentId: input.parentId, name: input.name,
        createdAt: now, updatedAt: now };
      await this.store.putFolder(folder);
      return folder;
    });
  }

  renameFolder(id: string, name: string) {
    return this.store.transaction(async () => {
      const folder = await this.store.getFolder(id);
      if (!folder) throw new ApiError(404, "文件夹不存在");
      await this.assertNameAvailable(folder.parentId, name, id);
      const updated = { ...folder, name, updatedAt: this.now() };
      await this.store.putFolder(updated);
      return updated;
    });
  }

  createResource(input: { folderId: string | null; kind: "note" | "link"; title: string; content: string; source: string }) {
    return this.store.transaction(async () => {
      await this.requireFolder(input.folderId);
      const now = this.now();
      const resource: LifeResource = { id: randomUUID(), ...input, createdAt: now, updatedAt: now };
      await this.store.putResource(resource);
      return resource;
    });
  }

  updateResource(
    id: string,
    input: { folderId: string | null; kind: "note" | "link"; title: string; content: string; source: string },
    expectedResource: LifeResource,
  ) {
    return this.store.transaction(async () => {
      const resource = await this.store.getResource(id);
      if (!resource) throw new ApiError(404, "资料不存在");
      if (expectedResource.id !== id || !isDeepStrictEqual(resource, expectedResource)) {
        throw new ApiError(409, "资料已在其他页面或后台更新；请关闭编辑窗口后重新打开");
      }
      await this.requireFolder(input.folderId);
      const updated: LifeResource = { ...resource, ...input, updatedAt: this.now() };
      await this.store.putResource(updated);
      return updated;
    });
  }

  link(resourceId: string, taskId: string) {
    return this.store.transaction(async () => {
      if (!await this.store.getResource(resourceId)) throw new ApiError(404, "资料不存在");
      if (!await this.store.getTask(taskId)) throw new ApiError(404, "任务不存在");
      await this.store.putResourceTaskLink({ resourceId, taskId });
      return { ok: true as const };
    });
  }

  unlink(resourceId: string, taskId: string) {
    return this.store.transaction(async () => {
      await this.store.deleteResourceTaskLink({ resourceId, taskId });
      return { ok: true as const };
    });
  }

  private async requireFolder(id: string | null) {
    if (id && !await this.store.getFolder(id)) throw new ApiError(400, "目标文件夹不存在");
  }

  private async requireParent(id: string | null) {
    if (!id) return;
    const parent = await this.store.getFolder(id);
    if (!parent) throw new ApiError(400, "上级文件夹不存在");
    if (parent.parentId !== null) throw new ApiError(400, "文件夹最多两级");
  }

  private async assertNameAvailable(parentId: string | null, name: string, exceptId?: string) {
    const folders = await this.store.listAllFolders();
    if (folders.some((folder) => folder.id !== exceptId && folder.parentId === parentId &&
      folder.name.localeCompare(name, undefined, { sensitivity: "base" }) === 0)) {
      throw new ApiError(409, "同级文件夹名称已存在");
    }
  }

  private now() { return new Date(this.clock()).toISOString(); }
}
