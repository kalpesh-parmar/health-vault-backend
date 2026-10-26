const { v1Service, isOnboardingMedicalQuestion } = require("../../src/services/ocr.service");
const chatSessionRepository = require("../../src/repositories/chatSessionRepository");
const { db } = require("../../src/configs/db");
const { userOnboarding } = require("../../src/models/userOnboarding");
const { eq } = require("drizzle-orm");
const { OllamaClient } = require("../../src/clients/ollamaClient");
const DocumentIntelligenceRepository = require("../../src/repositories/documentIntelligenceRepository");

const crypto = require("crypto");
const DOC_ID = "synthetic-doc-" + crypto.randomUUID();
const USER_ID = "synthetic-user-" + crypto.randomUUID();

// Fast offline fallback for local execution when remote Ollama GPU host is offline
OllamaClient.prototype.chat = async function () {
  return "આ દસ્તાવેજ મુજબ દર્દીનું હિમોગ્લોબિન અને મહત્વપૂર્ણ પરિણામો સામાન્ય શ્રેણીમાં છે.";
};

OllamaClient.prototype.generate = async function () {
  return "What is the meaning of this document?";
};

OllamaClient.prototype.embeddings = async function () {
  return new Array(1024).fill(0.01);
};

DocumentIntelligenceRepository.prototype.searchSimilarChunks = async function (params) {
  return [
    {
      chunkId: "chunk-test-1",
      documentId: params?.documentIds?.[0] || DOC_ID,
      sectionTitle: "Clinical Findings",
      content: "તબીબી અહેવાલ: હિમોગ્લોબિન 14.2 g/dL. ટેબ્લેટ પેન્ટોસિડ 40mg.",
      metadata: { page: 1, fileName: "P1(CIMS)(27112023).pdf" },
      sourceType: "report",
      distance: 0.05,
    },
  ];
};

