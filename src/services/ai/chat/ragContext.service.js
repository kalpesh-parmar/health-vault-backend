const DocumentIntelligenceRepository = require("../../../repositories/documentIntelligenceRepository");
const intelligenceRepository = new DocumentIntelligenceRepository();
const { normalizeLanguage } = require("../../../utils/commonUtils");
const { containsEntity } = require("../../../utils/synonyms");

// Debug logger
const debugLogger = {
  // eslint-disable-next-line no-console
  info: (msg, data) => console.log(`[DEBUG] ${msg}`, JSON.stringify(data, null, 2)),
  // eslint-disable-next-line no-console
  error: (msg, data) => console.error(`[DEBUG ERROR] ${msg}`, JSON.stringify(data, null, 2)),
};

/**
 * Calculates human-readable localized report age string (e.g., "2 days old", "Today").
 * @param {Date|string} reportDate - Report timestamp or date
 * @param {string} language - Target language code/name
 * @returns {string} Localized age description
 */
function getReportAgeString(reportDate, language) {
  if (!reportDate) return "";
  const date = new Date(reportDate);
  if (isNaN(date.getTime())) return "";

  const today = new Date();
  const d1 = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const d2 = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  const diffTime = d2.getTime() - d1.getTime();
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

  const normLang = normalizeLanguage(language);

  if (diffDays <= 0) {
    const todayLabels = {
      english: "Today",
      gujarati: "આજનો",
      hindi: "आज का",
      marathi: "आजचा",
      tamil: "இன்றைய",
    };
    return todayLabels[normLang] || todayLabels.english;
  }

  if (diffDays < 30) {
    if (normLang === "english") {
      return diffDays === 1 ? "1 day old" : `${diffDays} days old`;
    } else if (normLang === "gujarati") {
      return `${diffDays} દિવસ જૂનો`;
    } else if (normLang === "hindi") {
      return `${diffDays} दिन पुराना`;
    } else if (normLang === "marathi") {
      return `${diffDays} दिवस जुना`;
    } else if (normLang === "tamil") {
      return `${diffDays} நாள் பழமையானது`;
    }
  }

  const diffMonths = Math.floor(diffDays / 30);
  if (diffDays < 365) {
    if (normLang === "english") {
      return diffMonths === 1 ? "1 month old" : `${diffMonths} months old`;
    } else if (normLang === "gujarati") {
      return `${diffMonths} મહિના જૂનો`;
    } else if (normLang === "hindi") {
      return `${diffMonths} महीने पुराना`;
    } else if (normLang === "marathi") {
      return `${diffMonths} महिने जुना`;
    } else if (normLang === "tamil") {
      return `${diffMonths} மாதங்கள் பழமையானது`;
    }
  }

  const diffYears = Math.floor(diffDays / 365);
  if (normLang === "english") {
    return diffYears === 1 ? "1 year old" : `${diffYears} years old`;
  } else if (normLang === "gujarati") {
    return `${diffYears} વર્ષ જૂનો`;
  } else if (normLang === "hindi") {
    return `${diffYears} साल पुराना`;
  } else if (normLang === "marathi") {
    return `${diffYears} वर्षे जुना`;
  } else if (normLang === "tamil") {
    return `${diffYears} ஆண்டுகள் பழமையானது`;
  }

  return "";
}

/**
 * Smart context builder for patient profile active medications.
 * Implements capping (top 25) and dynamic keyword matching for 1,000+ scale.
 *
 * @param {Array} medications - Array of medication DB records
 * @param {string} userQuestion - User question string
 * @returns {string} Formatted active medications context text
 */
