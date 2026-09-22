const DocumentIntelligenceRepository = require("../../../repositories/documentIntelligenceRepository");
const intelligenceRepository = new DocumentIntelligenceRepository();
const { normalizeLanguage } = require("../../../utils/commonUtils");
const { containsEntity } = require("../../../utils/synonyms");
const { hasAny, toIsoDateOnly } = require("./chatHelpers");

const patientRepository = require("../../../repositories/patientRepository");
const medicationRepository = require("../../../repositories/medicationRepository");
const refillRepository = require("../../../repositories/refillRepository");
const occurrenceRepository = require("../../../repositories/medicationReminderOccurrenceRepository");
const documentRepository = require("../../../repositories/documentRepository");
const notificationRepository = require("../../../repositories/notificationRepository");

const { debugLogger } = require("../../../utils/debugLogger");
const keywordDictionary = require("../../../constants/keywordDictionary");

const REPORT_AGE_LABELS = {
  english: {
    today: "Today",
    day: (n) => (n === 1 ? "1 day old" : `${n} days old`),
    month: (n) => (n === 1 ? "1 month old" : `${n} months old`),
    year: (n) => (n === 1 ? "1 year old" : `${n} years old`),
  },
  gujarati: {
    today: "આજનો",
    day: (n) => `${n} દિવસ જૂનો`,
    month: (n) => `${n} મહિના જૂનો`,
    year: (n) => `${n} વર્ષ જૂનો`,
  },
  hindi: {
    today: "आज का",
    day: (n) => `${n} दिन पुराना`,
    month: (n) => `${n} महीने पुराना`,
    year: (n) => `${n} साल पुराना`,
  },
  marathi: {
    today: "आजचा",
    day: (n) => `${n} दिवस जुना`,
    month: (n) => `${n} महिने जुना`,
    year: (n) => `${n} वर्षे जुना`,
  },
  tamil: {
    today: "இன்றைய",
    day: (n) => `${n} நாள் பழமையானது`,
    month: (n) => `${n} மாதங்கள் பழமையானது`,
    year: (n) => `${n} ஆண்டுகள் பழமையானது`,
  },
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
    return REPORT_AGE_LABELS[normLang]?.today || REPORT_AGE_LABELS.english.today;
  }

  const labels = REPORT_AGE_LABELS[normLang];
  if (!labels) return "";

  if (diffDays < 30) {
    return labels.day(diffDays);
  }

  if (diffDays < 365) {
    return labels.month(Math.floor(diffDays / 30));
  }

  return labels.year(Math.floor(diffDays / 365));
}

/**
 * Detects required context domains based on multi-lingual keywords in user question.
 * @param {string} question - User question text
 * @returns {Set<string>} Set of domain names ('PROFILE', 'MEDICATIONS', 'REFILLS', 'REMINDERS', 'DOCUMENTS', 'NOTIFICATIONS')
 */
function detectContextGraph(question = "") {
  const q = String(question || "").toLowerCase();
  const domains = new Set();

  const reminderKeywords = keywordDictionary.REMINDER;
  const refillKeywords = keywordDictionary.REFILL;
  const docKeywords = keywordDictionary.DOCUMENT;
  const notifKeywords = keywordDictionary.NOTIFICATION;
  const profileKeywords = keywordDictionary.PROFILE;
  const medKeywords = keywordDictionary.MEDICATION;
  const overviewKeywords = keywordDictionary.OVERVIEW;

  if (hasAny(q, reminderKeywords)) domains.add("REMINDERS");
  if (hasAny(q, refillKeywords)) domains.add("REFILLS");
  if (hasAny(q, docKeywords)) domains.add("DOCUMENTS");
  if (hasAny(q, notifKeywords)) domains.add("NOTIFICATIONS");
  if (hasAny(q, profileKeywords)) domains.add("PROFILE");
  if (hasAny(q, medKeywords)) domains.add("MEDICATIONS");

  if (domains.size === 0 || hasAny(q, overviewKeywords)) {
    domains.add("PROFILE");
    domains.add("MEDICATIONS");
    domains.add("REMINDERS");
    domains.add("REFILLS");
    domains.add("DOCUMENTS");
  } else {
    domains.add("PROFILE");
  }

  if (domains.has("REFILLS")) {
    domains.add("MEDICATIONS");
  }

  debugLogger.info("detectContextGraph: Selected domains for user question", {
    question: q.substring(0, 100),
    domains: Array.from(domains),
  });

  return domains;
}

