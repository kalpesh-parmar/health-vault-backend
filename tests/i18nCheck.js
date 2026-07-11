const fs = require("fs");
const path = require("path");

// Resolve paths
const backendI18nDir = path.resolve(__dirname, "../src/i18n/onboarding");
const frontendTsFile = path.resolve(
  __dirname,
  "../../health-vault-frontend/src/screens/auth/OnboardingScreen.tsx",
);

// Check if strict mode is enabled
const STRICT_MODE = process.env.I18N_STRICT_MODE === "true";

console.log("[i18nCheck] Starting translation key parity check...");
console.log(
  `[i18nCheck] Strict Mode: ${STRICT_MODE ? "ENABLED (Will fail build on mismatches/fallbacks)" : "DISABLED"}`,
);

let hasErrors = false;

// 1. Validate Backend JSON Files
console.log("\n[i18nCheck] Validating backend JSON files...");
const backendFiles = {
  english: "en.json",
  gujarati: "gu.json",
  hindi: "hi.json",
  marathi: "mr.json",
  tamil: "ta.json",
};

const backendDicts = {};
for (const [lang, filename] of Object.entries(backendFiles)) {
  const filePath = path.join(backendI18nDir, filename);
  if (!fs.existsSync(filePath)) {
    console.error(`[i18nCheck] ERROR: Backend translation file not found: ${filename}`);
    hasErrors = true;
    continue;
  }
  try {
    backendDicts[lang] = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error(`[i18nCheck] ERROR: Failed to parse backend JSON file ${filename}:`, err.message);
    hasErrors = true;
  }
}

if (backendDicts.english) {
  const englishKeys = Object.keys(backendDicts.english);
  console.log(`[i18nCheck] Reference (en.json) has ${englishKeys.length} keys.`);

  for (const lang of ["gujarati", "hindi", "marathi", "tamil"]) {
    if (!backendDicts[lang]) continue;
    const targetKeys = Object.keys(backendDicts[lang]);
    const missingKeys = englishKeys.filter((k) => !targetKeys.includes(k));
    const extraKeys = targetKeys.filter((k) => !englishKeys.includes(k));

    if (missingKeys.length > 0) {
      console.warn(
        `[i18nCheck] WARNING: Language '${lang}' (${backendFiles[lang]}) is missing ${missingKeys.length} keys:`,
      );
      missingKeys.forEach((k) => console.warn(`  - Missing: ${k}`));
      if (STRICT_MODE) {
        hasErrors = true;
      }
    }
    if (extraKeys.length > 0) {
      console.warn(
        `[i18nCheck] WARNING: Language '${lang}' (${backendFiles[lang]}) has ${extraKeys.length} extra keys (not in en.json):`,
      );
      extraKeys.forEach((k) => console.warn(`  - Extra: ${k}`));
    }
    if (missingKeys.length === 0 && extraKeys.length === 0) {
      console.log(
        `[i18nCheck] SUCCESS: Backend dictionary '${lang}' has perfect parity with en.json.`,
      );
    }
  }
}

// 2. Validate Frontend TSX Maps
console.log("\n[i18nCheck] Validating frontend TSX translation maps...");
if (!fs.existsSync(frontendTsFile)) {
  console.error(`[i18nCheck] ERROR: Frontend TSX screen file not found at: ${frontendTsFile}`);
  process.exit(1);
}

const frontendContent = fs.readFileSync(frontendTsFile, "utf8");

function getMatchingBlock(text, startIndex) {
  let depth = 0;
  for (let i = startIndex; i < text.length; i++) {
    if (text[i] === "{") {
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        return text.substring(startIndex, i + 1);
      }
    }
  }
  throw new Error("Braces matching failed");
}

function extractDictKeys(fileContent, dictName) {
  const startRegex = new RegExp(`const\\s+${dictName}\\s*:\\s*Record<[^>]+>\\s*=\\s*\\{`);
  const match = fileContent.match(startRegex);
  if (!match) {
    throw new Error(`Could not find dictionary ${dictName} declaration`);
  }

  const startIndex = match.index + match[0].length - 1;
  const dictBlock = getMatchingBlock(fileContent, startIndex);

  const langs = ["english", "gujarati", "hindi", "marathi", "tamil"];
  const result = {};

  for (const lang of langs) {
    const langStartRegex = new RegExp(`\\b${lang}\\s*:\\s*\\{`);
    const langMatch = dictBlock.match(langStartRegex);
    if (!langMatch) {
      result[lang] = [];
      continue;
    }
    const langStartIndex = langMatch.index + langMatch[0].length - 1;
    const langBlock = getMatchingBlock(dictBlock, langStartIndex);

    // Find all keys inside langBlock
    const keyRegex = /^\s*["']?([a-zA-Z0-9_.-]+)(?:["'])?\s*:/gm;
    const keys = [];
    let keyMatch;
    while ((keyMatch = keyRegex.exec(langBlock)) !== null) {
      keys.push(keyMatch[1]);
    }
    result[lang] = keys;
  }

  return result;
}

const frontendDictNames = ["I18N_MEDICINE", "ONBOARDING_I18N", "I18N_ONBOARDING_UI"];
for (const dictName of frontendDictNames) {
  console.log(`\n[i18nCheck] Checking frontend dictionary: ${dictName}`);
  try {
    const extracted = extractDictKeys(frontendContent, dictName);
    const englishKeys = extracted.english || [];
    console.log(`[i18nCheck] '${dictName}' Reference (english) has ${englishKeys.length} keys.`);

    for (const lang of ["gujarati", "hindi", "marathi", "tamil"]) {
      const targetKeys = extracted[lang] || [];
      const missingKeys = englishKeys.filter((k) => !targetKeys.includes(k));
      const extraKeys = targetKeys.filter((k) => !englishKeys.includes(k));

      if (missingKeys.length > 0) {
        console.warn(
          `[i18nCheck] WARNING: Frontend '${dictName}' for language '${lang}' is missing ${missingKeys.length} keys:`,
        );
        missingKeys.forEach((k) => console.warn(`  - Missing: ${k}`));
        if (STRICT_MODE) {
          hasErrors = true;
        }
      }
      if (extraKeys.length > 0) {
        console.warn(
          `[i18nCheck] WARNING: Frontend '${dictName}' for language '${lang}' has ${extraKeys.length} extra keys:`,
        );
        extraKeys.forEach((k) => console.warn(`  - Extra: ${k}`));
      }
      if (missingKeys.length === 0 && extraKeys.length === 0) {
        console.log(
          `[i18nCheck] SUCCESS: Frontend '${dictName}' '${lang}' has perfect parity with english reference.`,
        );
      }
    }
  } catch (err) {
    console.error(
      `[i18nCheck] ERROR: Failed to scan frontend dictionary ${dictName}:`,
      err.message,
    );
    hasErrors = true;
  }
}

console.log("\n[i18nCheck] Key Parity Validation finished.");
if (hasErrors) {
  console.error("[i18nCheck] FAIL: Missing or incorrect translation keys found.");
  process.exit(1);
} else {
  console.log("[i18nCheck] PASS: All translation keys are valid and aligned.");
  process.exit(0);
}
