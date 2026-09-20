import { Client, type CreateDatabaseParameters } from "@notionhq/client";

export type StructureProperty = { id: string; type: string; options?: string[]; relationTarget?: string };
export type StructurePage = { id: string; title: string; workspaceParent: boolean };
export type StructureDatabase = {
  id: string; title: string; parentPageId: string; dataSourceIds: string[];
};

/** The only T3 adapter allowed to use an access token. No token enters the
 * browser, a business backup, or a StructureGateway result. */
export interface NotionStructureGateway {
  createRoot(token: string, title: string): Promise<string>;
  findRoots(token: string, title: string): Promise<string[]>;
  getRoot(token: string, pageId: string): Promise<StructurePage>;
  createDatabase(token: string, parentPageId: string, title: string, properties: Record<string, unknown>): Promise<string>;
  listChildDatabases(token: string, parentPageId: string): Promise<string[]>;
  getDatabase(token: string, databaseId: string): Promise<StructureDatabase>;
  getDataSourceProperties(token: string, dataSourceId: string): Promise<Record<string, StructureProperty>>;
  addRelation(token: string, dataSourceId: string, name: string, targetDataSourceId: string): Promise<void>;
}

export class NotionSdkStructureGateway implements NotionStructureGateway {
  private client(token: string): Client {
    return new Client({ auth: token, notionVersion: "2026-03-11", retry: false, timeoutMs: 15_000 });
  }

  async createRoot(token: string, title: string): Promise<string> {
    const page = await this.client(token).pages.create({
      parent: { type: "workspace", workspace: true },
      properties: { title: { title: [{ type: "text", text: { content: title } }] } },
    });
    return page.id;
  }

  async findRoots(token: string, title: string): Promise<string[]> {
    const client = this.client(token);
    const matches: string[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await client.search({ query: title, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
      if (page.request_status?.type === "incomplete") throw new Error("Notion root search is incomplete");
      for (const item of page.results) if (item.object === "page") matches.push(item.id);
      if (!page.has_more) break;
      if (!page.next_cursor || seen.has(page.next_cursor)) throw new Error("Notion root search pagination is incomplete");
      cursor = page.next_cursor;
      seen.add(cursor);
    } while (true);
    return matches;
  }

  async getRoot(token: string, pageId: string): Promise<StructurePage> {
    const page = await this.client(token).pages.retrieve({ page_id: pageId });
    if (!("parent" in page) || !("properties" in page)) throw new Error("Notion returned an inaccessible root page");
    const properties = page.properties as Record<string, unknown>;
    const titleProperty = properties.title;
    const title = titleProperty && typeof titleProperty === "object" && "title" in titleProperty
      ? richText(titleProperty.title) : "";
    return { id: page.id, title, workspaceParent: page.parent.type === "workspace" && page.parent.workspace === true };
  }

  async createDatabase(token: string, parentPageId: string, title: string, properties: Record<string, unknown>): Promise<string> {
    const request = {
      parent: { type: "page_id", page_id: parentPageId },
      title: [{ type: "text", text: { content: title } }],
      is_inline: false,
      initial_data_source: { properties },
    } as CreateDatabaseParameters;
    const database = await this.client(token).databases.create(request);
    return database.id;
  }

  async listChildDatabases(token: string, parentPageId: string): Promise<string[]> {
    const client = this.client(token);
    const ids: string[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await client.blocks.children.list({ block_id: parentPageId, page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}) });
      for (const item of page.results) if (item.object === "block" && "type" in item && item.type === "child_database") ids.push(item.id);
      if (!page.has_more) break;
      if (!page.next_cursor || seen.has(page.next_cursor)) throw new Error("Notion child listing is incomplete");
      cursor = page.next_cursor;
      seen.add(cursor);
    } while (true);
    return ids;
  }

  async getDatabase(token: string, databaseId: string): Promise<StructureDatabase> {
    const database = await this.client(token).databases.retrieve({ database_id: databaseId });
    if (!("data_sources" in database) || !("parent" in database) || !("title" in database) ||
      database.parent.type !== "page_id") throw new Error("Notion returned an incomplete database");
    return {
      id: database.id,
      title: richText(database.title),
      parentPageId: database.parent.page_id,
      dataSourceIds: database.data_sources.map((item) => item.id),
    };
  }

  async getDataSourceProperties(token: string, dataSourceId: string): Promise<Record<string, StructureProperty>> {
    const dataSource = await this.client(token).dataSources.retrieve({ data_source_id: dataSourceId });
    if (!("properties" in dataSource)) throw new Error("Notion returned an incomplete data source");
    const result: Record<string, StructureProperty> = {};
    for (const [name, value] of Object.entries(dataSource.properties)) {
      if (!value || typeof value !== "object" || typeof value.id !== "string" || typeof value.type !== "string") continue;
      const options = "select" in value && value.select && "options" in value.select ? value.select.options.map((item) => item.name)
        : "multi_select" in value && value.multi_select && "options" in value.multi_select ? value.multi_select.options.map((item) => item.name)
          : undefined;
      const relationTarget = "relation" in value && value.relation && "data_source_id" in value.relation
        ? value.relation.data_source_id : undefined;
      result[name] = { id: value.id, type: value.type, ...(options ? { options } : {}),
        ...(relationTarget ? { relationTarget } : {}) };
    }
    return result;
  }

  async addRelation(token: string, dataSourceId: string, name: string, targetDataSourceId: string): Promise<void> {
    await this.client(token).dataSources.update({
      data_source_id: dataSourceId,
      properties: { [name]: { relation: { data_source_id: targetDataSourceId, single_property: {} } } },
    });
  }
}

function richText(value: unknown): string {
  return Array.isArray(value)
    ? value.map((item) => item && typeof item === "object" && "plain_text" in item
      ? String(item.plain_text) : item && typeof item === "object" && "text" in item && item.text &&
        typeof item.text === "object" && "content" in item.text ? String(item.text.content) : "").join("")
    : "";
}
