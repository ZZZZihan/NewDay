import { Client, iterateAllDataSourceRows, isHTTPResponseError, type PageObjectResponse } from "@notionhq/client";
import { notionPlanDateSchema, type NotionConnection } from "@newday/core/contracts/notion-sync";

export type ReadTable = "areas" | "projects" | "tasks";
type RowBase = { id: string; url: string; createdAt: string; editedAt: string; inTrash: boolean };
export type AreaRow = RowBase & { kind: "area"; title: string };
export type ProjectRow = RowBase & { kind: "project"; title: string; areaIds: string[] };
export type TaskRow = RowBase & {
  kind: "task"; title: string; date: [string, string] | null; completed: boolean;
  projectIds: string[]; directAreaIds: string[]; ruleIds: string[]; clientKey: string | null;
  occurrenceKey: string | null;
};
export type ReadRow = AreaRow | ProjectRow | TaskRow;

export class NotionReadFailure extends Error {
  constructor(public readonly category: "authorization" | "permission" | "rate_limited" | "schema" | "incomplete" | "network" | "remote", message: string) {
    super(message);
  }
}

export interface NotionReadGateway {
  scan(token: string, connection: NotionConnection, table: ReadTable): Promise<ReadRow[]>;
  readKnownPage(token: string, pageId: string): Promise<{ id: string; inTrash: boolean } | null>;
}

/** The SDK helper partitions results beyond Notion's 10,000-row query limit
 * by created_time and de-duplicates boundary rows. We buffer every result so
 * a failed page or property read never applies a partial scan. */
export class NotionSdkReadGateway implements NotionReadGateway {
  constructor(private readonly pause: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds))) {}

  private client(token: string) {
    return new Client({ auth: token, notionVersion: "2026-03-11", retry: false, timeoutMs: 15_000 });
  }

  async scan(token: string, connection: NotionConnection, table: ReadTable): Promise<ReadRow[]> {
    return this.retryRead(async () => {
      const ref = connection.dataSources[table];
      if (!ref) throw new NotionReadFailure("schema", `Notion ${table} data source is not initialized`);
      const client = this.client(token);
      if (table === "tasks") await assertRuleSourceReadable(client, connection);
      await validateSchema(client, connection, table);
      const rows: ReadRow[] = [];
      const seen = new Set<string>();
      try {
        for await (const raw of iterateAllDataSourceRows(client, { data_source_id: ref.dataSourceId, page_size: 100, result_type: "page" })) {
          if (raw.object !== "page" || !("properties" in raw) || !("parent" in raw) || !("created_time" in raw)) {
            throw new NotionReadFailure("incomplete", "Notion returned a partial or non-page data source row");
          }
          if (raw.parent.type !== "data_source_id" || raw.parent.data_source_id !== ref.dataSourceId) {
            throw new NotionReadFailure("schema", "Notion row has a different data source parent");
          }
          if (seen.has(raw.id)) continue;
          seen.add(raw.id);
          rows.push(await parseRow(client, raw, table, ref.propertyIds));
        }
      } catch (error) {
        if (error instanceof NotionReadFailure) throw error;
        if (error instanceof Error && error.message.includes("iterateAllDataSourceRows cannot make progress")) {
          throw new NotionReadFailure("incomplete", "Notion query reached its result limit within one created-time window");
        }
        throw error;
      }
      return rows;
    });
  }

  async readKnownPage(token: string, pageId: string): Promise<{ id: string; inTrash: boolean } | null> {
    return this.retryRead(async () => {
      const page = await this.client(token).pages.retrieve({ page_id: pageId });
      if (!("in_trash" in page)) throw new NotionReadFailure("incomplete", "Notion returned a partial known page");
      return { id: page.id, inTrash: page.in_trash };
    });
  }

  private async retryRead<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await operation(); }
      catch (error) {
        if (isHTTPResponseError(error) && (error.status === 429 || error.status === 529) && attempt < 2) {
          const headers = error.headers;
          const rawRetryAfter = headers && typeof headers === "object" && "get" in headers &&
            typeof headers.get === "function" ? headers.get("retry-after") : null;
          const retryAfter = typeof rawRetryAfter === "string" && rawRetryAfter.trim() !== ""
            ? Number(rawRetryAfter) : NaN;
          const delay = Number.isFinite(retryAfter) && retryAfter >= 0
            ? retryAfter * 1000 : Math.min(8_000, 1000 * 2 ** attempt);
          if (delay > 2_147_483_647) throw new NotionReadFailure("rate_limited", "Notion retry delay exceeds the supported timer range");
          await this.pause(delay + Math.floor(Math.random() * 200));
          continue;
        }
        if (error instanceof NotionReadFailure) throw error;
        if (isHTTPResponseError(error)) {
          const category = error.status === 401 ? "authorization" : error.status === 403 ? "permission"
            : error.status === 429 || error.status === 529 ? "rate_limited"
              : error.status === 400 || error.status === 404 ? "schema" : "remote";
          throw new NotionReadFailure(category, `Notion read failed with HTTP ${error.status}`);
        }
        throw new NotionReadFailure("network", "Notion read did not complete");
      }
    }
    throw new NotionReadFailure("remote", "Notion read did not complete");
  }
}