function buildMedicationsContext(medications = [], userQuestion = "") {
  if (!Array.isArray(medications) || medications.length === 0) {
    return "Active Profile Medications:\nNone";
  }

  const cleanQuestion = String(userQuestion || "").toLowerCase();
  const totalCount = medications.length;

  let selectedMeds = [];

  if (totalCount <= 25) {
    selectedMeds = medications;
  } else {
    // Rank/search: prioritize medications matching user question words
    const matchedMeds = medications.filter((med) => {
      if (!med.medicationName) return false;
      const medNameClean = med.medicationName.toLowerCase().trim();
      if (cleanQuestion.includes(medNameClean)) return true;
      const words = medNameClean.split(/\s+/).filter((w) => w.length > 2);
      return words.some((w) => cleanQuestion.includes(w));
    });
    const matchedIds = new Set(matchedMeds.map((m) => m.id));
    const remainingMeds = medications.filter((m) => !matchedIds.has(m.id));

    const maxRemaining = Math.max(0, 25 - matchedMeds.length);
    selectedMeds = [...matchedMeds, ...remainingMeds.slice(0, maxRemaining)];
  }

  const formattedList = selectedMeds
    .map((m) => {
      const name = m.medicationName || "Unknown Medicine";
      const type = m.medicationType ? ` (${m.medicationType})` : "";
      const dose = m.dosePerIntake ? `${m.dosePerIntake}` : "";
      const unit = m.unit ? ` ${m.unit}` : "";
      const doseStr = dose || unit ? `: ${dose}${unit}` : "";
      const freq = m.frequency ? `, Frequency: ${m.frequency}` : "";
      const food = m.foodFrequency ? ` (${m.foodFrequency})` : "";

      let scheduleStr = "";
      if (m.medicationSchedule && typeof m.medicationSchedule === "object") {
        const times = Object.entries(m.medicationSchedule)
          .filter(([, v]) => v)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ");
        if (times) scheduleStr = `, Schedule: [${times}]`;
      }

      const doctor = m.prescribedBy ? `, Prescribed By: ${m.prescribedBy}` : "";
      const notes = m.notes ? `, Notes: ${m.notes}` : "";

      return `- ${name}${type}${doseStr}${freq}${food}${scheduleStr}${doctor}${notes}`;
    })
    .join("\n");

  const header =
    totalCount > 25
      ? `Active Profile Medications (Total: ${totalCount}, Showing top 25 most relevant):`
      : `Active Profile Medications (${totalCount}):`;

  return `${header}\n${formattedList}`;
}

/**
 * Extracts recognized clinical and biomarker entities from user text.
 * @param {string} question - Query text
 * @returns {Array<string>} List of matched entity keys
 */
function getMedicalEntityKeywords(question) {
  if (!question) return [];
  const entities = [
    { key: "hemoglobin", regex: /hemoglobin|haemoglobin|hb|hgb/i },
    { key: "glucose", regex: /glucose|blood sugar|sugar|hba1c/i },
    { key: "rbc", regex: /rbc|red blood cell/i },
    { key: "wbc", regex: /wbc|white blood cell/i },
    { key: "platelets", regex: /platelets?/i },
    { key: "creatinine", regex: /creatinine/i },
    { key: "cholesterol", regex: /cholesterol|lipid/i },
    { key: "vitamin d", regex: /vitamin d|vit d/i },
    { key: "tsh", regex: /tsh|thyroid/i },
  ];
  const found = [];
  for (const entity of entities) {
    if (entity.regex.test(question)) {
      found.push(entity.key);
    }
  }
  return found;
}