/**
 * Wraps any item array with standardized pagination metadata.
 * Always returns an object containing `{ data: Array, page: { pageNumber, pageLimit, totalPages, totalRecords, hasNextPage, hasPrevPage } }`.
 *
 * @param {Array} items - Raw list of items
 * @param {object} [options] - Options object containing page / limit settings
 * @returns {{ data: Array, page: { pageNumber: number, pageLimit: number, totalPages: number, totalRecords: number, hasNextPage: boolean, hasPrevPage: boolean } }}
 */
function paginateArray(items = [], options = {}) {
  const safeItems = Array.isArray(items) ? items : [];
  const pageLimit = Math.max(1, Number(options.limit || options.pageLimit || 20));
  const reqPage = Math.max(1, Number(options.page || options.pageNumber || 1));
  const totalRecords = safeItems.length;
  const totalPages = Math.max(1, Math.ceil(totalRecords / pageLimit));
  const safePageNumber = Math.min(reqPage, totalPages);

  const startIndex = (safePageNumber - 1) * pageLimit;
  const slicedData = safeItems.slice(startIndex, startIndex + pageLimit);

  return {
    data: slicedData,
    page: {
      pageNumber: safePageNumber,
      pageLimit,
      totalPages,
      totalRecords,
      hasNextPage: safePageNumber < totalPages,
      hasPrevPage: safePageNumber > 1,
    },
  };
}

/**
 * Dependency-aware context builder for patient profile, medications, refills, reminders, documents, and notifications.
 * Executes independent queries in parallel via Promise.all and dependent queries sequentially.
 * Always formats list domains as paginated arrays with pagination metadata.
 *
 * @param {string} userId - User/patient UUID
 * @param {string} userQuestion - Raw question from user
 * @param {object} [options] - Optional pagination parameters
 * @returns {Promise<string>} Formatted markdown context string
 */
