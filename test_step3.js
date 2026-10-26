const { chatService } = require("./src/services/ai/chat/chat.service");
const chatSessionRepository = require("./src/repositories/chatSessionRepository");

const DOC_ID = "94baaf03-ebb3-46fb-ab8b-525bff39f862";
const USER_ID = "10945cc9-28bc-4e2c-b54f-14497b40fb1d";

async function runStep3Tests() {
  const testCases = [
    {
      name: "Q1: Mara report ni summary aapo",
      question: "Mara report ni summary aapo",
      preferredLanguage: "gujarati",
    },
    {
      name: "Q2: મારા રિપોર્ટમાં શું લખેલું છે?",
      question: "મારા રિપોર્ટમાં શું લખેલું છે?",
      preferredLanguage: "gujarati",
    },
    {
      name: "Q3: What is my hemoglobin value?",
      question: "What is my hemoglobin value?",
      preferredLanguage: "gujarati",
    },
    {
      name: "Q4: Mara report ni summary English ma apo",
      question: "Mara report ni summary English ma apo",
      preferredLanguage: "gujarati",
    },
  ];

  for (const tc of testCases) {
    console.log(`\n========================================`);
    console.log(`RUNNING: ${tc.name}`);
    console.log(`========================================`);
    const session = await chatSessionRepository.createSession({
      userId: USER_ID,
      title: `Step 3 Test - ${tc.name}`,
      metadata: { slots: {} },
    });

    const res = await chatService.sendMessage({
      userId: USER_ID,
      sessionId: session.id,
      documentId: [DOC_ID],
      question: tc.question,
      preferredLanguage: tc.preferredLanguage,
    });

    console.log(`REPLY:\n${res.reply}\n`);
    console.log(
      `CITATIONS (${res.citations?.length || 0}):`,
      res.citations?.map((c) => `${c.fileName} p.${c.pageNumber}`),
    );
    console.log(`MODE: ${res.mode}`);
  }
  process.exit(0);
}

runStep3Tests().catch((err) => {
  console.error("Step 3 Test failed:", err);
  process.exit(1);
});
