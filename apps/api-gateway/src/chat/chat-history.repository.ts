import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  HttpException,
  Injectable,
  NotFoundException,
  OnModuleInit,
  OnModuleDestroy,
  ServiceUnavailableException,
} from "@nestjs/common";
import { LoggerService } from "vietflood-common";

import { ChatCryptoService, ChatRole, EncryptedMessage } from "./chat-crypto.service";

export type ChatKind =
  | "knowledge"
  | "small_talk"
  | "community_reports"
  | "first_aid"
  | "report_guide"
  | "report_status"
  | "action"
  | "fallback"
  | "legacy";
export type ChatTurn = {
  role: ChatRole;
  content: string;
  kind: ChatKind;
};
export type ChatMessage = ChatTurn & { id: string; createdAt: string | null };
export type ChatSession = {
  sessionId: string;
  title: string;
  createdAt: string | null;
  updatedAt: string;
};
export type Page<T> = { items: T[]; nextCursor: string | null };

type SqlResult<T> = { rows: T[]; rowCount: number | null };
type SqlClient = {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<SqlResult<T>>;
  release(): void;
};
type SqlPool = SqlClient & {
  connect(): Promise<SqlClient>;
  end(): Promise<void>;
};
type MessageRow = {
  id: string;
  sequence: string;
  role: ChatRole;
  kind: ChatKind;
  ciphertext: Buffer;
  nonce: Buffer;
  auth_tag: Buffer;
  key_id: string;
  created_at: Date | null;
};
type SessionRow = {
  id: string;
  created_at: Date | null;
  updated_at: Date;
  first_id: string | null;
  first_ciphertext: Buffer | null;
  first_nonce: Buffer | null;
  first_auth_tag: Buffer | null;
  first_key_id: string | null;
};

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCursor(value: string): unknown {
  try {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw new Error();
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new BadRequestException("Invalid chat history cursor");
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class ChatHistoryRepository implements OnModuleInit, OnModuleDestroy {
  private readonly pool: SqlPool;

  constructor(
    private readonly crypto: ChatCryptoService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setServiceName(ChatHistoryRepository.name);
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required for chat history");
    const parsedUrl = new URL(connectionString);
    const host = parsedUrl.hostname;
    // pg URL SSL parameters can override the verified SSL object below.
    for (const name of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) parsedUrl.searchParams.delete(name);
    const caEncoded = process.env.CHAT_DB_CA_BASE64;
    if ((process.env.NODE_ENV === "production" || host.endsWith(".supabase.com")) && !caEncoded)
      throw new Error("CHAT_DB_CA_BASE64 is required for Supabase TLS verification");
    const ssl = caEncoded
      ? {
          ca: Buffer.from(caEncoded, "base64").toString("utf8"),
          rejectUnauthorized: true,
          servername: host,
        }
      : undefined;
    if (ssl && !ssl.ca.includes("BEGIN CERTIFICATE"))
      throw new Error("CHAT_DB_CA_BASE64 is invalid");
    const { Pool } = require("pg") as { Pool: new (options: object) => SqlPool };
    this.pool = new Pool({ connectionString: parsedUrl.toString(), ssl, max: 4 });
  }

  async onModuleInit(): Promise<void> {
    // Force a verified database connection before the API accepts chat requests.
    await this.safe(async () => { await this.pool.query("SELECT 1 FROM private_chat.sessions LIMIT 0"); });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async access(userId: number, sessionId: string): Promise<"owned" | "other" | "missing"> {
    return this.safe(async () => {
      const result = await this.pool.query<{ is_owner: boolean }>(
        "SELECT user_id = $2 AS is_owner FROM private_chat.sessions WHERE id = $1",
        [sessionId, userId],
      );
      if (result.rows.length === 0) return "missing";
      return result.rows[0].is_owner ? "owned" : "other";
    });
  }

  async list(userId: number, limit: number, cursor?: string): Promise<Page<ChatSession>> {
    return this.safe(async () => {
      let timestamp: string | null = null;
      let id: string | null = null;
      if (cursor) {
        const parsed = decodeCursor(cursor);
        if (!Array.isArray(parsed) || parsed.length !== 2 ||
          typeof parsed[0] !== "string" || Number.isNaN(Date.parse(parsed[0])) ||
          typeof parsed[1] !== "string" || !UUID_RE.test(parsed[1]))
          throw new BadRequestException("Invalid chat history cursor");
        [timestamp, id] = parsed;
      }
      const result = await this.pool.query<SessionRow>(
        `SELECT s.id, s.created_at, s.updated_at,
          first_message.id AS first_id,
          first_message.ciphertext AS first_ciphertext,
          first_message.nonce AS first_nonce,
          first_message.auth_tag AS first_auth_tag,
          first_message.key_id AS first_key_id
         FROM private_chat.sessions s
         LEFT JOIN LATERAL (
           SELECT id, ciphertext, nonce, auth_tag, key_id
           FROM private_chat.messages
           WHERE session_id = s.id AND role = 'user'
           ORDER BY sequence ASC LIMIT 1
         ) first_message ON true
         WHERE s.user_id = $1
           AND ($2::timestamptz IS NULL OR (s.updated_at, s.id) < ($2::timestamptz, $3::uuid))
         ORDER BY s.updated_at DESC, s.id DESC LIMIT $4`,
        [userId, timestamp, id, limit + 1],
      );
      const hasMore = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      return {
        items: rows.map((row) => this.sessionFromRow(row, userId)),
        nextCursor: hasMore && rows.length
          ? encodeCursor([rows[rows.length - 1].updated_at.toISOString(), rows[rows.length - 1].id])
          : null,
      };
    });
  }

  async messages(
    userId: number,
    sessionId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ session: ChatSession; items: ChatMessage[]; nextCursor: string | null } | null> {
    return this.safe(async () => {
      let before: string | null = null;
      if (cursor) {
        const parsed = decodeCursor(cursor);
        if (typeof parsed !== "string" || !/^[1-9][0-9]*$/.test(parsed))
          throw new BadRequestException("Invalid chat history cursor");
        before = parsed;
      }
      const sessionResult = await this.pool.query<SessionRow>(
        `SELECT s.id, s.created_at, s.updated_at,
          first_message.id AS first_id,
          first_message.ciphertext AS first_ciphertext,
          first_message.nonce AS first_nonce,
          first_message.auth_tag AS first_auth_tag,
          first_message.key_id AS first_key_id
         FROM private_chat.sessions s
         LEFT JOIN LATERAL (
           SELECT id, ciphertext, nonce, auth_tag, key_id
           FROM private_chat.messages
           WHERE session_id = s.id AND role = 'user'
           ORDER BY sequence ASC LIMIT 1
         ) first_message ON true
         WHERE s.id = $1 AND s.user_id = $2`,
        [sessionId, userId],
      );
      if (!sessionResult.rows.length) return null;
      const result = await this.pool.query<MessageRow>(
        `SELECT m.id, m.sequence, m.role, m.kind, m.ciphertext, m.nonce,
                m.auth_tag, m.key_id, m.created_at
         FROM private_chat.messages m
         JOIN private_chat.sessions s ON s.id = m.session_id
         WHERE m.session_id = $1 AND s.user_id = $2
           AND ($3::bigint IS NULL OR m.sequence < $3::bigint)
         ORDER BY m.sequence DESC LIMIT $4`,
        [sessionId, userId, before, limit + 1],
      );
      const hasMore = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      return {
        session: this.sessionFromRow(sessionResult.rows[0], userId),
        items: rows.reverse().map((row) => this.messageFromRow(row, userId, sessionId)),
        nextCursor: hasMore && rows.length ? encodeCursor(rows[0].sequence) : null,
      };
    });
  }

  async recent(userId: number, sessionId: string, limit: number): Promise<ChatTurn[]> {
    return this.safe(async () => {
      const result = await this.pool.query<MessageRow>(
        `SELECT m.id, m.sequence, m.role, m.kind, m.ciphertext, m.nonce,
                m.auth_tag, m.key_id, m.created_at
         FROM private_chat.messages m
         JOIN private_chat.sessions s ON s.id = m.session_id
         WHERE m.session_id = $1 AND s.user_id = $2
         ORDER BY m.sequence DESC LIMIT $3`,
        [sessionId, userId, limit],
      );
      return result.rows.reverse().map((row) => this.messageFromRow(row, userId, sessionId));
    });
  }

  async recentKnowledgeAnswers(
    userId: number,
    sessionId: string,
    limit = 2,
  ): Promise<ChatTurn[]> {
    return this.safe(async () => {
      const result = await this.pool.query<MessageRow>(
        `SELECT m.id, m.sequence, m.role, m.kind, m.ciphertext, m.nonce,
                m.auth_tag, m.key_id, m.created_at
         FROM private_chat.messages m
         JOIN private_chat.sessions s ON s.id = m.session_id
         WHERE m.session_id = $1 AND s.user_id = $2
           AND m.role = 'assistant' AND m.kind = 'knowledge'
         ORDER BY m.sequence DESC LIMIT $3`,
        [sessionId, userId, limit],
      );
      return result.rows
        .reverse()
        .map((row) => this.messageFromRow(row, userId, sessionId));
    });
  }

  async create(userId: number, sessionId: string, message: string, answer: string, kind: ChatKind): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        "INSERT INTO private_chat.sessions (id, user_id, created_at) VALUES ($1, $2, now())",
        [sessionId, userId],
      );
      await this.insertTurns(client, userId, sessionId, 1, [
        { role: "user", content: message, kind },
        { role: "assistant", content: answer, kind },
      ]);
    });
  }

  async append(userId: number, sessionId: string, message: string, answer: string, kind: ChatKind): Promise<boolean> {
    return this.transaction(async (client) => {
      const result = await client.query<{ next_sequence: string }>(
        "SELECT next_sequence FROM private_chat.sessions WHERE id = $1 AND user_id = $2 FOR UPDATE",
        [sessionId, userId],
      );
      if (!result.rows.length) return false;
      await this.insertTurns(client, userId, sessionId, Number(result.rows[0].next_sequence), [
        { role: "user", content: message, kind },
        { role: "assistant", content: answer, kind },
      ]);
      return true;
    });
  }

  async importLegacy(
    userId: number,
    sessionId: string,
    turns: ChatTurn[],
    ownerStillActive: () => Promise<boolean>,
  ): Promise<void> {
    await this.transaction(async (client) => {
      await this.lockSession(client, sessionId);
      if (!(await ownerStillActive()))
        throw new NotFoundException("Chat session not found");
      const result = await client.query(
        "INSERT INTO private_chat.sessions (id, user_id, created_at) VALUES ($1, $2, NULL) ON CONFLICT DO NOTHING RETURNING id",
        [sessionId, userId],
      );
      if (result.rowCount)
        await this.insertTurns(client, userId, sessionId, 1, turns.map((turn) => ({ ...turn, kind: "legacy" })));
    });
  }

  async delete(
    userId: number,
    sessionId: string,
    eraseLegacy?: (existsInDatabase: boolean) => Promise<boolean>,
  ): Promise<boolean> {
    return this.transaction(async (client) => {
      await this.lockSession(client, sessionId);
      const owner = await client.query<{ user_id: number }>(
        "SELECT user_id FROM private_chat.sessions WHERE id = $1", [sessionId],
      );
      if (owner.rows.length && owner.rows[0].user_id !== userId) return false;
      const existsInDatabase = owner.rows.length > 0;
      const legacyOwned = eraseLegacy ? await eraseLegacy(existsInDatabase) : false;
      const result = await client.query(
        "DELETE FROM private_chat.sessions WHERE id = $1 AND user_id = $2 RETURNING id",
        [sessionId, userId],
      );
      return Boolean(result.rowCount) || legacyOwned;
    });
  }

  private async lockSession(client: SqlClient, sessionId: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [sessionId]);
  }

  private async insertTurns(
    client: SqlClient,
    userId: number,
    sessionId: string,
    start: number,
    turns: ChatTurn[],
  ): Promise<void> {
    for (const [index, turn] of turns.entries()) {
      const id = randomUUID();
      const encrypted = this.crypto.encrypt(turn.content, userId, sessionId, id, turn.role);
      await client.query(
        `INSERT INTO private_chat.messages
          (id, session_id, sequence, role, kind, ciphertext, nonce, auth_tag, key_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, sessionId, start + index, turn.role, turn.kind, encrypted.ciphertext,
          encrypted.nonce, encrypted.authTag, encrypted.keyId,
          turn.kind === "legacy" ? null : new Date()],
      );
    }
    await client.query(
      "UPDATE private_chat.sessions SET next_sequence = $3, updated_at = now() WHERE id = $1 AND user_id = $2",
      [sessionId, userId, start + turns.length],
    );
  }

  private messageFromRow(row: MessageRow, userId: number, sessionId: string): ChatMessage {
    return {
      id: row.id,
      role: row.role,
      kind: row.kind,
      content: this.crypto.decrypt(this.encrypted(row), userId, sessionId, row.id, row.role),
      createdAt: row.created_at?.toISOString() ?? null,
    };
  }

  private sessionFromRow(row: SessionRow, userId: number): ChatSession {
    const first = row.first_id && row.first_ciphertext && row.first_nonce &&
      row.first_auth_tag && row.first_key_id
      ? this.crypto.decrypt({ ciphertext: row.first_ciphertext, nonce: row.first_nonce,
        authTag: row.first_auth_tag, keyId: row.first_key_id }, userId, row.id, row.first_id, "user")
      : "";
    return {
      sessionId: row.id,
      title: first.slice(0, 80) || "Cuộc trò chuyện",
      createdAt: row.created_at?.toISOString() ?? null,
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private encrypted(row: MessageRow): EncryptedMessage {
    return { ciphertext: row.ciphertext, nonce: row.nonce, authTag: row.auth_tag, keyId: row.key_id };
  }

  private async transaction<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    return this.safe(async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
  }

  private async safe<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.warn("Chat history database operation failed");
      throw new ServiceUnavailableException("Chat history is unavailable");
    }
  }
}