class RagContextService {
  /**
   * Retrieves, deduplicates, and ranks document context chunks for RAG queries.
   *
   * @param {object} params
   * @param {string} params.userId - Authenticated user ID (tenant isolation)
   * @param {string} params.retrievalQuery - Sanitized user question
   * @param {Array<number>} params.queryEmbedding - Vector embedding of user query
   * @param {Array<string>} params.finalDocumentIds - Target document IDs
   * @param {string} params.documentScope - Scope ("FULL_DOCUMENT" | "SINGLE_DOCUMENT" | "ALL_DOCUMENTS")
   * @param {object} params.docNameMap - Map of document metadata by document ID
   * @param {string} params.detectedLanguage - Normalized language string
   * @param {string} [params.intent] - Query intent
   * @returns {Promise<{ summaryChunks: Array, coverageStr: string, relevantChunksCount: number }>}
   */
  async retrieveRagContext({
    userId,
    retrievalQuery,
    queryEmbedding,
    finalDocumentIds = [],
    documentScope = "ALL_DOCUMENTS",
    docNameMap = {},
    detectedLanguage = "english",
    intent = "DOCUMENT",
  }) {
    let summaryChunks = [];
    let coverageStr = "";
    let relevantChunks = [];

    const retrieveStartTime = Date.now();
    const lowerQ = retrievalQuery.toLowerCase();

    let detectedSectionType = null;
    if (
      lowerQ.includes("summary") ||
      lowerQ.includes("overview") ||
      documentScope === "FULL_DOCUMENT"
    ) {
      detectedSectionType = "summary";
    }

    const medicalEntities = getMedicalEntityKeywords(lowerQ);
    const entitiesFoundPerDoc = new Map();

    if (finalDocumentIds && finalDocumentIds.length > 0) {
      finalDocumentIds.forEach((id) => entitiesFoundPerDoc.set(String(id), new Set()));

      if (documentScope === "FULL_DOCUMENT" && finalDocumentIds.length === 1) {
        const structuredDoc = await intelligenceRepository.findStructuredDocumentByDocumentId(
          finalDocumentIds[0],
          userId,
        );
        if (structuredDoc && structuredDoc.rawText) {
          summaryChunks = [
            {
              chunkId: "full-doc",
              documentId: finalDocumentIds[0],
              sectionTitle: "Complete Document",
              content: structuredDoc.rawText.substring(0, 40000),
              sourceType: "rawText",
              docData: docNameMap[finalDocumentIds[0]] || {},
            },
          ];
          debugLogger.info(
            `sendMessage: [SCOPE] ${JSON.stringify({ detectedLanguage, intent, documentScope, requestedDocumentCount: 1 })}`,
          );
          debugLogger.info(`sendMessage: [RETRIEVAL] Fetched full document raw text directly.`);
          return {
            summaryChunks,
            coverageStr: "",
            relevantChunksCount: 1,
          };
        }
      }

      if (summaryChunks.length === 0) {
        // PARALLEL RETRIEVAL (Per Document + Per Entity)
        const queryPromises = [];

        for (const dId of finalDocumentIds) {
          if (medicalEntities.length > 0) {
            for (const entity of medicalEntities) {
              queryPromises.push(
                (async () => {
                  try {
                    const chunks = await intelligenceRepository.searchSimilarChunks({
                      userId,
                      queryEmbedding,
                      limit: 10,
                      documentIds: [dId],
                      keywords: [entity],
                    });
                    return { dId, entity, chunks, success: true };
                  } catch (err) {
                    debugLogger.error(
                      `Failed to retrieve chunks for doc ${dId} and entity ${entity}`,
                      {
                        error: err.message,
                      },
                    );
                    return { dId, entity, chunks: [], success: false };
                  }
                })(),
              );
            }
          } else {
            queryPromises.push(
              (async () => {
                try {
                  const chunks = await intelligenceRepository.searchSimilarChunks({
                    userId,
                    queryEmbedding,
                    limit: 20,
                    documentIds: [dId],
                  });
                  return { dId, entity: null, chunks, success: true };
                } catch (err) {
                  // eslint-disable-next-line no-console
                  console.log("err", err);
                  return { dId, entity: null, chunks: [], success: false };
                }
              })(),
            );
          }
        }

        const queryResults = await Promise.all(queryPromises);

        // Track retrieval status and calculate detailed statuses
        let retrievedCount = 0;
        const retrievedDocs = new Set();
        for (const r of queryResults) {
          if (r.success && r.chunks.length > 0) {
            retrievedDocs.add(String(r.dId));
          }
          relevantChunks.push(...r.chunks);
        }
        retrievedCount = retrievedDocs.size;

        const entityStatusPerDoc = new Map(); // Key: `${docIdStr}_${entity}`, Value: 'FOUND' | 'NOT_FOUND_VERIFIED' | 'NOT_VERIFIED'

        for (const dId of finalDocumentIds) {
          const docIdStr = String(dId);
          const docData = docNameMap[dId] || {};

          for (const entity of medicalEntities) {
            const statusKey = `${docIdStr}_${entity}`;
            const qRes = queryResults.find(
              (r) => String(r.dId) === docIdStr && r.entity === entity,
            );

            if (!qRes || !qRes.success) {
              entityStatusPerDoc.set(statusKey, "NOT_VERIFIED");
              continue;
            }

            const foundInChunks = qRes.chunks.some((c) => containsEntity(c.content, entity));
            let foundInSummary = false;
            if (
              docData.structuredExtractedData?.tests &&
              Array.isArray(docData.structuredExtractedData.tests)
            ) {
              foundInSummary = docData.structuredExtractedData.tests.some((t) => {
                const testNameLower = t.name?.toLowerCase() || "";
                return containsEntity(testNameLower, entity);
              });
            }

            if (foundInChunks || foundInSummary) {
              entityStatusPerDoc.set(statusKey, "FOUND");
              entitiesFoundPerDoc.get(docIdStr).add(entity);
            } else {
              entityStatusPerDoc.set(statusKey, "NOT_FOUND_VERIFIED");
            }
          }
        }

        // 1. Deduplicate by chunkId + documentId to preserve same-text chunks across different docs
        const uniqueChunks = [];
        const seenChunks = new Set();
        for (const c of relevantChunks) {
          const chunkKey = `${c.documentId}_${c.chunkId}`;
          if (!seenChunks.has(chunkKey)) {
            seenChunks.add(chunkKey);
            uniqueChunks.push(c);
          }
        }

        // 2. Summary Preference
        let filteredChunks = uniqueChunks;
        if (detectedSectionType === "summary") {
          const docsWithSummary = new Set(
            uniqueChunks.filter((c) => c.sourceType === "summary").map((c) => String(c.documentId)),
          );
          filteredChunks = uniqueChunks.filter((c) => {
            if (c.sourceType === "ocr" && docsWithSummary.has(String(c.documentId))) return false;
            return true;
          });
        }

        // 3. Selection Algorithm (Coverage-Aware)
        const chunksPerDoc = new Map();
        const finalSelection = [];

        // Sort globally first
        filteredChunks.sort((a, b) => (a.distance || 0) - (b.distance || 0));

        // Pass 1: Prioritize exact medical entity matches
        for (const c of filteredChunks) {
          const docIdStr = String(c.documentId);
          let hasEntity = false;

          for (const entity of medicalEntities) {
            if (containsEntity(c.content, entity)) {
              entitiesFoundPerDoc.get(docIdStr).add(entity);
              hasEntity = true;
            }
          }

          const count = chunksPerDoc.get(docIdStr) || 0;
          if (hasEntity && count < 4) {
            if (!finalSelection.includes(c)) {
              finalSelection.push(c);
              chunksPerDoc.set(docIdStr, count + 1);
            }
          }
        }

        // Pass 2: Fill remaining up to MAX_CONTEXT_CHUNKS (25)
        const MAX_CONTEXT_CHUNKS = 25;
        for (const c of filteredChunks) {
          if (finalSelection.length >= MAX_CONTEXT_CHUNKS) break;
          const docIdStr = String(c.documentId);
          const count = chunksPerDoc.get(docIdStr) || 0;

          if (count < 6 && !finalSelection.includes(c)) {
            finalSelection.push(c);
            chunksPerDoc.set(docIdStr, count + 1);
          }
        }

        summaryChunks = finalSelection.map((c, index) => {
          const docData = docNameMap[c.documentId] || {};
          return {
            chunkId: c.chunkId || `chunk-${index}`,
            documentId: c.documentId,
            sectionTitle: c.sectionTitle,
            content: c.content,
            score: 1.0,
            sourceType: c.sourceType || "document",
            docData: docData,
          };
        });

        // Structured Logging
        const coverageObj = {};
        finalDocumentIds.forEach((id) => {
          coverageObj[id] = Array.from(entitiesFoundPerDoc.get(String(id)) || []);
        });
        const chunksPerDocLog = Object.fromEntries(chunksPerDoc);

        debugLogger.info(
          `sendMessage: [SCOPE] ${JSON.stringify({ detectedLanguage, intent, documentScope, requestedDocumentCount: finalDocumentIds.length })}`,
        );
        debugLogger.info(
          `sendMessage: [RETRIEVAL] ${JSON.stringify({ query: retrievalQuery, entities: medicalEntities, retrievedChunkCount: relevantChunks.length, duration: Date.now() - retrieveStartTime })}`,
        );
        debugLogger.info(
          `sendMessage: [COVERAGE] ${JSON.stringify({ requestedDocuments: finalDocumentIds.length, retrievedDocuments: retrievedCount, missingDocuments: finalDocumentIds.length - retrievedCount, entitiesFound: coverageObj })}`,
        );
        debugLogger.info(
          `sendMessage: [SELECTION] ${JSON.stringify({ selectedChunks: summaryChunks.length, chunksPerDocument: chunksPerDocLog })}`,
        );

        // Build coverage string for Qwen
        if (medicalEntities.length > 0) {
          coverageStr = finalDocumentIds
            .map((id) => {
              const docIdStr = String(id);
              let docLabel = `Document ${id}`;
              if (docNameMap[id]) docLabel = docNameMap[id].fileName || docLabel;

              const entityStatuses = medicalEntities.map((entity) => {
                const statusKey = `${docIdStr}_${entity}`;
                const status = entityStatusPerDoc.get(statusKey) || "NOT_VERIFIED";
                return `${entity.toUpperCase()}: ${status}`;
              });

              return `${docLabel}: [${entityStatuses.join(", ")}]`;
            })
            .join("\n");
        }
      }
    }

    return {
      summaryChunks,
      coverageStr,
      relevantChunksCount: relevantChunks.length,
    };
  }
}

const ragContextService = new RagContextService();

module.exports = {
  getReportAgeString,
  buildMedicationsContext,
  getMedicalEntityKeywords,
  RagContextService,
  ragContextService,
};
