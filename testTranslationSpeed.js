const aiClient = require("./src/services/ai/clients/aiClient.service");
const chatSessionRepository = require("./src/repositories/chatSessionRepository");
const { db } = require("./src/configs/db");
const { chatMessage } = require("./src/models/chatSession");
const { desc } = require("drizzle-orm");

async function runTest() {
  console.log("=========================================");
  console.log("   HISTORY TRANSLATION LATENCY TEST      ");
  console.log("=========================================\n");

  // Fetch a session that actually has messages
  const [latestMsg] = await db
    .select()
    .from(chatMessage)
    .orderBy(desc(chatMessage.createdAt))
    .limit(1);

  if (!latestMsg) {
    console.log("No chat messages found in DB to test with.");
    process.exit(0);
  }

  console.log(`Found session: ${latestMsg.sessionId} for user: ${latestMsg.userId}`);

  const recent = await chatSessionRepository.listMessages({
    sessionId: latestMsg.sessionId,
    userId: latestMsg.userId,
    limit: 4,
    direction: "before",
  });

  const items = recent && Array.isArray(recent.items) ? recent.items : [];
  const history = items.map((msg) => ({ content: msg.content, role: msg.role }));

  if (history.length === 0) {
    console.log("No messages found in this session.");
    process.exit(0);
  }

  console.log(`Testing with ${history.length} actual messages from DB...`);

  const startTime = Date.now();

  const chunkPromises = history.map(async (msg) => {
    // 1. Detect language
    const lang = await aiClient.detectLanguage(msg.content);
    // 2. Translate to english if not already english
    const translated =
      lang !== "english" ? await aiClient.translate(msg.content, lang, "english") : msg.content;
    return { role: msg.role, content: translated };
  });

  const translatedHistory = await Promise.all(chunkPromises);
  const timeTaken = Date.now() - startTime;

  console.log("\n--- Original History ---");
  console.dir(history, { depth: null });

  console.log("\n--- Translated History ---");
  console.dir(translatedHistory, { depth: null });

  console.log(`\n✅ First Run Time (Empty Cache): ${timeTaken}ms\n`);

  console.log("=========================================");
  if (timeTaken < 1000) {
    console.log("🚀 Result: Flow time added is LESS than 1s! It is safe to add.");
  } else {
    console.log(`⚠️ Result: Flow time added is MORE than 1s (${timeTaken}ms).`);
    console.log(
      "You may want to optimize translation or skip translating history if speed is critical.",
    );
  }
  console.log("=========================================");

  process.exit(0);
}

runTest();
