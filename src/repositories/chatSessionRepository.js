/**
 * Chat session + message persistence with cursor-based pagination.
 *
 * Cursor format
 * ─────────────
 * The cursor is the base64 of `${createdAt.toISOString()}|${id}`. Combining
 * the timestamp with the message id breaks ties when two messages share a
 * millisecond. The reverse-chronological scan returns at most `limit`
 * messages older than the cursor; the FE prepends them and shows the
 * oldest at the top, satisfying infinite-scroll up-direction loading.
 */

const { and, asc, desc, eq, gt, lt, or, sql } = require("drizzle-orm");

const { db } = require("../configs/db");
const { chatMessage, chatSession } = require("../models/chatSession");

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function encodeCursor(message) {
  if (!message) return null;
  const ts =
    message.createdAt instanceof Date ? message.createdAt.toISOString() : message.createdAt;
  return Buffer.from(`${ts}|${message.id}`).toString("base64url");
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const [ts, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (!ts || !id) return null;
    return { createdAt: new Date(ts), id };
  } catch {
    return null;
  }
}

class ChatSessionRepository {
  constructor(client = db) {
    this.client = client;
  }

  async createSession(data) {
    const [created] = await this.client.insert(chatSession).values(data).returning();
    return created;
  }

  async findSessionById(id, userId) {
    const [row] = await this.client
      .select()
      .from(chatSession)
      .where(
        and(
          eq(chatSession.id, id),
          eq(chatSession.userId, userId),
          eq(chatSession.softDelete, false),
        ),
      )
      .limit(1);
    return row || null;
  }

  /**
   * List sessions ordered by recent activity. Used by the FE sidebar.
   */
  async listSessions({ userId, limit = DEFAULT_PAGE_SIZE, cursor }) {
    const pageSize = Math.min(limit, MAX_PAGE_SIZE);
    const cur = decodeCursor(cursor);

    const conditions = [eq(chatSession.userId, userId), eq(chatSession.softDelete, false)];
    if (cur) {
      conditions.push(
        or(
          lt(chatSession.lastMessageAt, cur.createdAt),
          and(eq(chatSession.lastMessageAt, cur.createdAt), lt(chatSession.id, cur.id)),
        ),
      );
    }

    const rows = await this.client
      .select()
      .from(chatSession)
      .where(and(...conditions))
      .orderBy(desc(chatSession.lastMessageAt), desc(chatSession.id))
      .limit(pageSize + 1);

    const hasMore = rows.length > pageSize;
    const items = hasMore ? rows.slice(0, pageSize) : rows;
    const nextCursor = hasMore
      ? encodeCursor({
          createdAt: items[items.length - 1].lastMessageAt,
          id: items[items.length - 1].id,
        })
      : null;

    return { items, nextCursor };
  }
  async softDeleteSession(id, userId) {
    const [updated] = await this.client
      .update(chatSession)
      .set({ deletedAt: new Date(), softDelete: true, updatedAt: new Date() })
      .where(and(eq(chatSession.id, id), eq(chatSession.userId, userId)))
      .returning();
    return updated || null;
  }

  async appendMessage({ sessionId, userId, role, content, citations = [], metadata = {} }) {
    return this.client.transaction(async (tx) => {
      const [created] = await tx
        .insert(chatMessage)
        .values({ citations, content, metadata, role, sessionId, userId })
        .returning();

      await tx
        .update(chatSession)
        .set({ lastMessageAt: created.createdAt, updatedAt: new Date() })
        .where(eq(chatSession.id, sessionId));

      return created;
    });
  }
  /**
   * Backwards-paginated message list. `cursor` is the OLDEST message the
   * client currently has; we return messages strictly older than that.
   * `direction = "after"` returns messages newer than the cursor.
   */
  async listMessages({
    sessionId,
    userId,
    limit = DEFAULT_PAGE_SIZE,
    cursor,
    direction = "before",
  }) {
    const pageSize = Math.min(limit, MAX_PAGE_SIZE);
    const cur = decodeCursor(cursor);

    const conditions = [eq(chatMessage.sessionId, sessionId), eq(chatMessage.userId, userId)];
    let orderClause;

    if (direction === "before") {
      if (cur) {
        conditions.push(
          or(
            lt(chatMessage.createdAt, cur.createdAt),
            and(eq(chatMessage.createdAt, cur.createdAt), lt(chatMessage.id, cur.id)),
          ),
        );
      }
      orderClause = [desc(chatMessage.createdAt), desc(chatMessage.id)];
    } else {
      if (cur) {
        conditions.push(
          or(
            gt(chatMessage.createdAt, cur.createdAt),
            and(eq(chatMessage.createdAt, cur.createdAt), gt(chatMessage.id, cur.id)),
          ),
        );
      }
      orderClause = [asc(chatMessage.createdAt), asc(chatMessage.id)];
    }

    const rows = await this.client
      .select()
      .from(chatMessage)
      .where(and(...conditions))
      .orderBy(...orderClause)
      .limit(pageSize + 1);

    const hasMore = rows.length > pageSize;
    const items = hasMore ? rows.slice(0, pageSize) : rows;
    const tail = items[items.length - 1];
    const nextCursor = hasMore && tail ? encodeCursor(tail) : null;

    // Always return chronological order to the FE so it can directly append/prepend.
    const ordered = direction === "before" ? items.slice().reverse() : items;
    return { items: ordered, nextCursor };
  }

  async countMessages(sessionId, userId) {
    const [row] = await this.client
      .select({ value: sql`count(*)::int` })
      .from(chatMessage)
      .where(and(eq(chatMessage.sessionId, sessionId), eq(chatMessage.userId, userId)));
    return Number(row?.value || 0);
  }

  async attachDocument(sessionId, userId, documentId) {
    const [updated] = await this.client
      .update(chatSession)
      .set({
        documentId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(chatSession.id, sessionId),
          eq(chatSession.userId, userId),
          eq(chatSession.softDelete, false),
        ),
      )
      .returning();

    return updated || null;
  }
}
module.exports = new ChatSessionRepository();
