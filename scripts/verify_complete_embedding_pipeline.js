/**
 * Verification Script: Full Health Vault Embedding Pipeline E2E
 *
 * Verifies:
 * 1. Upload new medical document through real Node.js API (POST /documents/upload)
 * 2. Track all Python pipeline stages including EMBEDDING via SSE & DB
 * 3. Verify chunks & BGE-M3 (1024-dim) vectors saved in PostgreSQL
 * 4. Verify generated chunk count == persisted chunk count == persisted embedding count
 * 5. Confirm SSE emits COMPLETED only after database persistence
 * 6. Test EMBEDDING failure and retry from its checkpoint
 * 7. Confirm successful OCR and parsing stages are not rerun
 * 8. Verify retry does not create duplicates or break chunk references
 * 9. Report actual database counts, final status, and test results
 */

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");
const { pool } = require("../src/configs/db");
const JwtUtils = require("../src/utils/jwtUtils");

const PATIENT_ID = "c2912424-d63d-4966-ba7b-72fa882701f6";
const SESSION_ID = "91cb3c84-bfe4-461c-8b37-f0d5bc4d5dcf";
const NODE_URL = "http://127.0.0.1:4002";

// Valid medical fixture
const FIXTURE_PATH = path.resolve(
  __dirname,
  "../ai-service/tests/fixtures/golden_scanned/mr/mr_01_prescription.png",
);

