import { z } from "zod";
import { instantSchema } from "./planner-model";
import type { Task } from "./planner-model";

const id = z.string().min(1).max(512);
const title = z.string().trim().min(1).max(200);
const notes = z.string().max(10_000);

export const inboxItemSchema = z.strictObject({
  id,
  title,
  notes,
  sourceResourceId: id.nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});

export const lifeFolderSchema = z.strictObject({
  id,
  parentId: id.nullable(),
  name: z.string().trim().min(1).max(80),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});

export const lifeResourceSchema = z.strictObject({
  id,
  folderId: id.nullable(),
  kind: z.enum(["note", "link"]),
  title,
  content: notes,
  source: z.string().max(1_000),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});

export const resourceTaskLinkSchema = z.strictObject({
  resourceId: id,
  taskId: id,
});

export type InboxItem = z.infer<typeof inboxItemSchema>;
export type LifeFolder = z.infer<typeof lifeFolderSchema>;
export type LifeResource = z.infer<typeof lifeResourceSchema>;
export type ResourceTaskLink = z.infer<typeof resourceTaskLinkSchema>;
export type LifeWorkspace = {
  inboxItems: InboxItem[];
  folders: LifeFolder[];
  resources: LifeResource[];
  resourceTaskLinks: ResourceTaskLink[];
  tasks: Task[];
};
