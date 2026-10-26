const { and, eq, desc, lt, ne } = require("drizzle-orm");
const { db } = require("../../../configs/db");
const { document } = require("../../../models/document");
const { normalizeDocumentType } = require("../../../enums/documentType");

const HISTORICAL_PATTERNS = [
  /\b(all|entire|lifetime|overall|complete|across all|over time)\s+(?:of\s+|my\s+|the\s+)*(reports?|records?|tests?|history|results?)\b/i,
  /\bacross\s+(?:all\s+)?(?:of\s+|my\s+|the\s+)*(reports?|records?|tests?)\b/i,
  /\b(in all my|across my|from all)\b/i,
  /\b(over time|trend over years|long term)\b/i,
  /\b(?:trend|month-wise|year-wise|date-wise|timeline|progression)\b/i,
  /\b(?:trend|chart|graph)\s+(?:chart|graph)?\b/i,
  /(બધા|તમામ)\s*(રિપોર્ટ|ટેસ્ટ|રેકોર્ડ|ઇતિહાસ)/i,
  /(બધામાં|તમામમાં)/i,
  /(सारे|सभी|तमाम|पूरे)\s*(रिपोर्ट|टेस्ट|रिकॉर्ड|इतिहास)/i,
  /(सबमें|सारे में|सभी में)/i,
  /(सर्व|सगळे)\s*(अहवाल|तपासणी|नोंदी)/i,
  /(அனைத்து|முழு)\s*(அறிக்கை|பரிசோதனை)/i,
];

const COMPARISON_PATTERNS = [
  /\b(compare|comparison|previous|earlier|last time|difference between|versus|vs)\b/i,
  /\b(how has it changed|trend since last|compared to)\b/i,
  /(સરખામણી|અગાઉનો|પહેલાનો|ગત|છેલ્લી વખત)/i,
  /(तुलना|पिछली|पहले वाली|फर्क|बदलाव)/i,
  /(तुलना|मागील|आधीचा)/i,
  /(ஒப்பீடு|முந்தைய|கடந்த)/i,
];

const MONTH_NAMES = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
  // Indic months / transliterations
  જાન્યુઆરી: 1,
  ફેબ્રુઆરી: 2,
  માર્ચ: 3,
  એપ્રિલ: 4,
  મે: 5,
  જૂન: 6,
  જુલાઈ: 7,
  ઓગસ્ટ: 8,
  સપ્ટેમ્બર: 9,
  ઓક્ટોબર: 10,
  નવેમ્બર: 11,
  ડિસેમ્બર: 12,
  जनवरी: 1,
  फरवरी: 2,
  मार्च: 3,
  अप्रैल: 4,
  मई: 5,
  जून: 6,
  जुलाई: 7,
  अगस्त: 8,
  सितंबर: 9,
  अक्टूबर: 10,
  नवंबर: 11,
  दिसंबर: 12,
};

class DocumentResolverService {
  isExplicitHistoricalQuery(text) {
    if (!text || typeof text !== "string") return false;
    return HISTORICAL_PATTERNS.some((pattern) => pattern.test(text));
  }

  isComparisonQuery(text) {
    if (!text || typeof text !== "string") return false;
    return COMPARISON_PATTERNS.some((pattern) => pattern.test(text));
  }

  /**
   * Find the chronological predecessor report for a given active document.
   */
  async resolvePredecessorDocument(userId, currentDocumentId) {
    if (!userId || !currentDocumentId) return null;

    const [currentDoc] = await db
      .select()
      .from(document)
      .where(
        and(
          eq(document.id, currentDocumentId),
          eq(document.userId, userId),
          eq(document.softDelete, false),
        ),
      )
      .limit(1);

    if (!currentDoc) return null;

    const currentDate = currentDoc.reportDate || currentDoc.createdAt;

    // 1. First try to find predecessor of the same documentType
    const sameTypePredecessors = await db
      .select()
      .from(document)
      .where(
        and(
          eq(document.userId, userId),
          eq(document.softDelete, false),
          eq(document.documentType, currentDoc.documentType),
          ne(document.id, currentDocumentId),
          lt(document.reportDate || document.createdAt, currentDate),
        ),
      )
      .orderBy(desc(document.reportDate), desc(document.createdAt))
      .limit(1);

    if (sameTypePredecessors.length > 0) {
      return sameTypePredecessors[0];
    }

    // 2. Fallback to any predecessor report
    const anyPredecessors = await db
      .select()
      .from(document)
      .where(
        and(
          eq(document.userId, userId),
          eq(document.softDelete, false),
          ne(document.id, currentDocumentId),
          lt(document.reportDate || document.createdAt, currentDate),
        ),
      )
      .orderBy(desc(document.reportDate), desc(document.createdAt))
      .limit(1);

    return anyPredecessors[0] || null;
  }

