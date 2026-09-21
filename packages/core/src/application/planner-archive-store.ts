import type {
  FocusRecord,
  RecurrenceSeries,
  Task,
} from "../domain/planner-model";
import type { PlannerStore } from "./planner-store";
import type { InboxItem, LifeFolder, LifeResource, ResourceTaskLink } from "../domain/life-model";

export type PlannerArchiveData = {
  tasks: readonly Task[];
  recurrenceSeries?: readonly RecurrenceSeries[];
  focusRecords?: readonly FocusRecord[];
  inboxItems?: readonly InboxItem[];
  folders?: readonly LifeFolder[];
  resources?: readonly LifeResource[];
  resourceTaskLinks?: readonly ResourceTaskLink[];
};

export interface PlannerArchiveStore extends PlannerStore {
  replaceAllData(data: PlannerArchiveData): Promise<void>;
  listAllInboxItems?(): Promise<InboxItem[]>;
  listAllFolders?(): Promise<LifeFolder[]>;
  listAllResources?(): Promise<LifeResource[]>;
  listAllResourceTaskLinks?(): Promise<ResourceTaskLink[]>;
}
