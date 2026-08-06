const { db, pool } = require("../configs/db");
const { documentChunk, embedding } = require("../models/documentIntelligence");
const { eq, isNull, sql } = require("drizzle-orm");
const { embeddingService } = require("../services/ai/chat/embedding.service");
const { env } = require("../configs/env");

async function limitConcurrency(tasks, limit) {
  const executing = new Set();
  for (const task of tasks) {
    const p = Promise.resolve()
      .then(() => task())
      .then(() => executing.delete(p));
    executing.add(p);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
}

async function main() {
  console.log("[Backfill] Starting embedding backfill...");
  console.log(`[Backfill] Target model: ${env.embeddingModel || "bge-m3:latest"}`);
  console.log(`[Backfill] Concurrency limit: ${env.aiPageConcurrency || 4}`);

  try {
    // 1. Get total count of chunks needing embeddings
    const countRes = await db
      .select({ count: sql`count(*)` })
      .from(documentChunk)
      .leftJoin(embedding, eq(documentChunk.id, embedding.chunkId))
      .where(isNull(embedding.id));

    const total = Number(countRes[0]?.count || 0);
    console.log(`[Backfill] Found ${total} chunks needing embeddings.`);

    if (total === 0) {
      console.log("[Backfill] No chunks need backfilling. Exiting.");
      return;
    }

    let processed = 0;
    const startTime = Date.now();

    while (true) {
      const chunks = await db
        .select({
          id: documentChunk.id,
          content: documentChunk.content,
          userId: documentChunk.userId,
          sourceType: documentChunk.sourceType,
          metadata: documentChunk.metadata,
        })
        .from(documentChunk)
        .leftJoin(embedding, eq(documentChunk.id, embedding.chunkId))
        .where(isNull(embedding.id))
        .limit(50);

      if (chunks.length === 0) {
        break;
      }

      const concurrencyLimit = env.aiPageConcurrency || 4;
      const tasks = chunks.map((chunk) => async () => {
        let attempts = 0;
        let vector = null;

        while (attempts < 3) {
          try {
            vector = await embeddingService.embedText(chunk.content);
            if (Array.isArray(vector) && vector.length === 1024) {
              break;
            }
            throw new Error(`Embedding length mismatch: expected 1024, got ${vector?.length}`);
          } catch (err) {
            attempts++;
            const delay = 1000 * Math.pow(2, attempts - 1);
            console.warn(
              `[Backfill] Failed to embed chunk ${chunk.id} (attempt ${attempts}/3). Retrying in ${delay}ms... Error: ${err.message}`,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }

        if (!vector) {
          console.error(`[Backfill] Failed to embed chunk ${chunk.id} after 3 attempts. Skipping.`);
          return;
        }

        try {
          await db.insert(embedding).values({
            userId: chunk.userId,
            chunkId: chunk.id,
            sourceType: chunk.sourceType,
            sourceId: chunk.id,
            embedding: vector,
            model: env.embeddingModel || "bge-m3:latest",
            metadata: chunk.metadata || {},
          });
        } catch (err) {
          console.error(`[Backfill] Failed to save embedding for chunk ${chunk.id}:`, err.message);
        }
      });

      await limitConcurrency(tasks, concurrencyLimit);

      processed += chunks.length;
      const elapsed = (Date.now() - startTime) / 1000;
      const speed = processed / elapsed;
      const remaining = total - processed;
      const eta = speed > 0 ? remaining / speed : 0;

      const etaMin = Math.floor(eta / 60);
      const etaSec = Math.floor(eta % 60);

      console.log(
        `[Backfill] Processed ${processed}/${total} chunks (${((processed / total) * 100).toFixed(
          1,
        )}%) - Elapsed: ${Math.floor(elapsed / 60)}m ${Math.floor(
          elapsed % 60,
        )}s - ETA: ${etaMin}m ${etaSec}s`,
      );
    }

    console.log("[Backfill] Completed all chunk embeddings successfully.");
  } catch (err) {
    console.error("[Backfill] Fatal error running backfill:", err);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

main();
