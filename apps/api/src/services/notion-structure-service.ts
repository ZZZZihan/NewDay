import { createHash, randomBytes } from "node:crypto";

import type { NotionConnection, NotionInitializationStep, NotionInitializationStepName } from "@newday/core/contracts/notion-sync";

import { ApiError } from "../http/api-error.js";
import type { SQLitePlannerStore } from "../storage/sqlite-planner-store.js";
import type { NotionCredentialVault } from "../storage/notion-credential-vault.js";
import type { NotionStructureGateway, StructureProperty } from "./notion-structure-gateway.js";

type TableName = "areas" | "projects" | "tasks" | "rules";
type RelationName = "projects_area" | "tasks_project" | "tasks_direct_area" | "tasks_rule";
type ReviewReason = NonNullable<NotionInitializationStep["reviewReason"]>;

const tableOrder: TableName[] = ["areas", "projects", "tasks", "rules"];
const relationOrder: RelationName[] = ["projects_area", "tasks_project", "tasks_direct_area", "tasks_rule"];
const stepOrder: NotionInitializationStepName[] = ["root", ...tableOrder, ...relationOrder];

const tableSchemas: Record<TableName, { title: string; properties: Record<string, unknown>; expected: Record<string, { type: string; options?: string[] }> }> = {
  areas: { title: "Areas", properties: { Name: { title: {} } }, expected: { Name: { type: "title" } } },
  projects: { title: "Projects", properties: { Name: { title: {} } }, expected: { Name: { type: "title" } } },
  tasks: {
    title: "Tasks",
    properties: { Name: { title: {} }, "Plan Date": { date: {} }, Completed: { checkbox: {} },
      "NewDay Key": { rich_text: {} }, "Occurrence Key": { rich_text: {} } },
    expected: { Name: { type: "title" }, "Plan Date": { type: "date" }, Completed: { type: "checkbox" },
      "NewDay Key": { type: "rich_text" }, "Occurrence Key": { type: "rich_text" } },
  },
  rules: {
    title: "Rules",
    properties: { Name: { title: {} }, "Active Dates": { date: {} },
      Pattern: { select: { options: ["daily", "weekdays", "weekly", "monthly"].map((name) => ({ name })) } },
      Weekdays: { multi_select: { options: ["1", "2", "3", "4", "5", "6", "7"].map((name) => ({ name })) } },
      "Month Day": { number: {} }, "Excluded Dates": { rich_text: {} } },
    expected: { Name: { type: "title" }, "Active Dates": { type: "date" },
      Pattern: { type: "select", options: ["daily", "weekdays", "weekly", "monthly"] },
      Weekdays: { type: "multi_select", options: ["1", "2", "3", "4", "5", "6", "7"] },
      "Month Day": { type: "number" }, "Excluded Dates": { type: "rich_text" } },
  },
};

const relations: Record<RelationName, { source: TableName; name: string; target: TableName }> = {
  projects_area: { source: "projects", name: "Area", target: "areas" },
  tasks_project: { source: "tasks", name: "Project", target: "projects" },
  tasks_direct_area: { source: "tasks", name: "Direct Area", target: "areas" },
  tasks_rule: { source: "tasks", name: "Rule", target: "rules" },
};

export type NotionStructureProgress = {
  workspaceId: string;
  state: "not_started" | "in_progress" | "needs_review" | "ready" | "paused_after_restore" | "disconnected";
  nextStep: NotionInitializationStepName | null;
  reviewReason: ReviewReason | null;
  retryAfterAt: string | null;
  rootPageId: string | null;
  dataSources: NotionConnection["dataSources"];
  completedSteps: NotionInitializationStepName[];
};

/** One mutation per request keeps each browser/API request bounded. After an
 * ambiguous create, subsequent requests only read remote state. */
export class NotionStructureService {
  private readonly workspaceTails = new Map<string, Promise<void>>();

  constructor(
    private readonly store: SQLitePlannerStore,
    private readonly vault: NotionCredentialVault,
    private readonly gateway: NotionStructureGateway,
    private readonly now: () => number = Date.now,
  ) {}

