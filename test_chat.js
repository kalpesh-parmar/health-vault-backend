const ocrService = require("./src/services/ocr.service");

async function run() {
  const userId = "c408ae2e-c9b2-44cc-ad65-cf68e497cb42";

  // 1. Without documentId
  try {
    console.log("Testing Normal Chat without documentId...");
    const res1 = await ocrService.onboardingChat(userId, {
      message: "Hello, how are you?",
      // sessionId and question omitted intentionally
    });
    console.log("Result 1 Mode:", res1.mode, "Action:", res1.actionType);
  } catch (err) {
    console.error("Test 1 Failed:", err.message);
  }

  // 2. With documentId
  try {
    console.log("Testing Normal Chat with documentId...");
    const res2 = await ocrService.onboardingChat(userId, {
      message: "What does my report say about sugar?",
      documentId: ["some-fake-uuid"],
    });
    console.log("Result 2 Mode:", res2.mode, "Action:", res2.actionType);
  } catch (err) {
    console.error("Test 2 Failed:", err.message);
  }

  process.exit(0);
}

run().catch(console.error);