  /**
   * Resolves document scope from natural language query and conversation context.
   */
  async resolveNaturalLanguageScope(userId, question, existingSlots = {}) {
    if (!userId || !question || typeof question !== "string") {
      return { resolved: false };
    }

    const lowerQ = question.toLowerCase();

    // 1. Explicit historical scope request
    if (this.isExplicitHistoricalQuery(question)) {
      return {
        resolved: true,
        scopeMode: "AUTHORIZED_HISTORY",
        documentIds: [],
        isHistorical: true,
      };
    }

    // 2. Comparison request with active context
    if (this.isComparisonQuery(question)) {
      const activeDocId =
        existingSlots.activeDocumentId ||
        (existingSlots.activeDocumentIds && existingSlots.activeDocumentIds[0]);

      if (activeDocId) {
        const predecessor = await this.resolvePredecessorDocument(userId, activeDocId);
        if (predecessor) {
          return {
            resolved: true,
            scopeMode: "MULTI_DOCUMENT",
            documentIds: [activeDocId, predecessor.id],
            comparison: true,
            predecessorDoc: predecessor,
          };
        }
      }
    }

    // 3. Natural language entity extraction (Hospital, Doctor, Date, Document Type)
    const userDocs = await db
      .select()
      .from(document)
      .where(and(eq(document.userId, userId), eq(document.softDelete, false)))
      .orderBy(desc(document.reportDate), desc(document.createdAt))
      .limit(100);

    if (!userDocs || userDocs.length === 0) {
      return { resolved: false };
    }

    // Extract potential year
    const yearMatch = question.match(/\b(20\d{2})\b/);
    const targetYear = yearMatch ? parseInt(yearMatch[1], 10) : null;

    // Extract potential month
    let targetMonth = null;
    for (const [mName, mNum] of Object.entries(MONTH_NAMES)) {
      if (lowerQ.includes(mName)) {
        targetMonth = mNum;
        break;
      }
    }

    // Score user's documents against question
    const scoredDocs = [];

    for (const doc of userDocs) {
      let score = 0;
      const matchedFeatures = [];

      // Hospital / Clinic Match
      if (doc.hospitalName) {
        const STOP_WORDS = new Set([
          "doctor",
          "hospital",
          "clinic",
          "center",
          "care",
          "char",
          "road",
          "rasta",
          "near",
          "opposite",
          "opp",
          "street",
          "lane",
          "plaza",
          "house",
        ]);
        const hospTokens = doc.hospitalName
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, " ")
          .split(/\s+/)
          .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
        for (const token of hospTokens) {
          const re = new RegExp(`\\b${token}\\b`, "i");
          if (re.test(lowerQ)) {
            score += 3;
            matchedFeatures.push(`hospital: ${token}`);
            break;
          }
        }
      }

      // Doctor Name Match
      if (doc.doctorName) {
        const docTokens = doc.doctorName
          .toLowerCase()
          .replace(/^dr\.?\s*/i, "")
          .replace(/[^a-z0-9\s]/g, " ")
          .split(/\s+/)
          .filter((t) => t.length > 2 && !["doctor", "consultant", "physician"].includes(t));
        for (const token of docTokens) {
          const re = new RegExp(`\\b${token}\\b`, "i");
          if (re.test(lowerQ)) {
            score += 3;
            matchedFeatures.push(`doctor: ${token}`);
            break;
          }
        }
      }

      // File Name Match
      if (doc.fileName) {
        const fileBase = doc.fileName.toLowerCase().replace(/\.[^/.]+$/, "");
        if (fileBase.length > 3 && lowerQ.includes(fileBase)) {
          score += 4;
          matchedFeatures.push(`filename: ${fileBase}`);
        }
      }

      // Date / Year Match
      const docDate = doc.reportDate ? new Date(doc.reportDate) : new Date(doc.createdAt);
      if (targetYear && docDate.getFullYear() === targetYear) {
        score += 2;
        matchedFeatures.push(`year: ${targetYear}`);
      }
      if (targetMonth && docDate.getMonth() + 1 === targetMonth) {
        score += 2;
        matchedFeatures.push(`month: ${targetMonth}`);
      }

      // Document Type Match
      const normalizedQueryType = normalizeDocumentType(question);
      if (
        normalizedQueryType &&
        normalizedQueryType !== "OTHER_MEDICAL_DOCUMENT" &&
        doc.documentType === normalizedQueryType
      ) {
        score += 1.5;
        matchedFeatures.push(`type: ${doc.documentType}`);
      }

      if (score >= 3) {
        scoredDocs.push({ doc, score, matchedFeatures });
      }
    }

    if (scoredDocs.length === 0) {
      return { resolved: false };
    }