export async function assertRuleSourceReadable(client: Client, connection: NotionConnection): Promise<void> {
  const ruleId = connection.dataSources.rules?.dataSourceId;
  if (!ruleId) throw new NotionReadFailure("schema", "Notion Rules data source is not initialized");
  const response = await client.dataSources.retrieve({ data_source_id: ruleId });
  if (!("properties" in response) || !Object.values(response.properties).some((property) =>
    property.id === connection.dataSources.rules?.propertyIds.Name && property.type === "title")) {
    throw new NotionReadFailure("schema", "Notion Rules data source is not readable with the expected schema");
  }
  // A data source schema can be visible while querying its rows is denied.
  await client.dataSources.query({ data_source_id: ruleId, page_size: 1 });
}

async function validateSchema(client: Client, connection: NotionConnection, table: ReadTable): Promise<void> {
  const ref = connection.dataSources[table]!;
  const response = await client.dataSources.retrieve({ data_source_id: ref.dataSourceId });
  if (!("properties" in response)) throw new NotionReadFailure("schema", "Notion data source schema is incomplete");
  const expected: Record<ReadTable, Record<string, { type: string; target?: string }>> = {
    areas: { Name: { type: "title" } },
    projects: { Name: { type: "title" }, Area: { type: "relation", target: connection.dataSources.areas?.dataSourceId } },
    tasks: {
      Name: { type: "title" }, "Plan Date": { type: "date" }, Completed: { type: "checkbox" },
      Project: { type: "relation", target: connection.dataSources.projects?.dataSourceId },
      "Direct Area": { type: "relation", target: connection.dataSources.areas?.dataSourceId },
      Rule: { type: "relation", target: connection.dataSources.rules?.dataSourceId },
      "NewDay Key": { type: "rich_text" },
      "Occurrence Key": { type: "rich_text" },
    },
  };
  const properties = Object.values(response.properties);
  for (const [name, specification] of Object.entries(expected[table])) {
    const id = ref.propertyIds[name];
    const property = properties.find((value) => value.id === id);
    if (!property || property.type !== specification.type ||
      (specification.target && (property.type !== "relation" || property.relation.data_source_id !== specification.target))) {
      throw new NotionReadFailure("schema", `Notion ${table} property ${name} changed type or relation target`);
    }
  }
}

