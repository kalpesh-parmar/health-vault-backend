DROP INDEX IF EXISTS "embeddings_hnsw_idx";
ALTER TABLE "embeddings" ALTER COLUMN "embedding" SET DATA TYPE vector(768);
CREATE INDEX IF NOT EXISTS "embeddings_hnsw_idx" ON "embeddings" USING hnsw ("embedding" vector_cosine_ops);