    // Sort by score descending, then date descending
    scoredDocs.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const dateA = a.doc.reportDate ? new Date(a.doc.reportDate) : new Date(a.doc.createdAt);
      const dateB = b.doc.reportDate ? new Date(b.doc.reportDate) : new Date(b.doc.createdAt);
      return dateB - dateA;
    });

    const topScore = scoredDocs[0].score;
    const topMatches = scoredDocs.filter((m) => m.score === topScore);

    // Exactly one clear best match
    if (topMatches.length === 1) {
      const match = topMatches[0].doc;
      return {
        resolved: true,
        scopeMode: "SINGLE_DOCUMENT",
        documentIds: [match.id],
        matchedDoc: match,
        confidence: topMatches[0].score,
      };
    }

    // Ambiguous matches -> Trigger REQUIRE_DOCUMENT_SELECTION
    return {
      resolved: false,
      scopeMode: "REQUIRE_DOCUMENT_SELECTION",
      promptClarification: true,
      candidateDocuments: topMatches.map((m) => ({
        id: m.doc.id,
        fileName: m.doc.fileName,
        hospitalName: m.doc.hospitalName,
        doctorName: m.doc.doctorName,
        reportDate: m.doc.reportDate || m.doc.createdAt,
        documentType: m.doc.documentType,
      })),
    };
  }

  /**
   * In-memory document scope resolution against provided candidate documents.
   */
  resolveNaturalLanguageDocumentScope({
    question,
    availableDocuments = [],
    currentDocumentIds = [],
  } = {}) {
    if (!question || typeof question !== "string") {
      return { resolutionType: "NONE", resolvedDocumentIds: [] };
    }

    if (this.isExplicitHistoricalQuery(question)) {
      return {
        resolutionType: "EXPLICIT_HISTORY",
        scopeMode: "AUTHORIZED_HISTORY",
        resolvedDocumentIds: [],
      };
    }

    if (this.isComparisonQuery(question)) {
      const activeDocId = currentDocumentIds[0];
      if (activeDocId && availableDocuments.length > 0) {
        const activeDoc = availableDocuments.find((d) => d.id === activeDocId);
        const activeDate = activeDoc
          ? new Date(activeDoc.reportDate || activeDoc.createdAt)
          : new Date();
        const predecessors = availableDocuments
          .filter((d) => d.id !== activeDocId && new Date(d.reportDate || d.createdAt) < activeDate)
          .sort(
            (a, b) => new Date(b.reportDate || b.createdAt) - new Date(a.reportDate || a.createdAt),
          );

        if (predecessors.length > 0) {
          return {
            resolutionType: "COMPARISON_PREDECESSOR",
            scopeMode: "MULTI_DOCUMENT",
            resolvedDocumentIds: [activeDocId, predecessors[0].id],
            predecessorDoc: predecessors[0],
          };
        }
      }
    }

    const lowerQ = question.toLowerCase();
    const scoredDocs = [];

    for (const doc of availableDocuments) {
      let score = 0;
      if (doc.hospitalName) {
        const hospTokens = doc.hospitalName
          .toLowerCase()
          .split(/\s+/)
          .filter((t) => t.length > 2);
        for (const token of hospTokens) {
          if (lowerQ.includes(token)) {
            score += 3;
            break;
          }
        }
      }
      if (doc.doctorName) {
        const docTokens = doc.doctorName
          .toLowerCase()
          .replace(/^dr\.?\s*/i, "")
          .split(/\s+/)
          .filter((t) => t.length > 2);
        for (const token of docTokens) {
          if (lowerQ.includes(token)) {
            score += 3;
            break;
          }
        }
      }
      if (doc.fileName && lowerQ.includes(doc.fileName.toLowerCase().replace(/\.[^/.]+$/, ""))) {
        score += 4;
      }
      if (score >= 3) {
        scoredDocs.push({ doc, score });
      }
    }

    if (scoredDocs.length === 0) {
      return { resolutionType: "NONE", resolvedDocumentIds: [] };
    }

    scoredDocs.sort((a, b) => b.score - a.score);
    const topScore = scoredDocs[0].score;
    const topMatches = scoredDocs.filter((m) => m.score === topScore);

    if (topMatches.length === 1) {
      return {
        resolutionType: "SINGLE_MATCH",
        scopeMode: "SINGLE_DOCUMENT",
        resolvedDocumentIds: [topMatches[0].doc.id],
        matchedDocument: topMatches[0].doc,
      };
    }

    return {
      resolutionType: "REQUIRE_DOCUMENT_SELECTION",
      scopeMode: "REQUIRE_DOCUMENT_SELECTION",
      candidateDocuments: topMatches.map((m) => m.doc),
      disambiguationMessage: "Multiple documents matched your request. Please select one.",
    };
  }
}

const documentResolverService = new DocumentResolverService();

module.exports = {
  documentResolverService,
  DocumentResolverService,
};