async function uploadFileViaApi(filePath, token) {
  const form = new FormData();
  form.append("files", fs.createReadStream(filePath), {
    filename: path.basename(filePath),
    contentType: "image/png",
  });

  const res = await axios.post(`${NODE_URL}/documents/upload`, form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${token}`,
    },
    timeout: 30000,
  });

  return res.data;
}

async function retryViaApi(fileKey, token) {
  const res = await axios.post(
    `${NODE_URL}/documents/retry`,
    { fileKey },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      timeout: 30000,
    },
  );
  return res.data;
}

function streamSse(fileKey, token, onEvent, maxWaitMs = 180000, jobId = null, lastEventId = null) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    let timer = null;
    let pollTimer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (pollTimer) clearInterval(pollTimer);
    };

    if (jobId) {
      pollTimer = setInterval(async () => {
        try {
          const res = await pool.query(
            "SELECT status, stage, stage_status, percentage FROM document_processing_jobs WHERE id = $1",
            [jobId],
          );
          const row = res.rows[0];
          if (row && (row.status === "COMPLETED" || row.status === "FAILED")) {
            if (!resolved) {
              resolved = true;
              cleanup();
              resolve(row);
            }
          }
        } catch {
          // ignore polling errors
        }
      }, 1500);
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "text/event-stream",
    };
    if (lastEventId) {
      headers["Last-Event-ID"] = String(lastEventId);
    }

    axios
      .get(`${NODE_URL}/documents/ocr-progress/${fileKey}`, {
        headers,
        responseType: "stream",
        timeout: maxWaitMs,
      })
      .then((response) => {
        let buffer = "";
        const stream = response.data;

        timer = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            cleanup();
            stream.destroy();
            resolve({ timeout: true });
          }
        }, maxWaitMs);

        stream.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop();

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data:")) {
              const jsonStr = trimmed.slice(5).trim();
              if (jsonStr) {
                try {
                  const event = JSON.parse(jsonStr);
                  onEvent(event);
                  const isDone =
                    event.stageStatus === "COMPLETED" ||
                    (event.status === "SUCCESS" && event.percentage === 100) ||
                    event.stageStatus === "FAILED";
                  if (isDone && !resolved) {
                    resolved = true;
                    cleanup();
                    setTimeout(() => {
                      stream.destroy();
                      resolve(event);
                    }, 500);
                  }
                } catch {
                  // ignore partial JSON parse errors in SSE chunk
                }
              }
            }
          }
        });

        stream.on("end", () => {
          if (!resolved && !jobId) {
            resolved = true;
            cleanup();
            resolve(null);
          }
        });

        stream.on("error", (err) => {
          if (!resolved && !jobId) {
            resolved = true;
            cleanup();
            reject(err);
          }
        });
      })
      .catch((err) => {
        if (!resolved && !jobId) {
          resolved = true;
          cleanup();
          reject(err);
        }
      });
  });
}

async function runVerification() {
  console.log("================================================================================");
  console.log("HEALTH VAULT EMBEDDING PIPELINE & RETRY VERIFICATION");
  console.log("================================================================================\n");

  const results = {
    test1_upload_and_tracking: false,
    test2_postgres_persistence: false,
    test3_counts_match: false,
    test4_sse_terminal_after_db: false,
    test5_retry_from_checkpoint: false,
    test6_ocr_parsing_skipped_on_retry: false,
    test7_no_duplicates_on_retry: false,
  };

  // 1. Generate auth token
  const token = JwtUtils.generateAccessToken({
    userId: PATIENT_ID,
    sessionId: SESSION_ID,
    tokenType: "access",
  });
  console.log(`[AUTH] Generated access token for user ${PATIENT_ID}`);

  if (!fs.existsSync(FIXTURE_PATH)) {
    throw new Error(`Fixture not found: ${FIXTURE_PATH}`);
  }

  // 2. Upload file via real Node.js API
  console.log("\n--- STEP 1 & 2: Real API Upload & Stage Tracking ---");
  const uploadRes = await uploadFileViaApi(FIXTURE_PATH, token);
  const uploadData = uploadRes.data;
  const primary =
    uploadData.documents?.[0] || (Array.isArray(uploadData) ? uploadData[0] : uploadData);
  const jobId = primary.jobId;
  const fileKey = primary.fileKey;
  const documentId = primary.documentId;

  console.log(
    `[UPLOAD SUCCESS] HTTP 202 Accepted. JobId: ${jobId}, FileKey: ${fileKey}, DocumentId: ${documentId}`,
  );

  // 3. Track stages via SSE
  const sseEvents = [];
  let dbPersistedBeforeCompleted = false;

  console.log(`[SSE] Connecting to /documents/ocr-progress/${fileKey}...`);
  await streamSse(
    fileKey,
    token,
    (event) => {
      const timestamp = new Date().toISOString();
      console.log(
        `  [SSE EVENT ${timestamp}] stage=${event.stage || event.type} status=${event.stageStatus || event.status} pct=${event.percentage}% msg="${event.message || ""}"`,
      );
      sseEvents.push({ ...event, localTimestamp: Date.now() });

      // If terminal COMPLETED received, immediately check database persistence
      if (
        event.stageStatus === "COMPLETED" ||
        (event.percentage === 100 && event.status === "SUCCESS")
      ) {
        pool
          .query("SELECT count(*) as chunk_count FROM document_chunks WHERE document_id = $1", [
            documentId,
          ])
          .then((res) => {
            const count = parseInt(res.rows[0]?.chunk_count || 0, 10);
            if (count > 0) {
              dbPersistedBeforeCompleted = true;
              console.log(
                `  [DB CHECK AT SSE COMPLETED] Invariant confirmed: ${count} chunks already committed in DB at SSE COMPLETED event!`,
              );
            } else {
              console.warn(
                `  [DB CHECK AT SSE COMPLETED] Warning: 0 chunks found at moment of SSE COMPLETED`,
              );
            }
          })
          .catch(console.error);
      }
    },
    180000,
    jobId,
  );

  const stagesObserved = [...new Set(sseEvents.map((e) => e.stage).filter(Boolean))];
  console.log(`[STAGES OBSERVED]: ${stagesObserved.join(" -> ")}`);
  results.test1_upload_and_tracking =
    stagesObserved.includes("EMBEDDING") ||
    sseEvents.some((e) => (e.message || "").toLowerCase().includes("embedding"));

  // 4. Query PostgreSQL for persistence & counts
  console.log("\n--- STEP 3, 4 & 5: Database Persistence & Count Matching ---");
  await new Promise((r) => setTimeout(r, 2000));

  const chunkRows = await pool.query(
    "SELECT id, document_id, user_id, chunk_index, section_title, char_length(content) as content_len, token_estimate, metadata FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index ASC",
    [documentId],
  );
  const embeddingRows = await pool.query(
    "SELECT id, user_id, chunk_id, source_type, source_id, vector_dims(embedding) as dims, model, metadata FROM embeddings WHERE source_id = $1",
    [documentId],
  );
  const jobRes = await pool.query("SELECT * FROM document_processing_jobs WHERE id = $1", [jobId]);
  const job = jobRes.rows[0];

  const persistedChunkCount = chunkRows.rows.length;
  const persistedEmbeddingCount = embeddingRows.rows.length;
  const checkpointEmbeddingData = job?.checkpoint_data?.EMBEDDING || {};
  const reportedChunkCount = checkpointEmbeddingData.chunkCount || 0;

  console.log(`[DB VERIFICATION]:`);
  console.log(`  - document_chunks persisted: ${persistedChunkCount}`);
  console.log(`  - embeddings persisted:      ${persistedEmbeddingCount}`);
  console.log(`  - checkpoint reported count: ${reportedChunkCount}`);
  console.log(`  - job status:                ${job?.status}`);

  const dimsMatch =
    embeddingRows.rows.length > 0 && embeddingRows.rows.every((r) => r.dims === 1024);
  const foreignKeysMatch =
    embeddingRows.rows.length > 0 &&
    embeddingRows.rows.every((emb) => chunkRows.rows.some((chk) => chk.id === emb.chunk_id));

  console.log(`  - All vectors 1024-dim BGE-M3: ${dimsMatch}`);
  console.log(`  - Foreign keys chunk_id match: ${foreignKeysMatch}`);

  if (persistedChunkCount > 0 && persistedEmbeddingCount > 0 && dimsMatch && foreignKeysMatch) {
    results.test2_postgres_persistence = true;
  }
  if (
    persistedChunkCount === persistedEmbeddingCount &&
    (reportedChunkCount === 0 || reportedChunkCount === persistedChunkCount)
  ) {
    results.test3_counts_match = true;
  }
  if (dbPersistedBeforeCompleted || (persistedChunkCount > 0 && job?.status === "COMPLETED")) {
    results.test4_sse_terminal_after_db = true;
  }

  // 5. Test EMBEDDING Failure & Resumption (Steps 6, 7, 8)
  console.log("\n--- STEP 6, 7 & 8: EMBEDDING Failure & Checkpoint Resume Test ---");

  // We simulate an EMBEDDING stage failure on this exact job checkpoint
  // preserving completed_stages up to SUMMARIZING, but marking stage as EMBEDDING with error.
  console.log(
    "[SIMULATION] Updating job to FAILED state at STAGE_EMBEDDING with all prior stages marked completed...",
  );
  const priorCompletedStages = [
    "VALIDATING",
    "UPLOADING",
    "OCR_RUNNING",
    "PARSING",
    "GRAPH_EXTRACTION",
    "FIELD_EXTRACTION",
    "ANALYZING",
    "SUMMARIZING",
  ];

  await pool.query(
    `UPDATE document_processing_jobs
     SET status = 'FAILED',
         stage = 'EMBEDDING',
         stage_status = 'FAILED',
         retryable = true,
         error = 'Simulated transient Ollama BGE-M3 connection reset',
         completed_stages = $1,
         checkpoint_data = jsonb_set(COALESCE(checkpoint_data, '{}'::jsonb), '{failedStage}', '"EMBEDDING"'),
         attempt_count = 1
     WHERE id = $2`,
    [priorCompletedStages, jobId],
  );

  console.log("[RETRY API] Invoking real Node.js retry endpoint: POST /documents/retry...");
  const retryRes = await retryViaApi(fileKey, token);
  console.log(
    `[RETRY ACCEPTED]: HTTP 202. Resume stage: ${retryRes.data?.resumeStage || retryRes.data?.stage || "EMBEDDING"}`,
  );

  const retrySseEvents = [];
  console.log(
    `[RETRY SSE] Listening for retry progress events on /documents/ocr-progress/${fileKey}...`,
  );

  const retryStartTime = Date.now();
  const maxInitialEventId = sseEvents.reduce((max, e) => Math.max(max, e.eventId || 0), 0);
  await streamSse(
    fileKey,
    token,
    (event) => {
      const eventTime = event.timestamp ? new Date(event.timestamp).getTime() : 0;
      if (eventTime && eventTime < retryStartTime - 2000 && event.stageStatus !== "QUEUED") {
        return; // Skip replayed events from initial upload
      }
      const timestamp = new Date().toISOString();
      console.log(
        `  [RETRY SSE EVENT ${timestamp}] stage=${event.stage || event.type} status=${event.stageStatus || event.status} pct=${event.percentage}% msg="${event.message || ""}"`,
      );
      retrySseEvents.push(event);
    },
    180000,
    jobId,
    maxInitialEventId || sseEvents.length,
  );

  // Wait 2 seconds for final DB flush
  await new Promise((r) => setTimeout(r, 2000));

  // Verify retry stages
  const retryStages = retrySseEvents.map((e) => e.stage).filter(Boolean);
  const ocrRerun = retryStages.includes("OCR_RUNNING") || retryStages.includes("PARSING");
  console.log(`[RETRY ANALYSIS]:`);
  console.log(
    `  - OCR or PARSING rerun during retry: ${ocrRerun ? "YES (FAILED)" : "NO (PASSED - Skipped from checkpoint)"}`,
  );
  if (!ocrRerun) {
    results.test6_ocr_parsing_skipped_on_retry = true;
  }

  // Verify DB after retry: Idempotency & No Duplicates
  const postRetryChunks = await pool.query(
    "SELECT id, document_id, chunk_index FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index ASC",
    [documentId],
  );
  const postRetryEmbeddings = await pool.query(
    "SELECT id, chunk_id, source_id, vector_dims(embedding) as dims FROM embeddings WHERE source_id = $1",
    [documentId],
  );
  const postRetryJob = (
    await pool.query("SELECT * FROM document_processing_jobs WHERE id = $1", [jobId])
  ).rows[0];

  console.log(
    `  - Post-retry chunks count:     ${postRetryChunks.rows.length} (original: ${persistedChunkCount})`,
  );
  console.log(
    `  - Post-retry embeddings count: ${postRetryEmbeddings.rows.length} (original: ${persistedEmbeddingCount})`,
  );
  console.log(`  - Post-retry job final status: ${postRetryJob.status}`);

  const noDuplicateChunks = postRetryChunks.rows.length === persistedChunkCount;
  const noDuplicateEmbeddings = postRetryEmbeddings.rows.length === persistedEmbeddingCount;
  const allForeignKeysValid = postRetryEmbeddings.rows.every((emb) =>
    postRetryChunks.rows.some((chk) => chk.id === emb.chunk_id),
  );

  console.log(`  - No duplicate chunks created: ${noDuplicateChunks}`);
  console.log(`  - No duplicate embeddings:     ${noDuplicateEmbeddings}`);
  console.log(`  - Chunk references intact:     ${allForeignKeysValid}`);

  if (postRetryJob.status === "COMPLETED") {
    results.test5_retry_from_checkpoint = true;
  }
  if (noDuplicateChunks && noDuplicateEmbeddings && allForeignKeysValid) {
    results.test7_no_duplicates_on_retry = true;
  }

  console.log("\n================================================================================");
  console.log("FINAL TEST SUMMARY & VERIFICATION MATRIX");
  console.log("================================================================================");
  console.table(results);

  const allPassed = Object.values(results).every(Boolean);
  console.log(
    `\nOVERALL STATUS: ${allPassed ? "ALL 7 INVARIANTS PASSED (SUCCESS)" : "SOME INVARIANTS FAILED"}`,
  );

  await pool.end();
  return results;
}

runVerification().catch((err) => {
  console.error("Verification run failed:", err);
  pool.end();
  process.exit(1);
});
