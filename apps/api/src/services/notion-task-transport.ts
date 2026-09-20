import { Client, type CreatePageParameters, type PageObjectResponse, type UpdatePageParameters } from "@notionhq/client";
import { notionTaskFieldsSchema, type NotionConnection, type NotionTaskFields, type NotionTaskMapping } from "@newday/core/contracts/notion-sync";

import type { NotionCredentialVault } from "../storage/notion-credential-vault.js";
import type { NotionTaskPage, NotionTaskTransport } from "./notion-outbox-dispatcher.js";
import { NotionReadFailure, assertRuleSourceReadable, parseRow } from "./notion-read-gateway.js";

type Properties = NonNullable<CreatePageParameters["properties"]>;

/** Writes only the three shared fields. The token stays in the local vault;
 * SDK retries are disabled because a lost create response must be reconciled
 * by its stable key before any subsequent write. */
export class NotionSdkTaskTransport implements NotionTaskTransport {
  constructor(private readonly vault: NotionCredentialVault,
    private readonly makeClient: (token: string) => Client = (token) =>
      new Client({ auth: token, notionVersion: "2026-03-11", retry: false, timeoutMs: 15_000 })) {}

  async findByClientKey(connection: NotionConnection, mapping: NotionTaskMapping) {
    const client = this.client(connection, mapping);
    await assertRuleSourceReadable(client, connection);
    const propertyId = this.propertyId(connection, "NewDay Key");
    const pages: NotionTaskPage[] = [];
    const cursors = new Set<string>();
    const ids = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = await client.dataSources.query({ data_source_id: mapping.dataSourceId,
        filter: { property: propertyId, rich_text: { equals: mapping.clientKey } },
        page_size: 100, result_type: "page", ...(cursor ? { start_cursor: cursor } : {}) });
      if (response.request_status?.type === "incomplete") return { complete: false, pages };
      for (const raw of response.results) {
        if (raw.object !== "page" || !("properties" in raw) || !("parent" in raw)) {
          return { complete: false, pages };
        }
        if (ids.has(raw.id)) continue;
        ids.add(raw.id);
        const page = await this.parseTarget(client, connection, mapping, raw);
        if (page.clientKey !== mapping.clientKey) return { complete: false, pages };
        pages.push(page);
      }
      if (!response.has_more) return { complete: true, pages };
      if (!response.next_cursor || cursors.has(response.next_cursor) || ids.size >= 10_000) {
        return { complete: false, pages };
      }
      cursor = response.next_cursor;
      cursors.add(cursor);
    } while (true);
  }

  async readPage(connection: NotionConnection, mapping: NotionTaskMapping) {
    if (!mapping.remotePageId) return null;
    const client = this.client(connection, mapping);
    await assertRuleSourceReadable(client, connection);
    const raw = await client.pages.retrieve({ page_id: mapping.remotePageId });
    if (!("properties" in raw) || !("parent" in raw)) {
      throw new NotionReadFailure("incomplete", "Notion returned a partial task page");
    }
    return this.parseTarget(client, connection, mapping, raw);
  }

  async createPage(connection: NotionConnection, mapping: NotionTaskMapping, fields: NotionTaskFields) {
    if (mapping.remotePageId) throw new Error("Notion mapping already has a page");
    const client = this.client(connection, mapping);
    await assertRuleSourceReadable(client, connection);
    const properties = this.sharedProperties(connection, notionTaskFieldsSchema.parse(fields));
    properties[this.propertyId(connection, "NewDay Key")] = {
      rich_text: [{ type: "text", text: { content: mapping.clientKey } }],
    };
    await client.pages.create({ parent: { type: "data_source_id", data_source_id: mapping.dataSourceId }, properties });
  }

  async updatePage(connection: NotionConnection, mapping: NotionTaskMapping, patch: Partial<NotionTaskFields>) {
    if (!mapping.remotePageId) throw new Error("Notion mapping has no page");
    const client = this.client(connection, mapping);
    await assertRuleSourceReadable(client, connection);
    const properties = this.sharedProperties(connection, patch);
    if (!Object.keys(properties).length) throw new Error("Notion update has no shared fields");
    await client.pages.update({ page_id: mapping.remotePageId,
      properties: properties as NonNullable<UpdatePageParameters["properties"]> });
  }

  private client(connection: NotionConnection, mapping: NotionTaskMapping): Client {
    if (mapping.workspaceId !== connection.workspaceId ||
      mapping.dataSourceId !== connection.dataSources.tasks?.dataSourceId) {
      throw new Error("Notion task mapping is outside the confirmed data source");
    }
    const token = this.vault.getCredential(connection.workspaceId)?.access_token;
    if (!token) throw new Error("Notion credential is unavailable");
    return this.makeClient(token);
  }

  private propertyId(connection: NotionConnection, name: string): string {
    const id = connection.dataSources.tasks?.propertyIds[name];
    if (!id) throw new Error(`Notion Tasks property ${name} is not initialized`);
    return id;
  }

  private sharedProperties(connection: NotionConnection, fields: Partial<NotionTaskFields>): Properties {
    const properties: Properties = {};
    if (fields.title !== undefined) properties[this.propertyId(connection, "Name")] = {
      title: [{ type: "text", text: { content: fields.title } }],
    };
    if (fields.date !== undefined) properties[this.propertyId(connection, "Plan Date")] = {
      date: fields.date === null ? null : { start: fields.date[0], end: fields.date[1] },
    };
    if (fields.completed !== undefined) properties[this.propertyId(connection, "Completed")] = {
      checkbox: fields.completed,
    };
    return properties;
  }

  private async parseTarget(client: Client, connection: NotionConnection, mapping: NotionTaskMapping,
    raw: PageObjectResponse): Promise<NotionTaskPage> {
    if (raw.parent.type !== "data_source_id" || raw.parent.data_source_id !== mapping.dataSourceId) {
      throw new NotionReadFailure("schema", "Notion task page has a different parent");
    }
    const row = await parseRow(client, raw, "tasks", connection.dataSources.tasks!.propertyIds);
    if (row.kind !== "task" || row.ruleIds.length || row.occurrenceKey) {
      throw new NotionReadFailure("schema", "Notion task is a rule instance, not a one-off task");
    }
    return { workspaceId: connection.workspaceId, dataSourceId: mapping.dataSourceId,
      remotePageId: row.id, clientKey: row.clientKey,
      fields: notionTaskFieldsSchema.parse({ title: row.title, date: row.date, completed: row.completed }),
      inTrash: row.inTrash };
  }
}
