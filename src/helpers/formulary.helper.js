/**
 * Local Pharmaceutical Formulary & Clinical Drug Validator (REQ-03)
 * Offline dictionary of standard Indian pharmaceuticals with fuzzy matching,
 * dosage normalization, confidence scoring, and review flagging.
 */

const FORMULARY = [
  {
    generic: "Paracetamol",
    brands: ["dolo", "crocin", "calpol", "pacimol", "pyrigesic", "paracin"],
    defaultForm: "Tablet",
    strengths: ["500mg", "650mg", "120mg/5ml", "250mg/5ml"],
  },
  {
    generic: "Metformin Hydrochloride",
    brands: ["glycomet", "obimet", "cetapin", "gluconorm", "walaphage", "metfor"],
    defaultForm: "Tablet",
    strengths: ["500mg", "850mg", "1000mg", "SR 500mg"],
  },
  {
    generic: "Pantoprazole",
    brands: ["pan", "pantocid", "pantodac", "pantop", "nupenta", "pantakem"],
    defaultForm: "Tablet",
    strengths: ["40mg", "20mg"],
  },
  {
    generic: "Amoxicillin and Potassium Clavulanate",
    brands: ["augmentin", "moxclav", "clavall", "clamovid", "amoxyclav", "sensiclav"],
    defaultForm: "Tablet",
    strengths: ["625mg", "375mg", "1000mg"],
  },
  {
    generic: "Amoxicillin",
    brands: ["mox", "novamox", "amoxil"],
    defaultForm: "Capsule",
    strengths: ["250mg", "500mg"],
  },
  {
    generic: "Telmisartan",
    brands: ["telma", "telmikem", "telsartan", "telvas", "creser", "telista"],
    defaultForm: "Tablet",
    strengths: ["20mg", "40mg", "80mg"],
  },
  {
    generic: "Amlodipine",
    brands: ["amlong", "stamlo", "amlovas", "amlocab"],
    defaultForm: "Tablet",
    strengths: ["2.5mg", "5mg", "10mg"],
  },
  {
    generic: "Atorvastatin",
    brands: ["atorva", "lipitor", "atorlip", "tg-tor", "atorfit", "storvas"],
    defaultForm: "Tablet",
    strengths: ["10mg", "20mg", "40mg", "80mg"],
  },
  {
    generic: "Azithromycin",
    brands: ["azithral", "zithrox", "azee", "aziwok", "zady"],
    defaultForm: "Tablet",
    strengths: ["250mg", "500mg"],
  },
  {
    generic: "Ciprofloxacin",
    brands: ["cifran", "ciplox", "cpro"],
    defaultForm: "Tablet",
    strengths: ["250mg", "500mg"],
  },
  {
    generic: "Omeprazole",
    brands: ["omez", "ocid", "omizac"],
    defaultForm: "Capsule",
    strengths: ["20mg", "40mg"],
  },
  {
    generic: "Rabeprazole",
    brands: ["razo", "happi", "rabicip", "rabium"],
    defaultForm: "Tablet",
    strengths: ["20mg"],
  },
  {
    generic: "Cetirizine",
    brands: ["cetzine", "alercet", "okacet", "incid-l"],
    defaultForm: "Tablet",
    strengths: ["10mg", "5mg/5ml"],
  },
  {
    generic: "Montelukast and Levocetirizine",
    brands: [
      "montek lc",
      "montek",
      "telekast l",
      "telekast",
      "montair lc",
      "montair",
      "levolin m",
      "monticope",
    ],
    defaultForm: "Tablet",
    strengths: ["10mg/5mg"],
  },
  {
    generic: "Calcium and Vitamin D3",
    brands: ["shelcal", "caldison", "cipcal", "gemcal", "calcimax"],
    defaultForm: "Tablet",
    strengths: ["500mg", "D3", "HD"],
  },
  {
    generic: "Aspirin (Acetylsalicylic Acid)",
    brands: ["ecosprin", "disprin", "asa"],
    defaultForm: "Tablet",
    strengths: ["75mg", "150mg"],
  },
  {
    generic: "Ibuprofen",
    brands: ["brufen", "combiflam", "ibugesic"],
    defaultForm: "Tablet",
    strengths: ["200mg", "400mg"],
  },
  {
    generic: "Diclofenac",
    brands: ["voveran", "dynapar", "diclogesic"],
    defaultForm: "Tablet",
    strengths: ["50mg"],
  },
  {
    generic: "Glimepiride",
    brands: ["amaryl", "zoryl", "glimy"],
    defaultForm: "Tablet",
    strengths: ["1mg", "2mg", "3mg", "4mg"],
  },
  {
    generic: "Levothyroxine Sodium",
    brands: ["thyronorm", "eltroxin", "thyrox"],
    defaultForm: "Tablet",
    strengths: ["25mcg", "50mcg", "75mcg", "88mcg", "100mcg", "125mcg"],
  },
];

// Pre-build O(1) index maps
const BRAND_INDEX = new Map();
const GENERIC_INDEX = new Map();

for (const entry of FORMULARY) {
  const genKey = entry.generic.toLowerCase().trim();
  GENERIC_INDEX.set(genKey, entry);

  for (const brand of entry.brands) {
    BRAND_INDEX.set(brand.toLowerCase().trim(), entry);
  }
}

/**
 * Standard Levenshtein Distance for fuzzy typo matching
 */
function levenshteinDistance(s1, s2) {
  if (!s1 || !s2) return (s1 || s2 || "").length;
  const a = s1.toLowerCase();
  const b = s2.toLowerCase();
  const matrix = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));

  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1, // deletion
        matrix[i][j - 1] + 1, // insertion
        matrix[i - 1][j - 1] + cost, // substitution
      );
    }
  }
  return matrix[a.length][b.length];
}