export async function parseRow(client: Client, page: PageObjectResponse, table: ReadTable,
  propertyIds: Record<string, string>): Promise<ReadRow> {
  const base = { id: page.id, url: page.url, createdAt: page.created_time,
    editedAt: page.last_edited_time, inTrash: page.in_trash };
  const prop = (name: string, type: string) => {
    const id = propertyIds[name];
    const value = Object.values(page.properties).find((item) => item.id === id);
    if (!value || value.type !== type) throw new NotionReadFailure("schema", `Notion property ${name} is unavailable or changed type`);
    return value;
  };
  const title = await fullText(client, page.id, propertyIds.Name, prop("Name", "title"), "title");
  if (!title.trim() || title.length > 200) throw new NotionReadFailure("schema", "Notion row title is empty or longer than 200 characters");
  if (table === "areas") return { ...base, kind: "area", title };
  if (table === "projects") return { ...base, kind: "project", title,
    areaIds: await relations(client, page.id, propertyIds.Area, prop("Area", "relation")) };
  const dateProperty = prop("Plan Date", "date");
  if (dateProperty.type !== "date") throw new NotionReadFailure("schema", "Notion date property changed type");
  const rawDate = dateProperty.date;
  const parsedDate = rawDate ? notionPlanDateSchema.safeParse([rawDate.start, rawDate.end ?? rawDate.start]) : null;
  if (parsedDate && !parsedDate.success) throw new NotionReadFailure("schema", "Notion Plan Date must use date-only values in an ordered range");
  const date = parsedDate?.data ?? null;
  const completedProperty = prop("Completed", "checkbox");
  if (completedProperty.type !== "checkbox") throw new NotionReadFailure("schema", "Notion completed property changed type");
  const key = await fullText(client, page.id, propertyIds["NewDay Key"], prop("NewDay Key", "rich_text"), "rich_text");
  const occurrenceKey = await fullText(client, page.id, propertyIds["Occurrence Key"],
    prop("Occurrence Key", "rich_text"), "rich_text");
  return { ...base, kind: "task", title, date, completed: completedProperty.checkbox,
    projectIds: await relations(client, page.id, propertyIds.Project, prop("Project", "relation")),
    directAreaIds: await relations(client, page.id, propertyIds["Direct Area"], prop("Direct Area", "relation")),
    ruleIds: await relations(client, page.id, propertyIds.Rule, prop("Rule", "relation")),
    clientKey: key || null, occurrenceKey: occurrenceKey || null };
}

async function fullText(client: Client, pageId: string, propertyId: string, value: unknown,
  kind: "title" | "rich_text"): Promise<string> {
  const object = asRecord(value);
  const inline = object[kind];
  if (!Array.isArray(inline)) throw new NotionReadFailure("schema", `Notion ${kind} property is not an array`);
  const items = inline.length >= 25 || object.has_more === true
    ? await propertyItems(client, pageId, propertyId) : inline;
  return items.map((item) => {
    const record = asRecord(item);
    const text = typeof record.plain_text === "string" ? record.plain_text : asRecord(record[kind]).plain_text;
    if (typeof text !== "string") throw new NotionReadFailure("schema", `Notion ${kind} contains an unreadable item`);
    return text;
  }).join("");
}

async function relations(client: Client, pageId: string, propertyId: string, value: unknown): Promise<string[]> {
  const object = asRecord(value);
  const inline = object.relation;
  if (!Array.isArray(inline)) throw new NotionReadFailure("schema", "Notion relation property is not an array");
  const items = inline.length >= 25 || object.has_more === true
    ? await propertyItems(client, pageId, propertyId) : inline;
  return items.map((item) => {
    const record = asRecord(item);
    const id = typeof record.id === "string" ? record.id : asRecord(record.relation).id;
    if (typeof id !== "string" || !id) throw new NotionReadFailure("schema", "Notion relation contains an unreadable ID");
    return id;
  });
}

async function propertyItems(client: Client, pageId: string, propertyId: string): Promise<unknown[]> {
  const items: unknown[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const response = await client.pages.properties.retrieve({ page_id: pageId, property_id: propertyId,
      page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    if (response.object !== "list") {
      items.push(response);
      break;
    }
    items.push(...response.results);
    if (!response.has_more) break;
    if (!response.next_cursor || cursors.has(response.next_cursor)) {
      throw new NotionReadFailure("incomplete", "Notion property pagination is incomplete");
    }
    cursor = response.next_cursor;
    cursors.add(cursor);
  } while (true);
  return items;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NotionReadFailure("schema", "Notion returned an invalid property");
  return value as Record<string, unknown>;
}