  async progress(workspaceId: string): Promise<NotionStructureProgress> {
    const connection = await this.store.getNotionConnection(workspaceId);
    const steps = await this.store.listNotionInitializationSteps(workspaceId);
    const nextStep = stepOrder.find((step) => !steps.some((value) => value.step === step && value.status === "confirmed")) ?? null;
    const next = steps.find((value) => value.step === nextStep);
    const state = !connection ? "not_started" : connection.status === "paused_after_restore" ? "paused_after_restore"
      : connection.status === "disconnected" ? "disconnected"
        : next?.status === "needs_review" ? "needs_review"
          : nextStep === null ? "ready" : "in_progress";
    return {
      workspaceId, state, nextStep, reviewReason: next?.reviewReason ?? null,
      retryAfterAt: next?.retryAfterAt ?? null,
      rootPageId: connection?.rootPageId ?? null, dataSources: connection?.dataSources ?? {},
      completedSteps: stepOrder.filter((step) => steps.some((value) => value.step === step && value.status === "confirmed")),
    };
  }

  async advance(workspaceId: string): Promise<NotionStructureProgress> {
    return this.withWorkspaceLock(workspaceId, () => this.advanceLocked(workspaceId));
  }

  private async advanceLocked(workspaceId: string): Promise<NotionStructureProgress> {
    const credential = this.vault.getCredential(workspaceId);
    if (!credential) throw new ApiError(409, "Notion 工作区尚未授权或凭据刷新结果待确认");
    const connection = await this.store.transaction(async () => {
      let current = await this.store.getNotionConnection(workspaceId);
      if (current?.status === "paused_after_restore" || current?.status === "paused_unknown") {
        throw new ApiError(409, "Notion 数据恢复或未知写入仍待核对，不能初始化结构");
      }
      if (!current) {
        current = { workspaceId, installationId: randomBytes(16).toString("hex"), rootPageId: null,
          dataSources: {}, status: "paused", updatedAt: this.timestamp() };
        await this.store.putNotionConnection(current);
      } else if (current.status === "disconnected") {
        if ((await this.store.listNotionInitializationSteps(workspaceId)).length > 0) {
          throw new ApiError(409, "断开后已有结构需人工核对，不能直接继续初始化");
        }
        current = { ...current, status: "paused", updatedAt: this.timestamp() };
        await this.store.putNotionConnection(current);
      }
      return current;
    });
    const progress = await this.progress(workspaceId);
    if (!progress.nextStep) return progress;
    if (progress.retryAfterAt && Date.parse(progress.retryAfterAt) > this.now()) return progress;
    const token = credential.access_token;
    const step = progress.nextStep;
    if (step === "root") await this.advanceRoot(connection, token);
    else if (tableOrder.includes(step as TableName)) await this.advanceTable(connection, token, step as TableName);
    else await this.advanceRelation(connection, token, step as RelationName);
    return this.progress(workspaceId);
  }

  async disconnect(workspaceId: string): Promise<boolean> {
    return this.withWorkspaceLock(workspaceId, async () => {
      const removed = this.vault.disconnect(workspaceId);
      const connection = await this.store.getNotionConnection(workspaceId);
      if (connection) await this.store.putNotionConnection({ ...connection, status: "disconnected", updatedAt: this.timestamp() });
      return removed;
    });
  }