/**
 * Extract dosage form (Tablet, Capsule, Syrup, Injection)
 */
function extractForm(nameStr, defaultForm = null) {
  if (!nameStr) return defaultForm;
  const lower = nameStr.toLowerCase();
  if (/\b(?:tab|tabs|tablet|tablets)\b|\btab\./i.test(lower)) return "Tablet";
  if (/\b(?:cap|caps|capsule|capsules)\b|\bcap\./i.test(lower)) return "Capsule";
  if (/\b(?:syp|syrup|susp|suspension)\b|\bsyp\./i.test(lower)) return "Syrup";
  if (/\b(?:inj|injection)\b|\binj\./i.test(lower)) return "Injection";
  if (/\b(?:oint|ointment|gel|cream)\b/i.test(lower)) return "Ointment";
  if (/\b(?:drops?)\b/i.test(lower)) return "Drops";
  return defaultForm;
}

/**
 * Clean medication name to its core pharmaceutical identifier
 */
function extractCoreToken(nameStr) {
  if (!nameStr) return "";
  let cleaned = nameStr
    .replace(/[-_/]/g, " ")
    .replace(
      /\b(?:tab|tabs|tablet|tablets|cap|caps|capsule|capsules|syp|syrup|inj|injection)\b/gi,
      "",
    )
    .replace(/\b\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|iu|%)\b/gi, "")
    .replace(/\b(?:sr|cr|xr|ds|lc|d3|sl|er|forte|plus)\b/gi, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  const words = cleaned.split(" ").filter((w) => w.length > 1);
  return words[0] || cleaned;
}

/**
 * Validate medication against local formulary
 * @param {object} med - Raw medication object
 * @returns {object} Standardized medication with canonicalName and confidence
 */
function validateMedication(med) {
  if (!med || !med.name) {
    return {
      name: null,
      canonicalName: null,
      genericName: null,
      dosage: null,
      frequency: null,
      duration: null,
      quantity: null,
      qty: null,
      type: null,
      instructions: null,
      isFormularyMatch: false,
      confidence: 0.0,
      flaggedForReview: true,
    };
  }

  const rawName = String(med.name).trim();
  const form = med.type || extractForm(rawName);
  const coreToken = extractCoreToken(rawName);

  let matchEntry = null;
  let matchType = null; // "EXACT_GENERIC", "EXACT_BRAND", "FUZZY_BRAND", "FUZZY_GENERIC"
  let minDistance = Infinity;

  // 1. Exact Brand Lookup
  if (BRAND_INDEX.has(coreToken)) {
    matchEntry = BRAND_INDEX.get(coreToken);
    matchType = "EXACT_BRAND";
  }

  // 2. Exact Generic Lookup
  if (!matchEntry && GENERIC_INDEX.has(coreToken)) {
    matchEntry = GENERIC_INDEX.get(coreToken);
    matchType = "EXACT_GENERIC";
  }

  // 3. Fuzzy Brand Lookup (distance <= 2 for tokens >= 4 chars)
  if (!matchEntry && coreToken.length >= 4) {
    for (const [brandKey, entry] of BRAND_INDEX.entries()) {
      const dist = levenshteinDistance(coreToken, brandKey);
      if (dist <= 2 && dist < minDistance) {
        minDistance = dist;
        matchEntry = entry;
        matchType = "FUZZY_BRAND";
      }
    }
  }

  // 4. Calculate Confidence & Canonical Name
  let isFormularyMatch = false;
  let confidence = 0.5;
  let flaggedForReview = false;
  let canonicalName = rawName;
  let genericName = null;

  if (matchEntry) {
    isFormularyMatch = true;
    genericName = matchEntry.generic;

    if (matchType === "EXACT_BRAND" || matchType === "EXACT_GENERIC") {
      confidence = 0.98;
      flaggedForReview = false;
    } else if (matchType === "FUZZY_BRAND") {
      confidence = minDistance === 1 ? 0.92 : 0.85;
      flaggedForReview = false;
    }

    canonicalName = rawName;
  } else {
    // Unrecognized in formulary: determine if it has valid structure
    const hasDosagePattern =
      med.dosage &&
      /^(?:\d-\d-\d|\d-\d|\bOD\b|\bBD\b|\bTDS\b|\bQID\b|\bSOS\b|\bHS\b)/i.test(med.dosage);
    const hasStrength = /\b\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml)\b/i.test(rawName);

    if (hasDosagePattern || hasStrength) {
      confidence = 0.72; // structured but unverified
      flaggedForReview = false;
    } else if (coreToken.length < 3 || /^[^\w\s]+$/.test(coreToken)) {
      confidence = 0.35; // likely garbled text
      flaggedForReview = true;
    } else {
      confidence = 0.6;
      flaggedForReview = true;
    }
  }

  const qty = med.quantity || med.qty || null;
  const duration = med.duration || null;

  return {
    name: rawName,
    canonicalName,
    genericName,
    dosage: med.dosage ? String(med.dosage).trim() : null,
    frequency: med.frequency || null,
    duration: duration ? String(duration).trim() : null,
    quantity: qty ? String(qty).trim() : null,
    qty: qty ? String(qty).trim() : null,
    type: form || (matchEntry ? matchEntry.defaultForm : null),
    instructions: med.instructions || null,
    isFormularyMatch,
    confidence: Number(confidence.toFixed(2)),
    flaggedForReview,
  };
}

module.exports = {
  validateMedication,
  levenshteinDistance,
  extractForm,
  extractCoreToken,
  FORMULARY,
};