async function buildDependencyAwareContext(userId, userQuestion = "", options = {}) {
  if (!userId) return "";

  const domains = detectContextGraph(userQuestion);
  debugLogger.info("buildDependencyAwareContext: Detected domains", {
    userId,
    domains: Array.from(domains),
    question: userQuestion?.substring(0, 100),
  });

  // --- PHASE 1: Independent Domain Queries (Executed in parallel via Promise.all) ---
  const fetchTasks = {};

  fetchTasks.patient = options.patient
    ? Promise.resolve(options.patient)
    : patientRepository.findById(userId);

  if (domains.has("MEDICATIONS")) {
    fetchTasks.medications = medicationRepository.findAll(userId);
  }

  if (domains.has("REMINDERS")) {
    fetchTasks.todayOccurrences = occurrenceRepository.findTodayOccurrences
      ? occurrenceRepository.findTodayOccurrences(userId)
      : Promise.resolve([]);
  }

  if (domains.has("DOCUMENTS")) {
    fetchTasks.documents = documentRepository.getSummaryByUserId
      ? documentRepository.getSummaryByUserId(userId)
      : Promise.resolve([]);
  }

  if (domains.has("NOTIFICATIONS")) {
    fetchTasks.notifications = notificationRepository.list
      ? notificationRepository.list({ userId, sort: { orderBy: "desc" } })
      : Promise.resolve([]);
  }

  const phase1Results = {};
  const taskEntries = Object.entries(fetchTasks);
  const resolvedValues = await Promise.all(
    taskEntries.map(([, task]) =>
      task.catch((err) => {
        debugLogger.error("buildDependencyAwareContext: Task failed", { error: err.message });
        return null;
      }),
    ),
  );

  taskEntries.forEach(([key], index) => {
    phase1Results[key] = resolvedValues[index];
  });

  const patient = phase1Results.patient;
  const medications = phase1Results.medications || [];
  const todayOccurrences = phase1Results.todayOccurrences || [];
  const documents = phase1Results.documents || [];
  const notifications = phase1Results.notifications || [];

  // --- PHASE 2: Dependent Domain Queries (Executed sequentially using Phase 1 outputs) ---
  const refillMap = new Map();
  if (domains.has("REFILLS") && medications.length > 0) {
    const refillPromises = medications.map(async (med) => {
      try {
        const latestRefill = refillRepository.findLatestRefillByMedicationId
          ? await refillRepository.findLatestRefillByMedicationId(med.id)
          : null;
        if (latestRefill) {
          refillMap.set(med.id, latestRefill);
        }
      } catch (err) {
        debugLogger.error("buildDependencyAwareContext: Refill fetch failed for med", {
          medId: med.id,
          error: err.message,
        });
      }
    });
    await Promise.all(refillPromises);
  }

  function formatLocalTime(value) {
    if (!value) return null;
    return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  const isTaken = (o) => o.status === "TAKEN" || o.status === "COMPLETED";
  const isMissed = (o) => o.status === "SKIPPED" || o.status === "MISSED" || o.isOverdue;
  const isPending = (o) => o.status === "PENDING" && !o.isOverdue;

  function formatMedicationPagination(page) {
    if (page.totalRecords === 0) {
      return `Pagination Metadata: [Page ${page.pageNumber} of ${page.totalPages} | Total Records: 0 | Page Limit: ${page.pageLimit}]`;
    }
    return `Pagination Metadata: [Page ${page.pageNumber} of ${page.totalPages} | Total Records: ${page.totalRecords} | Page Limit: ${page.pageLimit} | Has Next Page: ${page.hasNextPage ? "Yes" : "No"}]`;
  }

  function formatReminderPagination(page, { takenCount, missedCount, pendingCount }) {
    if (page.totalRecords === 0) {
      return `Pagination Metadata: [Page ${page.pageNumber} of ${page.totalPages} | Total Scheduled Today: 0 | Page Limit: ${page.pageLimit}]`;
    }
    return `Pagination Metadata: [Page ${page.pageNumber} of ${page.totalPages} | Total Scheduled Today: ${page.totalRecords} (Completed/Taken: ${takenCount}, Missed/Overdue: ${missedCount}, Pending/Future Doses Remaining: ${pendingCount}) | Page Limit: ${page.pageLimit} | Has Next Page: ${page.hasNextPage ? "Yes" : "No"}]`;
  }

  function formatDocumentPagination(page) {
    if (page.totalRecords === 0) {
      return `Pagination Metadata: [Page ${page.pageNumber} of ${page.totalPages} | Total Uploaded Documents: 0 | Page Limit: ${page.pageLimit}]`;
    }
    return `Pagination Metadata: [Page ${page.pageNumber} of ${page.totalPages} | Total Uploaded Documents: ${page.totalRecords} | Page Limit: ${page.pageLimit} | Has Next Page: ${page.hasNextPage ? "Yes" : "No"}]`;
  }

  function formatNotificationPagination(page, { readCount, unreadCount }) {
    if (page.totalRecords === 0) {
      return `Pagination Metadata: [Page ${page.pageNumber} of ${page.totalPages} | Total Notifications: 0 | Page Limit: ${page.pageLimit}]`;
    }
    return `Pagination Metadata: [Page ${page.pageNumber} of ${page.totalPages} | Total Notifications: ${page.totalRecords} (Read: ${readCount}, Unread: ${unreadCount}) | Page Limit: ${page.pageLimit} | Has Next Page: ${page.hasNextPage ? "Yes" : "No"}]`;
  }

  function buildProfileBlock(patient) {
    const dobStr = patient.dateOfBirth ? toIsoDateOnly(patient.dateOfBirth) : "Unknown";
    const allergiesStr =
      patient.allergies && Array.isArray(patient.allergies) && patient.allergies.length > 0
        ? patient.allergies.join(", ")
        : "None";

    const officialFullName =
      `${patient.firstName || ""} ${patient.lastName || ""}`.trim() ||
      patient.fullName ||
      patient.userName ||
      "Unknown";

    const countryCodeStr = patient.countryCode || "";
    const mobileStr = patient.mobile || "";
    const fullPhoneStr =
      countryCodeStr || mobileStr ? `${countryCodeStr}${mobileStr}`.trim() : "None";
    const emailStr = patient.email || "None";
    const firebaseUidStr = patient.firebaseUid || "None";

    let loginTypeDesc = "";
    if (patient.firebaseUid || (mobileStr && countryCodeStr)) {
      if (patient.email) {
        loginTypeDesc = `Mobile OTP via Firebase Auth (${fullPhoneStr}) [Primary] and Email (${emailStr})`;
      } else {
        loginTypeDesc = `Mobile OTP via Firebase Authentication (Phone: ${fullPhoneStr}, Firebase UID: ${firebaseUidStr})`;
      }
    } else if (patient.email) {
      loginTypeDesc = `Email & Password Authentication (Email: ${emailStr})`;
    } else {
      loginTypeDesc = `Standard Profile Account`;
    }

    const regDateStr = patient.createdAt ? toIsoDateOnly(patient.createdAt) : "Unknown";

    const lastLoginStr = patient.lastLoginAt
      ? patient.lastLoginAt instanceof Date
        ? patient.lastLoginAt.toISOString()
        : String(patient.lastLoginAt)
      : "Unknown";

    return (
      `=== OFFICIAL LOGGED-IN USER PROFILE & AUTHENTICATION (DATABASE) ===\n` +
      `Patient Code: ${patient.patientCode || "N/A"}\n` +
      `Registered Account Profile Name: "${officialFullName}"\n` +
      `Username: ${patient.userName || officialFullName}\n` +
      `First Name: ${patient.firstName || "N/A"}\n` +
      `Last Name: ${patient.lastName || "N/A"}\n` +
      `Email Address: ${emailStr}\n` +
      `Mobile Phone: ${fullPhoneStr}\n` +
      `Firebase Unique ID: ${firebaseUidStr}\n` +
      `Login Method / Authentication Type: ${loginTypeDesc}\n` +
      `Gender: ${patient.gender || "Unknown"}\n` +
      `Date of Birth: ${dobStr}\n` +
      `Blood Group: ${patient.bloodGroup || "Unknown"}\n` +
      `Allergies: ${allergiesStr}\n` +
      `Account Status: ${patient.status || "ACTIVE"}\n` +
      `Mobile Verified: ${(patient.isMobileVerified ?? patient.isVerified) ? "Yes" : "No"}\n` +
      `Email Verified: ${patient.isEmailVerified ? "Yes" : "No"}\n` +
      `Onboarding Completed: ${patient.onboardingCompleted ? "Yes" : "No"}\n` +
      `Preferred Language: ${patient.preferredLanguage || "english"}\n` +
      `Account Registration Date: ${regDateStr}\n` +
      `Last Login Timestamp: ${lastLoginStr}\n\n` +
      `STRICT PROFILE & AUTH INSTRUCTIONS:\n` +
      `1. The official name of the logged-in app user is strictly "${officialFullName}". Whenever asked for the user's name or profile name, you MUST answer with "${officialFullName}". NEVER use doctor names or patient names printed inside uploaded medical reports.\n` +
      `2. When asked what login method, authentication type, or how the user logged in (e.g. mobile vs email or Firebase UID), answer based on "Login Method / Authentication Type" above.\n` +
      `3. If the user asks for all details, patient code, username, DOB, allergies, blood group, email, phone, or verification status, state the exact details from this official database block.`
    );
  }

  function buildMedicationBlock(medications, refillMap, domains, options) {
    const medPaginated = paginateArray(medications, options.medications || options);
    const { data: pageMeds, page } = medPaginated;

    if (page.totalRecords === 0) {
      return (
        `=== ACTIVE PROFILE MEDICATIONS & REFILL DETAILS (PAGINATED ARRAY) ===\n` +
        `Active Profile Medications:\n` +
        `${formatMedicationPagination(page)}\n` +
        `Data Array: []\n` +
        `Status: No active medications found in profile.`
      );
    }

    const medListFormatted = pageMeds
      .map((m, idx) => {
        const itemIndex = (page.pageNumber - 1) * page.pageLimit + idx + 1;
        const name = m.medicationName || "Unknown Medicine";
        const type = m.medicationType ? ` (${m.medicationType})` : "";
        const dose = m.dosePerIntake ? `${m.dosePerIntake}` : "";
        const unit = m.unit ? ` ${m.unit}` : "";
        const doseStr = dose || unit ? `: ${dose}${unit}` : "";
        const freq = m.frequency ? `, Frequency: ${m.frequency}` : "";
        const food = m.foodFrequency ? ` (${m.foodFrequency})` : "";
        const dailyConsumptionStr = m.dailyConsumption
          ? `, Daily Consumption: ${m.dailyConsumption} ${m.unit || "unit(s)"}/day`
          : "";

        const startDateStr = m.startDate ? String(m.startDate).split("T")[0] : "Not specified";
        const rawEndDate = m.endDate ? String(m.endDate).split("T")[0] : null;
        let endDateStr = "Not specified";
        if (rawEndDate && m.ongoing) {
          endDateStr = `${rawEndDate} (Treatment is Ongoing)`;
        } else if (rawEndDate) {
          endDateStr = rawEndDate;
        } else if (m.ongoing) {
          endDateStr = "Ongoing (No fixed end date)";
        }
        const ongoingStatusStr = m.ongoing ? "Yes (Ongoing)" : "No (Fixed Duration)";

        let scheduleStr = "";
        if (m.medicationSchedule && typeof m.medicationSchedule === "object") {
          const times = Object.entries(m.medicationSchedule)
            .filter(([, v]) => v)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ");
          if (times) scheduleStr = `, Schedule: [${times}]`;
        }

        const doctor = m.prescribedBy ? `, Prescribed By: ${m.prescribedBy}` : "";
        let refillInfo = "";
        let calculatedRemainingInfo = "";

        const refillObj = refillMap.get(m.id);
        const baseQty = refillObj?.afterRefillRemainingQuantity ?? m.totalQuantity ?? null;
        const baseDate = refillObj?.createdAt
          ? new Date(refillObj.createdAt)
          : m.startDate
            ? new Date(m.startDate)
            : null;

        if (baseQty !== null && baseDate && !isNaN(baseDate.getTime()) && m.dailyConsumption) {
          const today = new Date();
          const daysPassed = Math.max(0, Math.floor((today - baseDate) / (1000 * 60 * 60 * 24)));
          const estimatedConsumed = daysPassed * m.dailyConsumption;
          const estimatedRemaining = Math.max(0, baseQty - estimatedConsumed);
          calculatedRemainingInfo = `\n  • Dynamic Estimated Stock Remaining: ~${estimatedRemaining} ${m.unit || "unit(s)"} (Calculated from base ${baseQty} - ${daysPassed} days × ${m.dailyConsumption}/day consumed since ${baseDate.toISOString().split("T")[0]})`;
        }

        if (domains.has("REFILLS")) {
          if (refillObj) {
            const refillDate = refillObj.createdAt
              ? toIsoDateOnly(new Date(refillObj.createdAt))
              : "N/A";
            refillInfo = `\n  • Refill Record (Last Refill: ${refillDate}):\n    - Before Refill: Remaining = ${refillObj.beforeRefillRemainingQuantity}, Total = ${refillObj.beforeRefillTotalQuantity}\n    - Refill Added Quantity: +${refillObj.refillQuantity}\n    - After Refill: Remaining = ${refillObj.afterRefillRemainingQuantity}, Total = ${refillObj.afterRefillTotalQuantity}`;
          } else {
            refillInfo = `\n  • Refills Remaining: ${m.refillCount ?? "N/A"}`;
          }
        }

        return `${itemIndex}. - ${name}${type}${doseStr}${freq}${food}${dailyConsumptionStr}\n  Status: Ongoing=${ongoingStatusStr} | Start Date: ${startDateStr} | End Date: ${endDateStr}${scheduleStr}${doctor}${refillInfo}${calculatedRemainingInfo}`;
      })
      .join("\n");

    return (
      `=== ACTIVE PROFILE MEDICATIONS & REFILL DETAILS (PAGINATED ARRAY) ===\n` +
      `Active Profile Medications:\n` +
      `${formatMedicationPagination(page)}\n` +
      `Data Array (Showing ${pageMeds.length} items):\n${medListFormatted}`
    );
  }

  function buildReminderBlock(todayOccurrences, options) {
    const reminderPaginated = paginateArray(todayOccurrences, options.reminders || options);
    const { data: pageOccurrences, page } = reminderPaginated;

    if (page.totalRecords === 0) {
      return (
        `=== MEDICATION REMINDERS STATUS TODAY (PAGINATED ARRAY) ===\n` +
        `${formatReminderPagination(page, {})}\n` +
        `Data Array: []\n` +
        `Status: No doses scheduled for today.`
      );
    }

    const taken = todayOccurrences.filter(isTaken);
    const missed = todayOccurrences.filter(isMissed);
    const pending = todayOccurrences.filter(isPending);

    const paginationStr = formatReminderPagination(page, {
      takenCount: taken.length,
      missedCount: missed.length,
      pendingCount: pending.length,
    });

    let occurrenceStr =
      `=== MEDICATION REMINDERS STATUS TODAY (PAGINATED ARRAY) ===\n` +
      `${paginationStr}\n` +
      `Data Array (Page Items: ${pageOccurrences.length}):`;

    const pageTaken = pageOccurrences.filter(isTaken);
    const pageMissed = pageOccurrences.filter(isMissed);
    const pagePending = pageOccurrences.filter(isPending);

    if (pageTaken.length > 0) {
      occurrenceStr +=
        `\nCompleted/Taken Doses (Page ${page.pageNumber}):\n` +
        pageTaken
          .map((o) => {
            const timeStr = formatLocalTime(o.completedAt) || "recorded time";
            return `- ${o.medicationName || "Medication"} (Completed at ${timeStr})`;
          })
          .join("\n");
    }

    if (pageMissed.length > 0) {
      occurrenceStr +=
        `\nMissed/Overdue Doses (Page ${page.pageNumber}):\n` +
        pageMissed
          .map((o) => {
            const timeStr = formatLocalTime(o.actualMedicationTime) || "scheduled time";
            return `- ${o.medicationName || "Medication"} (Scheduled at ${timeStr}, Status: ${o.status})`;
          })
          .join("\n");
    }

    if (pagePending.length > 0) {
      occurrenceStr +=
        `\nPending / Future Doses Remaining (Page ${page.pageNumber}):\n` +
        pagePending
          .map((o) => {
            const timeStr = formatLocalTime(o.actualMedicationTime) || "scheduled time";
            return `- ${o.medicationName || "Medication"} (Scheduled at ${timeStr})`;
          })
          .join("\n");
    }

    return occurrenceStr;
  }

  function buildDocumentBlock(documents, options) {
    const docPaginated = paginateArray(documents, options.documents || options);
    const { data: pageDocs, page } = docPaginated;

    if (page.totalRecords === 0) {
      return (
        `=== MEDICAL DOCUMENTS CATALOG (PAGINATED ARRAY) ===\n` +
        `${formatDocumentPagination(page)}\n` +
        `Data Array: []\n` +
        `Status: No documents uploaded.`
      );
    }

    const typeCounts = {};
    const failedDocs = [];
    const completedDocs = [];
    const pendingDocs = [];

    documents.forEach((d) => {
      const type = d.documentType || "general";
      typeCounts[type] = (typeCounts[type] || 0) + 1;

      const statusStr = String(d.ocrStatus || "completed").toLowerCase();
      if (statusStr === "failed") {
        failedDocs.push(d);
      } else if (statusStr === "completed") {
        completedDocs.push(d);
      } else {
        pendingDocs.push(d);
      }
    });

    const typeSummary = Object.entries(typeCounts)
      .map(([t, c]) => `${t}: ${c}`)
      .join(", ");

    const docList = pageDocs
      .map((d, index) => {
        const itemIndex = (page.pageNumber - 1) * page.pageLimit + index + 1;
        const dateStr = d.reportDate
          ? String(d.reportDate).split("T")[0]
          : d.createdAt
            ? new Date(d.createdAt).toISOString().split("T")[0]
            : "Unknown";
        const statusText = d.ocrStatus ? ` [OCR Status: ${String(d.ocrStatus).toUpperCase()}]` : "";
        const remarksText = d.remarks ? ` (Remarks: "${d.remarks}")` : "";
        return `${itemIndex}. File Name: "${d.fileName || "File"}" (Category: ${d.documentType || "document"}, Report Date: ${dateStr})${statusText}${remarksText}`;
      })
      .join("\n");

    let statusSummary =
      `=== MEDICAL DOCUMENTS CATALOG (PAGINATED ARRAY) ===\n` +
      `${formatDocumentPagination(page)}\n` +
      `Category Breakdown: [${typeSummary}]\nStatus Overview: Successfully Completed = ${completedDocs.length}, Processing/Pending = ${pendingDocs.length}, Failed = ${failedDocs.length}`;

    if (failedDocs.length > 0) {
      statusSummary +=
        `\n\nFailed Documents Details (${failedDocs.length}):\n` +
        failedDocs
          .map((fd) => {
            const dateStr = fd.reportDate
              ? String(fd.reportDate).split("T")[0]
              : fd.createdAt
                ? new Date(fd.createdAt).toISOString().split("T")[0]
                : "Unknown";
            const reason = fd.remarks || "Low image scan quality or text extraction error";
            return `- File: "${fd.fileName}" (Category: ${fd.documentType || "general"}, Date: ${dateStr})\n  Failure Reason: ${reason}`;
          })
          .join("\n");
    }

    return `${statusSummary}\n\nUploaded Document List Array (Page ${page.pageNumber}):\n${docList}\n\nSTRICT DOCUMENT LISTING INSTRUCTION: When asked to list uploaded documents, state the total count (${page.totalRecords}) and current page (${page.pageNumber} of ${page.totalPages}), and list the exact File Names provided in the Uploaded Document List Array above. Do NOT use names extracted from report body text.`;
  }

  function buildNotificationBlock(notifications, options) {
    const notifPaginated = paginateArray(notifications, options.notifications || options);
    const { data: pageNotifs, page } = notifPaginated;

    if (page.totalRecords === 0) {
      return (
        `=== NOTIFICATIONS SUMMARY (PAGINATED ARRAY) ===\n` +
        `${formatNotificationPagination(page, {})}\n` +
        `Data Array: []\n` +
        `Status: No notifications.`
      );
    }

    const readCount = notifications.filter((n) => n.isRead === true).length;
    const unreadCount = notifications.filter((n) => n.isRead !== true).length;
    const notifList = pageNotifs
      .map((n) => {
        const statusStr = n.isRead ? "READ" : "UNREAD";
        const timeStr = n.createdAt ? new Date(n.createdAt).toISOString().split("T")[0] : "";
        return `- [${statusStr}] [${timeStr}] ${n.title || "Notification"}: ${n.body || n.message || ""}`;
      })
      .join("\n");

    return (
      `=== NOTIFICATIONS SUMMARY (PAGINATED ARRAY) ===\n` +
      `${formatNotificationPagination(page, { readCount, unreadCount })}\n` +
      `Data Array (Page ${page.pageNumber}):\n${notifList}`
    );
  }

  // --- PHASE 3: Merge Context Blocks ---
  const contextParts = [];

  if (patient) {
    contextParts.push(buildProfileBlock(patient));
  }

  if (domains.has("MEDICATIONS")) {
    contextParts.push(buildMedicationBlock(medications, refillMap, domains, options));
  }

  if (domains.has("REMINDERS")) {
    contextParts.push(buildReminderBlock(todayOccurrences, options));
  }

  if (domains.has("DOCUMENTS")) {
    contextParts.push(buildDocumentBlock(documents, options));
  }

  if (domains.has("NOTIFICATIONS")) {
    contextParts.push(buildNotificationBlock(notifications, options));
  }

  return contextParts.join("\n\n");
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
        const retrievalTasks = [];
        for (const dId of finalDocumentIds) {
          if (medicalEntities.length > 0) {
            for (const entity of medicalEntities) {
              retrievalTasks.push({ dId, entity, limit: 10, keywords: [entity] });
            }
          } else {
            retrievalTasks.push({ dId, entity: null, limit: 20 });
          }
        }

        const queryResults = await Promise.all(
          retrievalTasks.map(async ({ dId, entity, limit, keywords }) => {
            try {
              const queryParams = {
                userId,
                queryEmbedding,
                limit,
                documentIds: [dId],
              };
              if (keywords) {
                queryParams.keywords = keywords;
              }
              const chunks = await intelligenceRepository.searchSimilarChunks(queryParams);
              return { dId, entity, chunks, success: true };
            } catch (err) {
              if (entity) {
                debugLogger.error(`Failed to retrieve chunks for doc ${dId} and entity ${entity}`, {
                  error: err.message,
                });
              } else {
                debugLogger.error(`Failed to retrieve chunks for doc ${dId}`, {
                  error: err.message,
                });
              }
              return { dId, entity, chunks: [], success: false };
            }
          }),
        );

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
        const finalSelectionIds = new Set();

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
            if (!finalSelectionIds.has(c)) {
              finalSelection.push(c);
              finalSelectionIds.add(c);
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

          if (count < 6 && !finalSelectionIds.has(c)) {
            finalSelection.push(c);
            finalSelectionIds.add(c);
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
  paginateArray,
  getReportAgeString,
  getMedicalEntityKeywords,
  detectContextGraph,
  buildDependencyAwareContext,
  RagContextService,
  ragContextService,
};