  private async withWorkspaceLock<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.workspaceTails.get(workspaceId);
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.workspaceTails.set(workspaceId, tail);
    if (previous) await previous;
    try { return await operation(); }
    finally {
      release();
      if (this.workspaceTails.get(workspaceId) === tail) this.workspaceTails.delete(workspaceId);
    }
  }

  private async advanceRoot(connection: NotionConnection, token: string): Promise<void> {
    const title = `NewDay (${connection.installationId})`;
    const { step, created } = await this.recordAttempt(connection.workspaceId, "root", title, null,
      fingerprint({ kind: "workspace-page", title }));
    try {
      const id = created ? await this.gateway.createRoot(token, title) : null;
      const candidateIds = [...new Set([...(id ? [id] : []), ...await this.gateway.findRoots(token, title)])];
      const matches = [];
      for (const candidateId of candidateIds) {
        const page = await this.gateway.getRoot(token, candidateId);
        if (page.title === title && page.workspaceParent) matches.push(page.id);
      }
      if (matches.length !== 1) return this.markReview(step, matches.length > 1 ? "ambiguous" : "not_found");
      await this.confirm(step, matches[0], undefined);
    } catch (error) { await this.markReview(step, classifyRemoteFailure(error), error); }
  }

  private async advanceTable(connection: NotionConnection, token: string, name: TableName): Promise<void> {
    if (!connection.rootPageId) throw new ApiError(409, "Notion 根页面尚未确认");
    const schema = tableSchemas[name];
    const { step, created } = await this.recordAttempt(connection.workspaceId, name, schema.title, connection.rootPageId,
      fingerprint({ kind: "data-source", name, schema: schema.expected }));
    try {
      if (created) {
        // The first call has not sent a create yet. A same-title child may be a
        // previous human or uncertain app creation; require explicit readback
        // before this installation can adopt it or create another one.
        for (const candidateId of await this.gateway.listChildDatabases(token, connection.rootPageId)) {
          const candidate = await this.gateway.getDatabase(token, candidateId);
          if (candidate.title === schema.title && candidate.parentPageId === connection.rootPageId) {
            await this.markReview(step, "ambiguous");
            return;
          }
        }
      }
      const id = created ? await this.gateway.createDatabase(token, connection.rootPageId, schema.title, schema.properties) : null;
      const candidateIds = [...new Set([...(id ? [id] : []),
        ...await this.gateway.listChildDatabases(token, connection.rootPageId)])];
      const matchingTitle: Array<{ id: string; dataSourceId: string; propertyIds: Record<string, string> }> = [];
      let sameTitleCount = 0;
      let invalidSchema = false;
      for (const candidateId of candidateIds) {
        const database = await this.gateway.getDatabase(token, candidateId);
        if (database.title !== schema.title || database.parentPageId !== connection.rootPageId) continue;
        sameTitleCount += 1;
        if (database.dataSourceIds.length !== 1) { invalidSchema = true; continue; }
        const dataSourceId = database.dataSourceIds[0];
        const properties = await this.gateway.getDataSourceProperties(token, dataSourceId);
        const propertyIds = basePropertyIds(properties, schema.expected);
        if (propertyIds) matchingTitle.push({ id: database.id, dataSourceId, propertyIds });
        else invalidSchema = true;
      }
      if (sameTitleCount !== 1 || matchingTitle.length !== 1 || invalidSchema) {
        await this.markReview(step, sameTitleCount > 1 ? "ambiguous" : invalidSchema ? "schema_mismatch" : "not_found");
        return;
      }
      const remote = matchingTitle[0];
      await this.confirm(step, remote.id, { table: name, dataSourceId: remote.dataSourceId, propertyIds: remote.propertyIds });
    } catch (error) { await this.markReview(step, classifyRemoteFailure(error), error); }
  }

  private async advanceRelation(connection: NotionConnection, token: string, name: RelationName): Promise<void> {
    const relation = relations[name];
    const source = connection.dataSources[relation.source];
    const target = connection.dataSources[relation.target];
    if (!source || !target) throw new ApiError(409, "Notion 关联目标尚未确认");
    const { step, created } = await this.recordAttempt(connection.workspaceId, name, relation.name, source.dataSourceId,
      fingerprint({ kind: "relation", name: relation.name, target: target.dataSourceId }));
    try {
      if (created) {
        const existing = (await this.gateway.getDataSourceProperties(token, source.dataSourceId))[relation.name];
        if (existing && (existing.type !== "relation" || existing.relationTarget !== target.dataSourceId)) {
          await this.markReview(step, "schema_mismatch");
          return;
        }
        if (!existing) await this.gateway.addRelation(token, source.dataSourceId, relation.name, target.dataSourceId);
      }
      const property = (await this.gateway.getDataSourceProperties(token, source.dataSourceId))[relation.name];
      if (!property || property.type !== "relation" || property.relationTarget !== target.dataSourceId) {
        await this.markReview(step, "schema_mismatch");
        return;
      }
      await this.confirm(step, property.id, { table: relation.source, propertyName: relation.name });
    } catch (error) { await this.markReview(step, classifyRemoteFailure(error), error); }
  }

  private async recordAttempt(workspaceId: string, name: NotionInitializationStepName, expectedTitle: string,
    parentId: string | null, schemaFingerprint: string): Promise<{ step: NotionInitializationStep; created: boolean }> {
    return this.store.transaction(async () => {
      const existing = await this.store.getNotionInitializationStep(workspaceId, name);
      if (existing) {
        if (existing.expectedTitle !== expectedTitle || existing.parentId !== parentId ||
          existing.schemaFingerprint !== schemaFingerprint) throw new ApiError(409, "Notion 初始化契约已改变，需要人工核对");
        return { step: existing, created: false };
      }
      const step: NotionInitializationStep = { workspaceId, step: name, expectedTitle, parentId, schemaFingerprint,
        status: "attempted", reviewReason: null, attemptedAt: this.timestamp(), confirmedAt: null, remoteId: null };
      await this.store.putNotionInitializationStep(step);
      return { step, created: true };
    });
  }

  private async markReview(step: NotionInitializationStep, reason: ReviewReason, error?: unknown): Promise<void> {
    await this.store.transaction(async () => {
      const current = await this.store.getNotionInitializationStep(step.workspaceId, step.step);
      if (!current || current.status === "confirmed" || current.attemptedAt !== step.attemptedAt) return;
      await this.store.putNotionInitializationStep({ ...current, status: "needs_review", reviewReason: reason,
        retryAfterAt: reason === "rate_limited" ? retryAfterAt(error, this.now()) : null });
    });
  }

  private async confirm(step: NotionInitializationStep, remoteId: string,
    details?: { table: TableName; dataSourceId: string; propertyIds: Record<string, string> } |
      { table: TableName; propertyName: string }): Promise<void> {
    await this.store.transaction(async () => {
      const current = await this.store.getNotionConnection(step.workspaceId);
      if (!current) throw new Error("Notion initialization workspace disappeared");
      if (current.status === "paused_after_restore" || current.status === "paused_unknown") {
        throw new ApiError(409, "Notion 结构在扫描期间被恢复或暂停，不能确认本次写入");
      }
      const next: NotionConnection = { ...current, dataSources: { ...current.dataSources }, updatedAt: this.timestamp() };
      if (step.step === "root") {
        if (next.rootPageId && next.rootPageId !== remoteId) throw new Error("Notion root identity changed");
        next.rootPageId = remoteId;
      } else if (details && "dataSourceId" in details) {
        const previous = next.dataSources[details.table];
        if (previous && (previous.databaseId !== remoteId || previous.dataSourceId !== details.dataSourceId)) {
          throw new Error("Notion data source identity changed");
        }
        next.dataSources[details.table] = { databaseId: remoteId, dataSourceId: details.dataSourceId,
          propertyIds: details.propertyIds, schemaFingerprint: step.schemaFingerprint };
      } else if (details && "propertyName" in details) {
        const previous = next.dataSources[details.table];
        if (!previous) throw new Error("Notion relation source disappeared");
        const priorId = previous.propertyIds[details.propertyName];
        if (priorId && priorId !== remoteId) throw new Error("Notion relation identity changed");
        next.dataSources[details.table] = { ...previous,
          propertyIds: { ...previous.propertyIds, [details.propertyName]: remoteId } };
      }
      const existing = await this.store.getNotionInitializationStep(step.workspaceId, step.step);
      if (!existing || existing.attemptedAt !== step.attemptedAt) throw new Error("Notion initialization attempt changed");
      await this.store.putNotionInitializationStep({ ...step, status: "confirmed", reviewReason: null,
        retryAfterAt: null, confirmedAt: this.timestamp(), remoteId });
      const confirmed = await this.store.listNotionInitializationSteps(step.workspaceId);
      if (next.status !== "disconnected" && stepOrder.every((name) => confirmed.some((value) => value.step === name && value.status === "confirmed"))) {
        next.status = "active";
      }
      await this.store.putNotionConnection(next);
    });
  }

  private timestamp(): string { return new Date(this.now()).toISOString(); }
}

