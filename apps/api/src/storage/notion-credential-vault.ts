import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type NotionCredential = Record<string, unknown> & {
  access_token: string;
  refresh_token: string;
  bot_id: string;
  workspace_id: string;
  workspace_name?: string | null;
};

export type NotionCredentialSummary = {
  workspaceId: string;
  workspaceName: string | null;
  botId: string;
  status: "active" | "refresh_pending" | "reauthorization_required";
  updatedAt: string;
};

type CredentialRow = {
  workspace_id: string;
  workspace_name: string | null;
  bot_id: string;
  status: "active" | "reauthorization_required";
  encrypted: string;
  refresh_attempt_id: string | null;
  updated_at: string;
};

/** This database is deliberately separate from the planner's business backup.
 * A 32-byte local key encrypts every token and pending claim verifier. */
export class NotionCredentialVault {
  private readonly database: DatabaseSync;
  private readonly key: Buffer;

  constructor(databasePath: string, encryptionKey: Buffer) {
    if (encryptionKey.length !== 32) throw new Error("Notion credential key must be 32 bytes");
    this.key = Buffer.from(encryptionKey);
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
      try { closeSync(openSync(databasePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (!lstatSync(databasePath).isFile()) throw new Error("Notion credential vault must be a regular file");
      chmodSync(databasePath, 0o600);
    }
    this.database = new DatabaseSync(databasePath, { timeout: 5_000 });
    try {
      this.database.exec(`PRAGMA journal_mode = DELETE;
        CREATE TABLE IF NOT EXISTS oauth_pending (
          state TEXT PRIMARY KEY, encrypted_verifier TEXT NOT NULL, expires_at INTEGER NOT NULL,
          start_sequence INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS disconnected_workspaces (
          workspace_id TEXT PRIMARY KEY, disconnect_sequence INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS oauth_sequence (
          id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS credentials (
          workspace_id TEXT PRIMARY KEY, workspace_name TEXT, bot_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active','reauthorization_required')),
          encrypted TEXT NOT NULL, refresh_attempt_id TEXT, updated_at TEXT NOT NULL
        );`);
      this.database.prepare("INSERT OR IGNORE INTO oauth_sequence(id,value) VALUES(1,0)").run();
      // Pending sessions from an older vault are conservatively treated as old.
      const pendingColumns = this.database.prepare("PRAGMA table_info(oauth_pending)").all();
      if (!pendingColumns.some((column) => column.name === "start_sequence")) {
        this.database.exec("ALTER TABLE oauth_pending ADD COLUMN start_sequence INTEGER NOT NULL DEFAULT 0");
      }
    } catch (error) { this.database.close(); throw error; }
  }

  close(): void { this.database.close(); }

  beginAuthorization(): number {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const sequence = this.nextSequence();
      this.database.exec("COMMIT");
      return sequence;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  putPending(state: string, verifier: string, expiresAt: number, now = Date.now(), startSequence?: number): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM oauth_pending WHERE expires_at<=?").run(now);
      this.database.prepare("INSERT INTO oauth_pending(state,encrypted_verifier,expires_at,start_sequence) VALUES(?,?,?,?)")
        .run(state, this.encrypt(verifier), expiresAt, startSequence ?? this.nextSequence());
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  getPending(state: string, now: number): string | null {
    const row = this.database.prepare("SELECT encrypted_verifier,expires_at FROM oauth_pending WHERE state=?").get(state);
    if (!row || Number(row.expires_at) <= now) return null;
    return this.decrypt(String(row.encrypted_verifier)) as string;
  }

  removePending(state: string): void {
    this.database.prepare("DELETE FROM oauth_pending WHERE state=?").run(state);
  }

  storeClaimed(state: string, credential: NotionCredential, now: string): NotionCredentialSummary | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const pending = this.database.prepare("SELECT start_sequence,expires_at FROM oauth_pending WHERE state=?").get(state);
      if (!pending || Number(pending.expires_at) <= Date.parse(now)) {
        this.database.prepare("DELETE FROM oauth_pending WHERE state=?").run(state);
        this.database.exec("COMMIT");
        return null;
      }
      const disconnected = this.database.prepare("SELECT disconnect_sequence FROM disconnected_workspaces WHERE workspace_id=?")
        .get(credential.workspace_id);
      if (disconnected && Number(pending.start_sequence) <= Number(disconnected.disconnect_sequence)) {
        this.database.prepare("DELETE FROM oauth_pending WHERE state=?").run(state);
        this.database.exec("COMMIT");
        return null;
      }
      const summary = summaryOf(credential, "active", now);
      this.database.prepare(`INSERT INTO credentials(workspace_id,workspace_name,bot_id,status,encrypted,refresh_attempt_id,updated_at)
        VALUES(?,?,?,?,?,NULL,?) ON CONFLICT(workspace_id) DO UPDATE SET
        workspace_name=excluded.workspace_name,bot_id=excluded.bot_id,status=excluded.status,
        encrypted=excluded.encrypted,refresh_attempt_id=NULL,updated_at=excluded.updated_at`)
        .run(summary.workspaceId, summary.workspaceName, summary.botId, summary.status, this.encrypt(credential), now);
      this.database.prepare("DELETE FROM oauth_pending WHERE state=?").run(state);
      this.database.exec("COMMIT");
      return summary;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  list(): NotionCredentialSummary[] {
    return this.database.prepare("SELECT workspace_id,workspace_name,bot_id,status,refresh_attempt_id,updated_at FROM credentials ORDER BY workspace_id")
      .all().map((row) => ({
        workspaceId: String(row.workspace_id), workspaceName: row.workspace_name === null ? null : String(row.workspace_name),
        botId: String(row.bot_id),
        status: row.status === "active" && row.refresh_attempt_id !== null ? "refresh_pending" : row.status as NotionCredentialSummary["status"],
        updatedAt: String(row.updated_at),
      }));
  }

  getCredential(workspaceId: string): NotionCredential | null {
    const row = this.database.prepare("SELECT encrypted FROM credentials WHERE workspace_id=? AND status='active' AND refresh_attempt_id IS NULL").get(workspaceId);
    return row ? this.decrypt(String(row.encrypted)) as NotionCredential : null;
  }

  beginRefresh(workspaceId: string): { attemptId: string; credential: NotionCredential } | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT * FROM credentials WHERE workspace_id=?").get(workspaceId) as CredentialRow | undefined;
      if (!row || row.status !== "active") { this.database.exec("COMMIT"); return null; }
      const attemptId = row.refresh_attempt_id ?? randomBytes(32).toString("base64url");
      if (!row.refresh_attempt_id) {
        this.database.prepare("UPDATE credentials SET refresh_attempt_id=? WHERE workspace_id=?").run(attemptId, workspaceId);
      }
      const credential = this.decrypt(row.encrypted) as NotionCredential;
      this.database.exec("COMMIT");
      return { attemptId, credential };
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  completeRefresh(workspaceId: string, attemptId: string, credential: NotionCredential, now: string): NotionCredentialSummary {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT * FROM credentials WHERE workspace_id=?").get(workspaceId) as CredentialRow | undefined;
      if (!row || row.refresh_attempt_id !== attemptId || row.bot_id !== credential.bot_id ||
        credential.workspace_id !== workspaceId) throw new Error("Notion refresh result does not match the current connection");
      const summary = summaryOf(credential, "active", now);
      this.database.prepare(`UPDATE credentials SET workspace_name=?,bot_id=?,status='active',encrypted=?,
        refresh_attempt_id=NULL,updated_at=? WHERE workspace_id=?`)
        .run(summary.workspaceName, summary.botId, this.encrypt(credential), now, workspaceId);
      this.database.exec("COMMIT");
      return summary;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  requireReauthorization(workspaceId: string, attemptId: string, now: string): void {
    this.database.prepare(`UPDATE credentials SET status='reauthorization_required',updated_at=?
      WHERE workspace_id=? AND refresh_attempt_id=?`).run(now, workspaceId, attemptId);
  }

  disconnect(workspaceId: string): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.database.prepare("DELETE FROM credentials WHERE workspace_id=?").run(workspaceId).changes > 0;
      this.database.prepare(`INSERT INTO disconnected_workspaces(workspace_id,disconnect_sequence) VALUES(?,?)
        ON CONFLICT(workspace_id) DO UPDATE SET disconnect_sequence=excluded.disconnect_sequence`)
        .run(workspaceId, this.nextSequence());
      // Pending OAuth sessions have no workspace identity until claim. A
      // workspace-specific disconnect must not cancel another authorization.
      this.database.exec("COMMIT");
      return changed;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  private nextSequence(): number {
    this.database.prepare("UPDATE oauth_sequence SET value=value+1 WHERE id=1").run();
    return Number(this.database.prepare("SELECT value FROM oauth_sequence WHERE id=1").get()!.value);
  }

  private encrypt(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${encrypted.toString("base64url")}`;
  }

  private decrypt(value: string): unknown {
    const [version, iv, tag, ciphertext] = value.split(":");
    if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Notion credential cannot be decrypted");
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8"));
    } catch { throw new Error("Notion credential cannot be decrypted"); }
  }
}

function summaryOf(credential: NotionCredential, status: "active" | "reauthorization_required", updatedAt: string): NotionCredentialSummary {
  return {
    workspaceId: credential.workspace_id,
    workspaceName: typeof credential.workspace_name === "string" ? credential.workspace_name : null,
    botId: credential.bot_id, status, updatedAt,
  };
}
