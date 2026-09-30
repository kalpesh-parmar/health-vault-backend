const { chatFastPath } = require("../../src/services/ai/chat/chatFastPath.service");
const { chatClassifier } = require("../../src/services/ai/chat/chatClassifier.service");
const documentRepository = require("../../src/repositories/documentRepository");
const chatSessionRepository = require("../../src/repositories/chatSessionRepository");
const { sanitizeChatResponse } = require("../../src/services/ai/chat/chatHelpers");

jest.mock("../../src/repositories/documentRepository");
jest.mock("../../src/repositories/chatSessionRepository");

describe("10 Core Document & Report Questions Suite (with Artifact Sanitization)", () => {
  const mockUserId = "usr-doc-suite-1";
  const mockSessionId = "sess-doc-suite-1";

  const sampleDocuments = [
    {
      id: "doc-1",
      userId: mockUserId,
      fileName: "complete_blood_count_sep2026.pdf",
      documentType: "lab_report",
      fileType: "pdf",
      reportDate: new Date("2026-09-15T00:00:00Z"),
      createdAt: new Date("2026-09-15T10:00:00Z"),
      ocrStatus: "COMPLETED",
    },
    {
      id: "doc-2",
      userId: mockUserId,
      fileName: "chest_xray_aug2026.png",
      documentType: "radiology",
      fileType: "image",
      reportDate: new Date("2026-08-20T00:00:00Z"),
      createdAt: new Date("2026-08-20T10:00:00Z"),
      ocrStatus: "COMPLETED",
    },
    {
      id: "doc-3",
      userId: mockUserId,
      fileName: "discharge_summary_jul2026.pdf",
      documentType: "medical_document",
      fileType: "pdf",
      reportDate: new Date("2026-07-10T00:00:00Z"),
      createdAt: new Date("2026-07-10T10:00:00Z"),
      ocrStatus: "COMPLETED",
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    documentRepository.getSummaryByUserId.mockResolvedValue(sampleDocuments);
    chatSessionRepository.appendMessage.mockImplementation(async (msg) => ({
      id: "msg-" + Math.random(),
      ...msg,
    }));
  });

  function makeContext(question, detectedLanguage = "english") {
    return {
      userId: mockUserId,
      sessionId: mockSessionId,
      question,
      detectedLanguage,
      onChunk: null,
      abortSignal: null,
    };
  }

  function getReplyText(res) {
    if (typeof res.reply === "string") return res.reply;
    return res.reply?.text || res.reply?.formattedText || JSON.stringify(res.reply);
  }

  test("Q1: 'Show my medical documents.' -> Returns verified file names without page noise", async () => {
    const q = "Show my medical documents.";
    const ctx = makeContext(q);
    const classification = chatClassifier.classify({
      rawQuestion: q,
      englishQuestion: q,
      detectedLanguage: "english",
    });

    expect(classification.domains.has("DOCUMENTS")).toBe(true);
    expect(classification.fastPathType).toBe("LIST_DOCUMENT");

    const res = await chatFastPath.handleDocumentList(ctx, classification);
    expect(res).toBeDefined();
    expect(res.reply.items).toHaveLength(3);
    expect(res.reply.items[0].fileName).toBe("complete_blood_count_sep2026.pdf");

    const text = getReplyText(res);
    expect(text).toContain("complete_blood_count_sep2026.pdf");
    expect(text).toContain("chest_xray_aug2026.png");
    expect(text).not.toContain("(the current page is");
    expect(text).not.toMatch(/page \d+ of \d+/i);
  });

  test("Q2: 'List documents.' -> Returns documents cleanly", async () => {
    const q = "List documents.";
    const ctx = makeContext(q);
    const classification = chatClassifier.classify({
      rawQuestion: q,
      englishQuestion: q,
      detectedLanguage: "english",
    });

    expect(classification.domains.has("DOCUMENTS")).toBe(true);
    const res = await chatFastPath.handleDocumentList(ctx, classification);
    const text = getReplyText(res);
    expect(text).toContain("complete_blood_count_sep2026.pdf");
    expect(text).not.toContain("(the current page is");
  });

  test("Q3: 'What medical reports do I have?' -> Returns verified uploaded reports", async () => {
    const q = "What medical reports do I have?";
    const ctx = makeContext(q);
    const classification = chatClassifier.classify({
      rawQuestion: q,
      englishQuestion: q,
      detectedLanguage: "english",
    });

    expect(classification.domains.has("DOCUMENTS")).toBe(true);
    const res = await chatFastPath.handleDocumentList(ctx, classification);
    expect(res.reply.items).toHaveLength(3);
  });

  test("Q4: 'What is my latest report?' -> Returns strictly the single most recent report", async () => {
    const q = "What is my latest report?";
    const ctx = makeContext(q);
    const classification = chatClassifier.classify({
      rawQuestion: q,
      englishQuestion: q,
      detectedLanguage: "english",
    });

    expect(classification.domains.has("DOCUMENTS")).toBe(true);
    expect(classification.entities.documentFacet?.type).toBe("latest");

    const res = await chatFastPath.handleDocumentList(ctx, classification);
    expect(res.reply.items).toHaveLength(1);
    expect(res.reply.items[0].fileName).toBe("complete_blood_count_sep2026.pdf");

    const text = getReplyText(res);
    expect(text).toContain("Latest Medical Report:");
    expect(text).toContain("complete_blood_count_sep2026.pdf");
    expect(text).not.toContain("chest_xray_aug2026.png");
    expect(text).not.toContain("(the current page is");
  });

  test("Q5: 'How many documents do I have?' -> Returns accurate document count", async () => {
    const q = "How many documents do I have?";
    const ctx = makeContext(q);
    const classification = chatClassifier.classify({
      rawQuestion: q,
      englishQuestion: q,
      detectedLanguage: "english",
    });

    expect(classification.domains.has("DOCUMENTS")).toBe(true);
    expect(classification.fastPathType).toBe("COUNT");

    const res = await chatFastPath.handleCount(ctx, classification);
    expect(res.reply).toBe("You have 3 uploaded medical document(s).");
    expect(res.reply).not.toContain("(the current page is");
  });

  test("Q6: 'Show my most recent report.' -> Returns single latest report", async () => {
    const q = "Show my most recent report.";
    const ctx = makeContext(q);
    const classification = chatClassifier.classify({
      rawQuestion: q,
      englishQuestion: q,
      detectedLanguage: "english",
    });

    expect(classification.domains.has("DOCUMENTS")).toBe(true);
    expect(classification.entities.documentFacet?.type).toBe("latest");

    const res = await chatFastPath.handleDocumentList(ctx, classification);
    expect(res.reply.items).toHaveLength(1);
    expect(res.reply.items[0].fileName).toBe("complete_blood_count_sep2026.pdf");
  });

  test("Q7: 'Do I have a blood test report?' -> Filters to lab reports", async () => {
    const q = "Do I have a blood test report?";
    const ctx = makeContext(q);
    const classification = chatClassifier.classify({
      rawQuestion: q,
      englishQuestion: q,
      detectedLanguage: "english",
    });

    expect(classification.domains.has("DOCUMENTS")).toBe(true);
    expect(classification.entities.typeFilter).toBe("lab_report");

    const res = await chatFastPath.handleDocumentList(ctx, classification);
    expect(res.reply.items).toHaveLength(1);
    expect(res.reply.items[0].fileName).toBe("complete_blood_count_sep2026.pdf");
  });

  test("Q8: 'Show my laboratory reports.' -> Filters lab reports accurately", async () => {
    const q = "Show my laboratory reports.";
    const ctx = makeContext(q);
    const classification = chatClassifier.classify({
      rawQuestion: q,
      englishQuestion: q,
      detectedLanguage: "english",
    });

    expect(classification.domains.has("DOCUMENTS")).toBe(true);
    expect(classification.entities.typeFilter).toBe("lab_report");

    const res = await chatFastPath.handleDocumentList(ctx, classification);
    expect(res.reply.items).toHaveLength(1);
    expect(res.reply.items[0].fileName).toBe("complete_blood_count_sep2026.pdf");
  });

  test("Q9: 'What are my uploaded reports?' -> Returns uploaded reports list", async () => {
    const q = "What are my uploaded reports?";
    const ctx = makeContext(q);
    const classification = chatClassifier.classify({
      rawQuestion: q,
      englishQuestion: q,
      detectedLanguage: "english",
    });

    expect(classification.domains.has("DOCUMENTS")).toBe(true);
    const res = await chatFastPath.handleDocumentList(ctx, classification);
    expect(res.reply.items).toHaveLength(3);
  });

  test("Q10: 'List medical reports.' -> Returns verified list without page noise", async () => {
    const q = "List medical reports.";
    const ctx = makeContext(q);
    const classification = chatClassifier.classify({
      rawQuestion: q,
      englishQuestion: q,
      detectedLanguage: "english",
    });

    expect(classification.domains.has("DOCUMENTS")).toBe(true);
    const res = await chatFastPath.handleDocumentList(ctx, classification);
    const text = getReplyText(res);
    expect(text).toContain("complete_blood_count_sep2026.pdf");
    expect(text).not.toContain("(the current page is 1 of 1)");
  });

  test("Q11: Artifact Sanitization Unit Test -> sanitizeChatResponse removes all prompt noise", () => {
    const rawAiResponse =
      "You have 3 reports (the current page is 1 of 1). Here are your documents (Page 1 of 1): 1. blood_test.pdf";
    const cleaned = sanitizeChatResponse(rawAiResponse);
    expect(cleaned).not.toContain("(the current page is 1 of 1)");
    expect(cleaned).not.toContain("(Page 1 of 1)");
    expect(cleaned).toContain("You have 3 reports");
    expect(cleaned).toContain("1. blood_test.pdf");
  });

  test("Q12: Multilingual Support -> Gujarati, Hindi, Marathi, Tamil", async () => {
    // Gujarati: મારા મેડિકલ રિપોર્ટ બતાવો
    const gujQ = "મારા મેડિકલ રિપોર્ટ બતાવો";
    const gujCtx = makeContext(gujQ, "gujarati");
    const gujClass = chatClassifier.classify({
      rawQuestion: gujQ,
      englishQuestion: "show my medical reports",
      detectedLanguage: "gujarati",
    });
    expect(gujClass.domains.has("DOCUMENTS")).toBe(true);
    const gujRes = await chatFastPath.handleDocumentList(gujCtx, gujClass);
    const gujText = getReplyText(gujRes);
    expect(gujText).toContain("તમારા મેડિકલ દસ્તાવેજો:");
    expect(gujText).toContain("complete_blood_count_sep2026.pdf");
    expect(gujText).not.toContain("(the current page is");

    // Hindi: मेरी नवीनतम रिपोर्ट क्या है?
    const hinQ = "मेरी नवीनतम रिपोर्ट क्या है?";
    const hinCtx = makeContext(hinQ, "hindi");
    const hinClass = chatClassifier.classify({
      rawQuestion: hinQ,
      englishQuestion: "what is my latest report?",
      detectedLanguage: "hindi",
    });
    expect(hinClass.domains.has("DOCUMENTS")).toBe(true);
    expect(hinClass.entities.documentFacet?.type).toBe("latest");
    const hinRes = await chatFastPath.handleDocumentList(hinCtx, hinClass);
    const hinText = getReplyText(hinRes);
    expect(hinText).toContain("नवीनतम मेडिकल रिपोर्ट:");
    expect(hinText).toContain("complete_blood_count_sep2026.pdf");

    // Marathi: माझे वैद्यकीय दस्तऐवज दाखवा
    const marQ = "माझे वैद्यकीय दस्तऐवज दाखवा";
    const marCtx = makeContext(marQ, "marathi");
    const marClass = chatClassifier.classify({
      rawQuestion: marQ,
      englishQuestion: "show my medical documents",
      detectedLanguage: "marathi",
    });
    expect(marClass.domains.has("DOCUMENTS")).toBe(true);
    const marRes = await chatFastPath.handleDocumentList(marCtx, marClass);
    const marText = getReplyText(marRes);
    expect(marText).toContain("तुमचे वैद्यकीय दस्तऐवज:");
    expect(marText).toContain("complete_blood_count_sep2026.pdf");

    // Tamil: என்னிடம் எத்தனை ஆவணங்கள் உள்ளன?
    const tamQ = "என்னிடம் எத்தனை ஆவணங்கள் உள்ளன?";
    const tamCtx = makeContext(tamQ, "tamil");
    const tamClass = chatClassifier.classify({
      rawQuestion: tamQ,
      englishQuestion: "how many documents do i have?",
      detectedLanguage: "tamil",
    });
    expect(tamClass.domains.has("DOCUMENTS")).toBe(true);
    expect(tamClass.fastPathType).toBe("COUNT");
    const tamRes = await chatFastPath.handleCount(tamCtx, tamClass);
    expect(tamRes.reply).toBe("உங்களிடம் 3 பதிவேற்றப்பட்ட மருத்துவ ஆவணங்கள் உள்ளன.");
  });
});
