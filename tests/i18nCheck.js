const fs = require("fs");
const path = require("path");

const i18nDir = path.resolve(__dirname, "../src/i18n/onboarding");
const languages = ["gu", "hi", "mr", "ta"];

const enPath = path.join(i18nDir, "en.json");
if (!fs.existsSync(enPath)) {
  console.error("[i18nCheck] en.json not found at:", enPath);
  process.exit(1);
}

const enData = JSON.parse(fs.readFileSync(enPath, "utf8"));
const enKeys = Object.keys(enData);
let hasError = false;

console.log(`[i18nCheck] Base en.json has ${enKeys.length} keys.`);

for (const lang of languages) {
  const langPath = path.join(i18nDir, `${lang}.json`);
  if (!fs.existsSync(langPath)) {
    console.error(`[i18nCheck] Missing file: ${lang}.json`);
    hasError = true;
    continue;
  }

  try {
    const langData = JSON.parse(fs.readFileSync(langPath, "utf8"));
    const langKeys = new Set(Object.keys(langData));

    const missing = enKeys.filter((k) => !langKeys.has(k));
    const extra = [...langKeys].filter((k) => !Object.hasOwn(enData, k));

    if (missing.length > 0) {
      console.error(`[i18nCheck] ${lang}.json is missing ${missing.length} keys:`, missing);
      hasError = true;
    }
    if (extra.length > 0) {
      console.error(`[i18nCheck] ${lang}.json has ${extra.length} unexpected keys:`, extra);
      hasError = true;
    }

    if (missing.length === 0 && extra.length === 0) {
      console.log(`[i18nCheck] ${lang}.json is 100% synchronized with en.json.`);
    }
  } catch (err) {
    console.error(`[i18nCheck] Error parsing ${lang}.json:`, err.message);
    hasError = true;
  }
}

if (hasError) {
  console.error("[i18nCheck] Localization validation failed.");
  process.exit(1);
} else {
  console.log("[i18nCheck] All localization files validated successfully.");
  process.exit(0);
}