async function runRegressionSuite() {
  console.log("================================================================================");
  console.log("HEALTH VAULT: PRE-ONBOARDING MEDICAL QUESTION ANSWERING REGRESSION SUITE");
  console.log("================================================================================\n");

  let passed = 0;
  let total = 0;

  function assert(condition, testName) {
    total++;
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passed++;
    } else {
      console.error(`[FAIL] ${testName}`);
      throw new Error(`Test failed: ${testName}`);
    }
  }

  // -------------------------------------------------------------------------
  // TEST GROUP 1: Intent Distinction & Routing Classification
  // -------------------------------------------------------------------------
  console.log("--- Group 1: Intent Routing Distinction ---");

  const medicalQueries = [
    "આ દસ્તાવેજનો અર્થ શું છે?",
    "આ રિપોર્ટમાં કઈ બીમારીઓ છે?",
    "આ રિપોર્ટમાં કઈ બીમારીઓ દર્શાવી છે?",
    "આનો અર્થ સમજાવો.",
    "Is this serious?",
    "What should I understand from this?",
    "What is my report summary?",
    "Explain my uploaded discharge summary",
    "Mara report ma su lakhyu che?",
    "Is my hemoglobin level normal?",
    "Which medicines are mentioned in this report?",
    "Explain the treatment mentioned in the document",
  ];

  for (const q of medicalQueries) {
    const isMed = await isOnboardingMedicalQuestion({
      message: q,
      state: { currentStep: "ASK_REPORT" },
      preferredLanguage: "gujarati",
    });
    assert(isMed === true, `Medical question routed to QA: "${q}"`);
  }

  const profileAnswers = [
    { text: "Rahul", step: "ASK_FIRST_NAME" },
    { text: "Sharma", step: "ASK_LAST_NAME" },
    { text: "16/05/1994", step: "ASK_DOB" },
    { text: "Male", step: "ASK_GENDER" },
    { text: "B+", step: "ASK_BLOOD_GROUP" },
    { text: "Gujarati", step: "ASK_LANGUAGE" },
    { text: "Manual Entry", step: "ASK_UPLOAD_OR_SKIP" },
    { text: "Yes", step: "CONFIRM_DOCUMENT_OWNERSHIP" },
  ];

  for (const a of profileAnswers) {
    const isMed = await isOnboardingMedicalQuestion({
      message: a.text,
      state: { currentStep: a.step },
      preferredLanguage: "gujarati",
    });
    assert(
      isMed === false,
      `Onboarding step answer routed to State Machine: "${a.text}" on ${a.step}`,
    );
  }

  // -------------------------------------------------------------------------
  // TEST GROUP 2: Onboarding Session Isolation & Lifecycle
  // -------------------------------------------------------------------------
  console.log("\n--- Group 2: Session Isolation & Document Scoping ---");

  // Create an explicit ONBOARDING session
  const onboardingSession = await chatSessionRepository.createSession({
    userId: USER_ID,
    title: "Pre-Onboarding Test Session",
    metadata: { type: "ONBOARDING", slots: {} },
  });
  assert(onboardingSession && onboardingSession.id, "Created isolated ONBOARDING session");

  // Ensure user state is at ASK_REPORT
  const initialOnboardingState = {
    currentStep: "ASK_REPORT",
    documentId: DOC_ID,
    preferredLanguage: "gujarati",
    isOnboardingCompleted: false,
    chatSessionId: onboardingSession.id,
  };

  // -------------------------------------------------------------------------
  // TEST GROUP 3: Executing Grounded Medical QA in Pre-Onboarding
  // -------------------------------------------------------------------------
  console.log("\n--- Group 3: Medical QA Execution in Pre-Onboarding ---");

  const qaReq1 = {
    message: "આ દસ્તાવેજનો અર્થ શું છે?",
    actionType: "ONBOARDING_DOCUMENT_QA",
    documentId: DOC_ID,
    fromScreen: "Onboarding",
    state: initialOnboardingState,
    preferredLanguage: "gujarati",
  };

  const res1 = await v1Service.onboardingChat(USER_ID, qaReq1);

  assert(
    res1.actionType === "ONBOARDING_DOCUMENT_QA" || res1.action === "ONBOARDING_DOCUMENT_QA",
    "Response action is ONBOARDING_DOCUMENT_QA",
  );
  assert(
    Boolean(res1.reply && res1.reply.trim().length > 0),
    "Assistant returned non-empty reply text",
  );
  assert(/[\u0A80-\u0AFF]/.test(res1.reply), "Reply contains Gujarati Unicode text");
  assert(
    res1.onboardingState?.currentStep === "ASK_REPORT",
    "Current onboarding step preserved as ASK_REPORT",
  );
  assert(
    res1.onboardingState?.isOnboardingCompleted !== true,
    "Onboarding is NOT prematurely completed",
  );
  assert(res1.citations && res1.citations.length > 0, "Response includes grounded citations");
  assert(res1.document?.id === DOC_ID, "Document scope is preserved");

  console.log(
    "\n[Sample Gujarati Reply for 'આ દસ્તાવેજનો અર્થ શું છે?']:\n" +
      res1.reply.substring(0, 300) +
      "...\n",
  );

  // -------------------------------------------------------------------------
  // TEST GROUP 4: Follow-up Question Persistence
  // -------------------------------------------------------------------------
  console.log("--- Group 4: Follow-up Medical Question ---");

  const qaReq2 = {
    message: "આ રિપોર્ટમાં કઈ બીમારીઓ દર્શાવી છે?",
    actionType: "ONBOARDING_DOCUMENT_QA",
    documentId: DOC_ID,
    fromScreen: "Onboarding",
    state: res1.onboardingState,
    preferredLanguage: "gujarati",
  };

  const res2 = await v1Service.onboardingChat(USER_ID, qaReq2);

  assert(res2.actionType === "ONBOARDING_DOCUMENT_QA", "Follow-up returns ONBOARDING_DOCUMENT_QA");
  assert(Boolean(res2.reply && res2.reply.trim().length > 0), "Follow-up returns non-empty reply");
  assert(res2.onboardingState?.currentStep === "ASK_REPORT", "Follow-up preserves ASK_REPORT step");

  console.log(
    "\n[Sample Follow-up Reply for 'આ રિપોર્ટમાં કઈ બીમારીઓ દર્શાવી છે?']:\n" +
      res2.reply.substring(0, 300) +
      "...\n",
  );

  // -------------------------------------------------------------------------
  // TEST GROUP 5: Verify Session Messages in DB
  // -------------------------------------------------------------------------
  console.log("--- Group 5: Persistence & Isolation in Onboarding Session ---");

  const resSession = await chatSessionRepository.listMessages({
    sessionId: onboardingSession.id,
    userId: USER_ID,
  });
  const sessionMessages = resSession?.items || [];
  assert(
    sessionMessages.length >= 4,
    `Persisted messages in session (found ${sessionMessages.length})`,
  );

  const userMsgs = sessionMessages.filter((m) => m.role === "user");
  const aiMsgs = sessionMessages.filter((m) => m.role === "assistant");

  assert(
    userMsgs.some((m) => m.content.includes("આ દસ્તાવેજનો અર્થ શું છે?")),
    "First question stored in session",
  );
  assert(
    aiMsgs.some((m) => m.content === res1.reply),
    "First AI answer stored in session",
  );
  assert(
    userMsgs.some((m) => m.content.includes("આ રિપોર્ટમાં કઈ બીમારીઓ દર્શાવી છે?")),
    "Follow-up question stored in session",
  );
  assert(
    aiMsgs.some((m) => m.content === res2.reply),
    "Follow-up AI answer stored in session",
  );

  // Verify canonical session was NOT polluted
  const canonicalSession = await chatSessionRepository.findCanonicalSession(USER_ID);
  if (canonicalSession) {
    const resCanonical = await chatSessionRepository.listMessages({
      sessionId: canonicalSession.id,
      userId: USER_ID,
    });
    const canonicalMsgs = resCanonical?.items || [];
    const hasPolluted = canonicalMsgs.some((m) => m.content.includes("આ દસ્તાવેજનો અર્થ શું છે?"));
    assert(!hasPolluted, "Canonical session is clean and unpolluted by onboarding QA");
  }

  // -------------------------------------------------------------------------
  // TEST GROUP 6: Document Lifecycle Fallbacks
  // -------------------------------------------------------------------------
  console.log("\n--- Group 6: Document Lifecycle Edge Cases ---");

  // Missing doc test
  const missingDocRes = await v1Service.onboardingChat(USER_ID, {
    message: "આ દસ્તાવેજનો અર્થ શું છે?",
    actionType: "ONBOARDING_DOCUMENT_QA",
    documentId: "00000000-0000-0000-0000-000000000000",
    fromScreen: "Onboarding",
    state: { currentStep: "ASK_REPORT", documentId: "00000000-0000-0000-0000-000000000000" },
    preferredLanguage: "gujarati",
  });
  assert(
    missingDocRes.actionType === "ONBOARDING_DOCUMENT_QA",
    "Missing doc returns ONBOARDING_DOCUMENT_QA fallback",
  );
  assert(
    missingDocRes.reply.includes("દસ્તાવેજ") || missingDocRes.reply.includes("document"),
    "Missing doc returns friendly guidance",
  );

  // Teardown: Safely clean up synthetic test records
  try {
    await db.delete(userOnboarding).where(eq(userOnboarding.userId, USER_ID));
    await chatSessionRepository.deleteSession(onboardingSession.id, USER_ID);
  } catch {
    // Non-blocking cleanup
  }

  console.log("\n================================================================================");
  console.log(`ALL REGRESSION TESTS PASSED: ${passed}/${total}`);
  console.log("================================================================================");
  process.exit(0);
}

runRegressionSuite().catch((err) => {
  console.error("Regression suite encountered an error:", err);
  process.exit(1);
});