function basePropertyIds(actual: Record<string, StructureProperty>, expected: Record<string, { type: string; options?: string[] }>): Record<string, string> | null {
  const ids: Record<string, string> = {};
  for (const [name, property] of Object.entries(expected)) {
    const found = actual[name];
    if (!found || found.type !== property.type || !found.id ||
      (property.options && (!found.options || property.options.some((option) => !found.options!.includes(option))))) return null;
    ids[name] = found.id;
  }
  return ids;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function classifyRemoteFailure(error: unknown): ReviewReason {
  const status = error && typeof error === "object" && "status" in error ? Number(error.status) : NaN;
  if (status === 401 || status === 403) return "permission";
  if (status === 429 || status === 529) return "rate_limited";
  if (status === 404) return "unreadable";
  if (status === 400) return "schema_mismatch";
  return "request_unknown";
}

function retryAfterAt(error: unknown, now: number): string {
  const headers = error && typeof error === "object" && "headers" in error ? error.headers : null;
  const raw = headers && typeof headers === "object" && "get" in headers && typeof headers.get === "function"
    ? String(headers.get("retry-after") ?? "") : "";
  const seconds = /^\d+$/.test(raw) ? Number(raw) : NaN;
  const date = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(raw);
  return new Date(Number.isFinite(date) && date > now ? date : now + 5000).toISOString();
}
