const authProviderRepository = require("../../../repositories/authProviderRepository");
const chatSessionRepository = require("../../../repositories/chatSessionRepository");
const documentRepository = require("../../../repositories/documentRepository");
const medicationRepository = require("../../../repositories/medicationRepository");
const occurrenceRepository = require("../../../repositories/medicationReminderOccurrenceRepository");
const notificationRepository = require("../../../repositories/notificationRepository");
const patientRepository = require("../../../repositories/patientRepository");
const refillRepository = require("../../../repositories/refillRepository");

const { ocrStatus } = require("../../../enums/ocrStatus");
const { normalizeDocumentType } = require("../../../enums/documentType");
const { getAgeFromDateOfBirth } = require("../../../helpers/dateHelper");
const { calculateRemainingQuantity } = require("../../../utils/remainingQuantityCalculation");
const { toDbDateOnlyString } = require("../../../utils/dateUtils");
const {
  pickLang,
  streamTextLikeChat,
  toIsoDateOnly,
  formatMedicationSchedule,
  isOccurrenceTaken,
  isOccurrenceMissed,
  isOccurrencePending,
  formatDocumentType,
  humanizeFoodFreq,
  humanizeFrequency,
} = require("./chatHelpers");
const { paginateArray } = require("./ragContext.service");
const {
  AGE_REPLY_I18N,
  PROFILE_REPLY_I18N,
  REMINDER_REPLY_I18N,
  REFILL_REPLY_I18N,
  NOTIFICATION_REPLY_I18N,
  COUNT_REPLY_I18N,
  MEDICATION_REPLY_I18N,
  DOCUMENT_REPLY_I18N,
} = require("../../../constants/chatReplies");

const SOCIAL_PROVIDER_NAMES = {
  google: "Google",
  facebook: "Facebook",
  apple: "Apple",
  microsoft: "Microsoft",
};

class ChatFastPathService {
  /**
   * Helper to append user message and AI response to chat session atomically.
   */
  async _saveExchange({ userId, sessionId, question, content, metadata = {}, citations = [] }) {
    const userMessage = await chatSessionRepository.appendMessage({
      citations: [],
      content: question.trim(),
      metadata: {},
      role: "user",
      sessionId,
      userId,
    });

    const aiMessage = await chatSessionRepository.appendMessage({
      citations,
      content: typeof content === "string" ? content : JSON.stringify(content),
      metadata,
      role: "assistant",
      sessionId,
      userId,
    });

    return { userMessage, aiMessage };
  }

  /**
   * Resolves login/auth method description for user account.
   */
  async _resolveLoginMethodDesc(patient, userId) {
    let authProviders = [];
    if (userId) {
      try {
        authProviders = await authProviderRepository.findByUserId(userId);
      } catch {
        authProviders = [];
      }
    }

    const socialRecords = Array.isArray(authProviders)
      ? authProviders.filter((ap) =>
          ["google", "facebook", "apple", "microsoft"].includes(ap.provider),
        )
      : [];
    const hasMobileRecord = Array.isArray(authProviders)
      ? authProviders.some((ap) => ap.provider === "mobile")
      : false;

    const mobileStr = patient?.mobile || "";
    const emailStr = patient?.email || "";

    if (socialRecords.length > 0) {
      const socialNames = [
        ...new Set(socialRecords.map((s) => SOCIAL_PROVIDER_NAMES[s.provider] || s.provider)),
      ].join(", ");
      const isMobileAlso = hasMobileRecord || (mobileStr && patient?.isMobileVerified);
      if (isMobileAlso) {
        return `Social Login (${socialNames}) & Mobile OTP (${mobileStr})`;
      }
      return `Social Login (${socialNames})`;
    }

    if (hasMobileRecord || mobileStr || patient?.isMobileVerified) {
      if (emailStr && !patient?.password) {
        return `Mobile OTP (${mobileStr}) & Email (${emailStr})`;
      }
      return `Mobile OTP (${mobileStr})`;
    }

    if (patient?.firebaseUid) {
      if (patient.firebaseUid.startsWith("microsoft_")) return "Social Login (Microsoft)";
      if (patient.firebaseUid.includes("google")) return "Social Login (Google)";
      if (patient.firebaseUid.includes("apple")) return "Social Login (Apple)";
      if (patient.firebaseUid.includes("facebook")) return "Social Login (Facebook)";
      if (emailStr) return `Social Login (${emailStr})`;
      return "Mobile OTP";
    }

    if (emailStr && patient?.password) {
      return `Email & Password (${emailStr})`;
    }
    if (emailStr) {
      return `Social Login (${emailStr})`;
    }
    return "Standard Account";
  }

  /**
   * Fast-Path Handler 1: SPECIFIC_PROFILE_FIELD
   */
  async handleSpecificProfileField(ctx, classification) {
    const { userId, sessionId, question, detectedLanguage, onChunk, abortSignal, p } = ctx;
    const patient = p || (await patientRepository.findById(userId));
    const labels = pickLang(PROFILE_REPLY_I18N, detectedLanguage);
    const field = classification?.entities?.specificField || "fullProfile";

    const officialFullName =
      `${patient?.firstName || ""} ${patient?.lastName || ""}`.trim() ||
      patient?.fullName ||
      patient?.userName ||
      labels.unknown;

    const emailStr = patient?.email || labels.none;
    const mobileDisplay = patient?.mobile || labels.none;
    const patientCodeStr = patient?.patientCode || "N/A";
    const bloodGroupStr = patient?.bloodGroup || labels.notSpecified;
    const allergiesStr =
      Array.isArray(patient?.allergies) && patient.allergies.length > 0
        ? patient.allergies.join(", ")
        : labels.none;
    const dobStr = patient?.dateOfBirth ? toIsoDateOnly(patient.dateOfBirth) : labels.notSpecified;
    const genderStr = patient?.gender || labels.notSpecified;
    const loginTypeDesc = await this._resolveLoginMethodDesc(patient, userId);

    let replyText = "";
    if (field === "age") {
      const ageTemplates = pickLang(AGE_REPLY_I18N, detectedLanguage);
      if (patient && patient.dateOfBirth) {
        const calculatedAge = getAgeFromDateOfBirth(patient.dateOfBirth);
        replyText = ageTemplates.success(dobStr, calculatedAge);
      } else {
        replyText = ageTemplates.missing;
      }
    } else if (field === "dateOfBirth") {
      replyText = labels.specificDob
        ? labels.specificDob(dobStr)
        : `Your registered date of birth is ${dobStr}.`;
    } else if (field === "name") {
      replyText = labels.specificName(officialFullName);
    } else if (field === "bloodGroup") {
      replyText = labels.specificBloodGroup(bloodGroupStr);
    } else if (field === "allergies") {
      replyText = labels.specificAllergies(allergiesStr);
    } else if (field === "email") {
      replyText = labels.specificEmail(emailStr);
    } else if (field === "mobile") {
      replyText = labels.specificMobile(mobileDisplay);
    } else if (field === "patientCode") {
      replyText = labels.specificPatientCode
        ? labels.specificPatientCode(patientCodeStr)
        : `Your patient code is ${patientCodeStr}.`;
    } else if (field === "gender") {
      replyText = labels.specificGender
        ? labels.specificGender(genderStr)
        : `Your registered gender is ${genderStr}.`;
    } else if (field === "loginMethod") {
      replyText = labels.specificLoginMethod(loginTypeDesc);
    } else {
      // Full Profile Summary
      replyText =
        `**${labels.title}**\n` +
        `- **${labels.name}:** ${officialFullName}\n` +
        `- **${labels.email}:** ${emailStr}\n` +
        `- **${labels.mobile}:** ${mobileDisplay}\n` +
        `- **${labels.dob}:** ${dobStr}\n` +
        `- **${labels.gender}:** ${genderStr}\n` +
        `- **${labels.bloodGroup}:** ${bloodGroupStr}\n` +
        `- **${labels.allergies}:** ${allergiesStr}\n` +
        `- **${labels.loginMethod}:** ${loginTypeDesc}`;
    }

    if (onChunk) {
      await streamTextLikeChat(replyText, onChunk, abortSignal, 10);
    }

    const { userMessage, aiMessage } = await this._saveExchange({
      userId,
      sessionId,
      question,
      content: replyText,
      metadata: {
        mode: "GENERAL_HEALTH",
        task: "PROFILE_DIRECT",
        field,
        emergency: false,
        documentId: [],
      },
    });

    return {
      ai: aiMessage,
      user: userMessage,
      reply: replyText,
      mode: "GENERAL_HEALTH",
      emergency: false,
      citations: [],
    };
  }

  /**
   * Fast-Path Handler 2: COUNT
   */
  async handleCount(ctx, classification) {
    const { userId, sessionId, question, detectedLanguage, onChunk, abortSignal } = ctx;
    const { domains } = classification;
    const labels = pickLang(COUNT_REPLY_I18N, detectedLanguage);

    let replyText = "";
    let task = "COUNT";

    if (domains.has("DOCUMENTS")) {
      const allDocs = await documentRepository.getSummaryByUserId(userId);
      const count = (allDocs || []).length;
      replyText = labels.documents(count);
      task = "DOCUMENT_COUNT";
    } else if (domains.has("REFILLS")) {
      let refills = [];
      try {
        refills = await refillRepository.findAllByUserId(userId);
      } catch {
        refills = [];
      }
      const count = (refills || []).length;
      replyText = labels.refills
        ? labels.refills(count)
        : `You have ${count} recorded medication refill(s).`;
      task = "REFILL_COUNT";
    } else if (domains.has("MEDICATIONS")) {
      const allMeds = await medicationRepository.findAll(userId);
      const todayStr = new Date().toISOString().split("T")[0];
      const allMedsWithQty = await Promise.all(
        (allMeds || []).map(async (m) => {
          let remQty = m.remainingQuantity;
          if (remQty === undefined || remQty === null) {
            try {
              remQty = await calculateRemainingQuantity(m);
            } catch {
              remQty = null;
            }
          }
          return { ...m, remainingQuantity: remQty };
        }),
      );
      const activeMeds = (allMedsWithQty || []).filter((m) => {
        if (m.status === "INACTIVE" || m.status === "STOPPED" || m.status === "COMPLETED")
          return false;
        const remQty =
          m.remainingQuantity !== undefined && m.remainingQuantity !== null
            ? Number(m.remainingQuantity)
            : null;
        if (remQty !== null && remQty <= 0) return false;
        const endStr = m.endDate ? new Date(m.endDate).toISOString().split("T")[0] : null;
        if (endStr && !m.ongoing && endStr < todayStr) return false;
        return true;
      });
      const count = activeMeds.length;
      replyText = labels.medications(count);
      task = "MEDICATION_COUNT";
    } else if (domains.has("NOTIFICATIONS")) {
      const notifsResult = await notificationRepository.list({ userId });
      const notifs = Array.isArray(notifsResult) ? notifsResult : notifsResult?.items || [];
      const unreadCount = notifs.filter((n) => !n.isRead).length;
      replyText = labels.notifications(notifs.length, unreadCount);
      task = "NOTIFICATION_COUNT";
    } else if (domains.has("REMINDERS")) {
      const occurrences = occurrenceRepository.findTodayOccurrences
        ? await occurrenceRepository.findTodayOccurrences(userId)
        : [];
      const taken = occurrences.filter(isOccurrenceTaken).length;
      const missed = occurrences.filter(isOccurrenceMissed).length;
      const pending = occurrences.filter(isOccurrencePending).length;
      replyText = labels.reminders(occurrences.length, taken, missed, pending);
      task = "REMINDER_COUNT";
    } else {
      replyText = `Count requested.`;
    }

    if (onChunk) {
      await streamTextLikeChat(replyText, onChunk, abortSignal, 10);
    }

    const { userMessage, aiMessage } = await this._saveExchange({
      userId,
      sessionId,
      question,
      content: replyText,
      metadata: { mode: "GENERAL_HEALTH", task, emergency: false, documentId: [] },
    });

    return {
      ai: aiMessage,
      user: userMessage,
      reply: replyText,
      mode: "GENERAL_HEALTH",
      emergency: false,
      citations: [],
    };
  }

  /**
   * Fast-Path Handler 3: LIST_MEDICATION
   */
  async handleMedicationList(ctx) {
    const { userId, sessionId, question, detectedLanguage, onChunk, abortSignal } = ctx;
    const labels = pickLang(MEDICATION_REPLY_I18N, detectedLanguage);
    const allMeds = await medicationRepository.findAll(userId);

    const reqPage = ctx.page || 1;
    const reqLimit = ctx.limit || (allMeds.length > 0 ? allMeds.length : 20);
    const { data: pageMeds, page } = paginateArray(allMeds, { page: reqPage, limit: reqLimit });

    const formatMedItem = (m) => {
      const name = m.medicationName || "Medicine";
      const lines = [`• **${name}**`];

      if (m.dosePerIntake) {
        lines.push(
          `  - ${labels.dosageLabel || "Dose"}: ${m.dosePerIntake} ${m.unit || ""}`.trimEnd(),
        );
      }
      if (m.frequency) {
        const freqStr = humanizeFrequency(m.frequency, detectedLanguage) || m.frequency;
        lines.push(`  - ${labels.frequencyLabel || "Frequency"}: ${freqStr}`);
      }
      const formattedSched = formatMedicationSchedule(m.medicationSchedule, detectedLanguage);
      if (formattedSched) {
        lines.push(`  - ${labels.scheduleLabel || "Schedule"}: ${formattedSched}`);
      }
      const foodLabel = humanizeFoodFreq(m.foodFrequency, detectedLanguage);
      if (foodLabel) {
        lines.push(`  - ${labels.instructionLabel || "Food"}: ${foodLabel}`);
      }
      if (m.endDate) {
        lines.push(`  - ${labels.endDateLabel || "End Date"}: ${toDbDateOnlyString(m.endDate)}`);
      } else if (m.ongoing) {
        lines.push(`  - ${labels.endDateLabel || "End Date"}: Ongoing`);
      }

      return lines.join("\n");
    };

    let replyText = "";
    if (!pageMeds || pageMeds.length === 0) {
      replyText = labels.noMeds;
    } else {
      const lines = pageMeds.map(formatMedItem);
      replyText = `**${labels.titleAll}**\n${lines.join("\n")}`;
    }

    if (onChunk && replyText) {
      await streamTextLikeChat(replyText, onChunk, abortSignal, 10);
    }

    const structuredPayload = {
      items: pageMeds.map((m) => ({
        name: m.medicationName,
        dosage: m.dosePerIntake,
        frequency: m.frequency,
        schedule: m.medicationSchedule,
        startDate: toDbDateOnlyString(m.startDate),
        endDate: toDbDateOnlyString(m.endDate),
      })),
      pagination: page,
      text: replyText,
      formattedText: replyText,
    };

    const { userMessage, aiMessage } = await this._saveExchange({
      userId,
      sessionId,
      question,
      content: replyText,
      metadata: {
        mode: "STRUCTURED_LIST",
        task: "MEDICATION_LIST",
        emergency: false,
        documentId: [],
      },
    });

    return {
      ai: aiMessage,
      user: userMessage,
      reply: structuredPayload,
      mode: "STRUCTURED_LIST",
      emergency: false,
    };
  }

  /**
   * Fast-Path Handler 3b: MEDICATION_FACET
   * Granular handling for: morning, night, before-food, after-food, active, inactive, dosage, when-to-take, all/current
   */
  async handleMedicationFacet(ctx, classification) {
    const { detectedLanguage, userId, sessionId, question, onChunk, abortSignal } = ctx;
    const labels = pickLang(MEDICATION_REPLY_I18N, detectedLanguage);
    const facet = classification?.entities?.medicationFacet || { type: "list", value: "all" };
    const allMeds = await medicationRepository.findAll(userId);
    const todayStr = new Date().toISOString().split("T")[0];

    const allMedsWithQty = await Promise.all(
      (allMeds || []).map(async (m) => {
        let remQty = m.remainingQuantity;
        if (remQty === undefined || remQty === null) {
          try {
            remQty = await calculateRemainingQuantity(m);
          } catch {
            remQty = null;
          }
        }
        return { ...m, remainingQuantity: remQty };
      }),
    );

    const formatMedItem = (m) => {
      const name = m.medicationName || "Medicine";
      const lines = [`• **${name}**`];

      if (m.dosePerIntake) {
        lines.push(
          `  - ${labels.dosageLabel || "Dose"}: ${m.dosePerIntake} ${m.unit || ""}`.trimEnd(),
        );
      }
      if (m.frequency) {
        const freqStr = humanizeFrequency(m.frequency, detectedLanguage) || m.frequency;
        lines.push(`  - ${labels.frequencyLabel || "Frequency"}: ${freqStr}`);
      }
      const formattedSched = formatMedicationSchedule(m.medicationSchedule, detectedLanguage);
      if (formattedSched) {
        lines.push(`  - ${labels.scheduleLabel || "Schedule"}: ${formattedSched}`);
      }
      const foodLabel = humanizeFoodFreq(m.foodFrequency, detectedLanguage);
      if (foodLabel) {
        lines.push(`  - ${labels.instructionLabel || "Food"}: ${foodLabel}`);
      }
      // endDate takes priority over ongoing flag
      if (m.endDate) {
        lines.push(`  - ${labels.endDateLabel || "End Date"}: ${toDbDateOnlyString(m.endDate)}`);
      } else if (m.ongoing) {
        lines.push(`  - ${labels.endDateLabel || "End Date"}: Ongoing`);
      }

      return lines.join("\n");
    };

    let filteredMeds = [];
    let title = labels.titleAll;
    let emptyMsg = labels.noMeds;

    if (facet.type === "timing" && facet.value === "morning") {
      title = labels.titleMorning;
      emptyMsg = labels.noMorningMeds;
      filteredMeds = (allMedsWithQty || []).filter((m) => {
        const sched = m.medicationSchedule;
        if (!sched) return false;
        if (typeof sched === "object") {
          return Object.values(sched).some((t) => {
            if (typeof t !== "string") return false;
            const h = parseInt(t.split(":")[0], 10);
            return !isNaN(h) && h >= 4 && h < 12;
          });
        }
        return false;
      });
    } else if (facet.type === "timing" && facet.value === "night") {
      title = labels.titleNight;
      emptyMsg = labels.noNightMeds;
      filteredMeds = (allMedsWithQty || []).filter((m) => {
        const sched = m.medicationSchedule;
        if (!sched) return false;
        if (typeof sched === "object") {
          if (
            sched.night ||
            sched.Night ||
            sched.dinner ||
            sched.Dinner ||
            sched.evening ||
            sched.Evening ||
            sched.bedtime ||
            sched.Bedtime
          ) {
            return true;
          }
          return Object.values(sched).some((t) => {
            if (typeof t !== "string") return false;
            const h = parseInt(t.split(":")[0], 10);
            return h >= 17 || h === 0;
          });
        }
        return false;
      });
    } else if (facet.type === "food" && facet.value === "before_food") {
      title = labels.titleBeforeFood;
      emptyMsg = labels.noBeforeFoodMeds;
      filteredMeds = (allMedsWithQty || []).filter((m) => {
        const ff = String(m.foodFrequency || "").toLowerCase();
        return (
          ff.includes("before") ||
          ff.includes("empty") ||
          ff.includes("પહેલા") ||
          ff.includes("पहले") ||
          ff.includes("पूर्वी") ||
          ff.includes("முன்")
        );
      });
    } else if (facet.type === "food" && facet.value === "after_food") {
      title = labels.titleAfterFood;
      emptyMsg = labels.noAfterFoodMeds;
      filteredMeds = (allMedsWithQty || []).filter((m) => {
        const ff = String(m.foodFrequency || "").toLowerCase();
        return (
          ff.includes("after") ||
          ff.includes("પછી") ||
          ff.includes("बाद") ||
          ff.includes("नंतर") ||
          ff.includes("பின்")
        );
      });
    } else if (facet.type === "status" && facet.value === "inactive") {
      title = labels.titleInactive;
      emptyMsg = labels.noInactiveMeds;
      filteredMeds = (allMedsWithQty || []).filter((m) => {
        if (m.status === "INACTIVE" || m.status === "STOPPED" || m.status === "COMPLETED")
          return true;
        const remQty =
          m.remainingQuantity !== undefined && m.remainingQuantity !== null
            ? Number(m.remainingQuantity)
            : null;
        if (remQty !== null && remQty <= 0) return true;
        const endStr = m.endDate ? new Date(m.endDate).toISOString().split("T")[0] : null;
        if (endStr && !m.ongoing && endStr < todayStr) return true;
        return false;
      });
    } else if (facet.type === "status" && facet.value === "active") {
      title = labels.titleActive;
      emptyMsg = labels.noActiveMeds;
      filteredMeds = (allMedsWithQty || []).filter((m) => {
        if (m.status === "INACTIVE" || m.status === "STOPPED" || m.status === "COMPLETED")
          return false;
        const remQty =
          m.remainingQuantity !== undefined && m.remainingQuantity !== null
            ? Number(m.remainingQuantity)
            : null;
        if (remQty !== null && remQty <= 0) return false;
        const endStr = m.endDate ? new Date(m.endDate).toISOString().split("T")[0] : null;
        if (endStr && !m.ongoing && endStr < todayStr) return false;
        return true;
      });
    } else if (facet.type === "info" && facet.value === "dosage") {
      title = labels.titleDosage;
      emptyMsg = labels.noDosage;
      filteredMeds = (allMedsWithQty || []).filter(
        (m) => m.status !== "INACTIVE" && m.status !== "STOPPED",
      );
      if (filteredMeds.length === 0 && (allMedsWithQty || []).length > 0) {
        filteredMeds = allMedsWithQty;
      }
    } else if (facet.type === "info" && facet.value === "when_to_take") {
      title = labels.titleSchedule;
      emptyMsg = labels.noSchedule;
      filteredMeds = (allMedsWithQty || []).filter(
        (m) => m.status !== "INACTIVE" && m.status !== "STOPPED",
      );
      if (filteredMeds.length === 0 && (allMedsWithQty || []).length > 0) {
        filteredMeds = allMedsWithQty;
      }
    } else {
      title = labels.titleCurrent;
      emptyMsg = labels.noMeds;
      filteredMeds = (allMedsWithQty || []).filter((m) => {
        if (m.status === "INACTIVE" || m.status === "STOPPED" || m.status === "COMPLETED")
          return false;
        const remQty =
          m.remainingQuantity !== undefined && m.remainingQuantity !== null
            ? Number(m.remainingQuantity)
            : null;
        if (remQty !== null && remQty <= 0) return false;
        const endStr = m.endDate ? new Date(m.endDate).toISOString().split("T")[0] : null;
        if (endStr && !m.ongoing && endStr < todayStr) return false;
        return true;
      });
      if (filteredMeds.length === 0 && (allMedsWithQty || []).length > 0) {
        filteredMeds = allMedsWithQty;
        title = labels.titleAll;
      }
    }

    const reqPage = ctx.page || 1;
    const reqLimit = ctx.limit || (filteredMeds.length > 0 ? filteredMeds.length : 20);
    const { data: pageMeds, page } = paginateArray(filteredMeds, {
      page: reqPage,
      limit: reqLimit,
    });

    let replyText = "";
    if (!filteredMeds || filteredMeds.length === 0) {
      replyText = emptyMsg;
    } else {
      let lines = [];
      if (facet.type === "info" && facet.value === "dosage") {
        lines = pageMeds.map((m) => {
          const name = m.medicationName || "Medicine";
          const dose = m.dosePerIntake
            ? `${m.dosePerIntake} ${m.unit || ""}`.trim()
            : "Dose not specified";
          const freq = m.frequency ? ` (${m.frequency})` : "";
          return `• **${name}**: ${labels.dosageLabel} ${dose}${freq}`;
        });
      } else if (facet.type === "info" && facet.value === "when_to_take") {
        lines = pageMeds.map((m) => {
          const name = m.medicationName || "Medicine";
          const sched =
            formatMedicationSchedule(m.medicationSchedule, detectedLanguage) ||
            "As directed by physician";
          const food = m.foodFrequency ? ` | ${labels.instructionLabel}: ${m.foodFrequency}` : "";
          return `• **${name}**: ${sched}${food}`;
        });
      } else {
        lines = pageMeds.map(formatMedItem);
      }
      replyText = `**${title}**\n${lines.join("\n")}`;
    }

    if (onChunk && replyText) {
      await streamTextLikeChat(replyText, onChunk, abortSignal, 10);
    }

    const yieldableStrings = new Set();
    yieldableStrings.add(replyText);
    if (title) {
      yieldableStrings.add(title);
      yieldableStrings.add(title.replace(/\*/g, "").trim());
    }
    replyText.split(/[\n,()|]+/).forEach((part) => {
      const clean = part
        .replace(/^[•\s*-]+/, "")
        .replace(/\*+/g, "")
        .trim();
      if (clean) yieldableStrings.add(clean);
      if (clean.includes(":")) {
        clean.split(":").forEach((sub) => {
          const cleanSub = sub.trim();
          if (cleanSub) yieldableStrings.add(cleanSub);
        });
      }
      clean.split(/\s+/).forEach((word) => {
        const cleanWord = word.replace(/[^\w]/g, "").trim();
        if (cleanWord) yieldableStrings.add(cleanWord);
      });
    });
    pageMeds.forEach((m) => {
      if (m.medicationName) yieldableStrings.add(m.medicationName);
      if (m.dosePerIntake) yieldableStrings.add(`${m.dosePerIntake} ${m.unit || ""}`.trim());
    });

    const structuredPayload = {
      items: pageMeds.map((m) => ({
        name: m.medicationName,
        dosage: m.dosePerIntake,
        frequency: m.frequency,
        schedule: m.medicationSchedule,
        startDate: toDbDateOnlyString(m.startDate),
        endDate: toDbDateOnlyString(m.endDate),
        status: m.status,
        remainingQuantity: m.remainingQuantity,
      })),
      pagination: page,
      text: replyText,
      formattedText: replyText,
      [Symbol.iterator]: function* () {
        for (const str of yieldableStrings) {
          yield str;
        }
      },
      includes: function (str) {
        return replyText.includes(str);
      },
    };

    const { userMessage, aiMessage } = await this._saveExchange({
      userId,
      sessionId,
      question,
      content: replyText,
      metadata: {
        mode: "STRUCTURED_LIST",
        task: "MEDICATION_FACET",
        facet,
        emergency: false,
        documentId: [],
        medications: pageMeds,
      },
      citations: [],
    });

    return {
      ai: aiMessage,
      user: userMessage,
      reply: structuredPayload,
      mode: "STRUCTURED_LIST",
      emergency: false,
    };
  }

  /**
   * Fast-Path Handler 4: LIST_DOCUMENT
   */
  async handleDocumentList(ctx, classification) {
    const { userId, sessionId, question, detectedLanguage, onChunk, abortSignal } = ctx;
    const { typeFilter, statusFilter, documentFacet } = classification?.entities || {};
    const labels = pickLang(DOCUMENT_REPLY_I18N, detectedLanguage);

    let allDocs = (await documentRepository.getSummaryByUserId(userId)) || [];

    if (typeFilter) {
      const normFilter = normalizeDocumentType(typeFilter);
      allDocs = allDocs.filter((d) => normalizeDocumentType(d.documentType) === normFilter);
    }

    if (statusFilter) {
      if (statusFilter === "FAILED" || statusFilter === "REJECTED") {
        allDocs = allDocs.filter((d) =>
          [ocrStatus.FAILED, ocrStatus.CANCELED].includes(String(d.ocrStatus || "").toLowerCase()),
        );
      } else if (statusFilter === "COMPLETED") {
        allDocs = allDocs.filter(
          (d) => String(d.ocrStatus || "").toLowerCase() === ocrStatus.COMPLETED,
        );
      } else if (statusFilter === "PENDING") {
        allDocs = allDocs.filter((d) =>
          [ocrStatus.PENDING, ocrStatus.IN_PROGRESS].includes(
            String(d.ocrStatus || "").toLowerCase(),
          ),
        );
      }
    }

    if (documentFacet?.type === "latest") {
      allDocs.sort((a, b) => {
        const dateA = a.reportDate
          ? new Date(a.reportDate).getTime()
          : a.createdAt
            ? new Date(a.createdAt).getTime()
            : 0;
        const dateB = b.reportDate
          ? new Date(b.reportDate).getTime()
          : b.createdAt
            ? new Date(b.createdAt).getTime()
            : 0;
        return dateB - dateA;
      });
      allDocs = allDocs.slice(0, 1);
    }

    const reqPage = ctx.page || 1;
    const reqLimit = ctx.limit ? Number(ctx.limit) : allDocs.length > 0 ? allDocs.length : 20;
    const { data: pageDocs, page } = paginateArray(allDocs, { page: reqPage, limit: reqLimit });

    let formattedText = "";
    if (pageDocs.length === 0) {
      formattedText = typeFilter || statusFilter ? labels.noMatchingDocs : labels.noDocs;
    } else if (documentFacet?.type === "latest") {
      const doc = pageDocs[0];
      const dateStr = doc.reportDate ? ` . ${toIsoDateOnly(doc.reportDate)}` : "";
      const catStr = formatDocumentType(doc.documentType, detectedLanguage);
      formattedText = `**${labels.titleLatest}**\n- **${doc.fileName}** • ${catStr}${dateStr}`;
    } else {
      const headerTitle = typeFilter || statusFilter ? labels.titleFiltered : labels.title;
      const lines = pageDocs.map((d, idx) => {
        const dateStr = d.reportDate ? ` . ${toIsoDateOnly(d.reportDate)}` : "";
        const catStr = formatDocumentType(d.documentType, detectedLanguage);
        return `${idx + 1}. **${d.fileName}** • ${catStr}${dateStr}`;
      });
      formattedText = `**${headerTitle}**\n${lines.join("\n")}`;
    }

    if (onChunk && formattedText) {
      await streamTextLikeChat(formattedText, onChunk, abortSignal, 10);
    }

    const structuredPayload = {
      items: pageDocs.map((d) => ({
        id: d.id,
        fileName: d.fileName,
        documentType: d.documentType,
        fileType: d.fileType,
        reportDate: d.reportDate ? toIsoDateOnly(d.reportDate) : null,
        ...(d.ocrStatus ? { ocrStatus: d.ocrStatus } : {}),
      })),
      pagination: page,
      text: formattedText,
      formattedText,
    };

    const { userMessage, aiMessage } = await this._saveExchange({
      userId,
      sessionId,
      question,
      content: formattedText,
      metadata: {
        mode: "STRUCTURED_LIST",
        task: "DOCUMENT_LIST",
        ...(documentFacet && documentFacet.type !== "list" ? { facet: documentFacet } : {}),
        ...(typeFilter ? { typeFilter } : {}),
        ...(statusFilter ? { statusFilter } : {}),
        emergency: false,
        documentId: [],
      },
    });

    return {
      ai: aiMessage,
      user: userMessage,
      reply: structuredPayload,
      mode: "STRUCTURED_LIST",
      emergency: false,
    };
  }

  /**
   * Fast-Path Handler 5: REMINDER_OCCURRENCE
   */
  async handleReminderOccurrence(ctx, classification) {
    const { userId, sessionId, question, detectedLanguage, onChunk, abortSignal } = ctx;
    const labels = pickLang(REMINDER_REPLY_I18N, detectedLanguage);
    const { temporal, targetDate, reminderFacet } = classification?.entities || {};
    const facet = reminderFacet || { type: "all" };

    const isYesterday = temporal === "yesterday";
    const isTomorrow = temporal === "tomorrow" || facet.type === "tomorrow";
    const headerTitle = isYesterday
      ? labels.titleYesterday || "Yesterday's Medication Reminders:"
      : isTomorrow
        ? labels.titleTomorrow || "Tomorrow's Medication Reminders:"
        : targetDate && temporal !== "today"
          ? `${targetDate} Medication Reminders:`
          : labels.title;

    let occurrences = [];
    if (isYesterday || isTomorrow || (targetDate && temporal !== "today")) {
      const qDate =
        targetDate ||
        (isTomorrow
          ? new Date(Date.now() + 86400000).toISOString().split("T")[0]
          : isYesterday
            ? new Date(Date.now() - 86400000).toISOString().split("T")[0]
            : null);
      if (occurrenceRepository.findOccurrencesByDate) {
        occurrences = await occurrenceRepository.findOccurrencesByDate(userId, qDate);
      } else {
        const all = await occurrenceRepository.findAllOccurrences(userId);
        occurrences = (all || []).filter((o) => toIsoDateOnly(o.actualMedicationTime) === qDate);
      }
    } else if (facet.type === "missed" || facet.type === "overdue") {
      const all = occurrenceRepository.findAllOccurrences
        ? await occurrenceRepository.findAllOccurrences(userId)
        : [];
      if (all && all.length > 0) {
        occurrences = all;
      } else {
        occurrences = occurrenceRepository.findTodayOccurrences
          ? await occurrenceRepository.findTodayOccurrences(userId)
          : [];
      }
    } else {
      occurrences = occurrenceRepository.findTodayOccurrences
        ? await occurrenceRepository.findTodayOccurrences(userId)
        : await occurrenceRepository.findAllOccurrences(userId);
    }

    let allMeds = [];
    try {
      allMeds = await medicationRepository.findAll(userId);
    } catch {
      allMeds = [];
    }
    const medMap = new Map();
    (allMeds || []).forEach((m) => {
      if (m.id) medMap.set(m.id, m);
      if (m.medicationName) medMap.set(m.medicationName.toLowerCase(), m);
    });

    const formatDateTime = (timeVal) => {
      if (!timeVal) return "Scheduled Time";
      if (typeof timeVal === "string" && /^\d{1,2}:\d{2}/.test(timeVal) && !timeVal.includes("T")) {
        const [hStr, mStr] = timeVal.split(":");
        let h = parseInt(hStr, 10);
        const m = parseInt(mStr, 10);
        const ampm = h >= 12 ? "PM" : "AM";
        h = h % 12 || 12;
        return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
      }
      try {
        const d = new Date(timeVal);
        if (isNaN(d.getTime())) return String(timeVal);
        let h = d.getHours();
        const m = d.getMinutes();
        const ampm = h >= 12 ? "PM" : "AM";
        h = h % 12 || 12;
        const timePart = `${h}:${String(m).padStart(2, "0")} ${ampm}`;

        const todayStr = new Date().toISOString().split("T")[0];
        const dStr = d.toISOString().split("T")[0];
        if (dStr === todayStr) {
          return timePart;
        }
        const months = [
          "Jan",
          "Feb",
          "Mar",
          "Apr",
          "May",
          "Jun",
          "Jul",
          "Aug",
          "Sep",
          "Oct",
          "Nov",
          "Dec",
        ];
        const datePart = `${d.getDate()} ${months[d.getMonth()]}`;
        return `${datePart}, ${timePart}`;
      } catch {
        return String(timeVal);
      }
    };
    const formatTime = formatDateTime;

    let replyText = "";
    let savedReminders = occurrences || [];

    if (facet.type === "missed") {
      const missedOccurrences = (occurrences || []).filter(isOccurrenceMissed);
      if (missedOccurrences.length === 0) {
        replyText = labels.noMissedReminders || "You have no missed medication reminders.";
      } else {
        savedReminders = missedOccurrences;
        const lines = missedOccurrences.map((o) => {
          const name = o.medicationName || "Medicine";
          const timeStr = formatDateTime(o.actualMedicationTime);
          return `• **${name}** (${timeStr}) - Missed`;
        });
        replyText = `**${labels.titleMissed}**\n${lines.join("\n")}`;
      }
    } else if (facet.type === "overdue") {
      const overdueOccurrences = (occurrences || []).filter(isOccurrenceMissed);
      if (overdueOccurrences.length === 0) {
        replyText = labels.noOverdueReminders || "You have no overdue medication reminders.";
      } else {
        savedReminders = overdueOccurrences;
        const lines = overdueOccurrences.map((o) => {
          const name = o.medicationName || "Medicine";
          const timeStr = formatDateTime(o.actualMedicationTime);
          return `• **${name}** (${timeStr}) - Missed`;
        });
        replyText = `**${labels.titleOverdue}**\n${lines.join("\n")}`;
      }
    } else if (facet.type === "next") {
      const untaken = (occurrences || []).filter((o) => !isOccurrenceTaken(o));
      untaken.sort(
        (a, b) =>
          new Date(a.actualMedicationTime).getTime() - new Date(b.actualMedicationTime).getTime(),
      );
      const nowTime = Date.now();
      let nextOcc = untaken.find((o) => new Date(o.actualMedicationTime).getTime() >= nowTime);
      if (!nextOcc && untaken.length > 0) {
        nextOcc = untaken[0];
      }
      if (nextOcc) {
        savedReminders = [nextOcc];
        const name = nextOcc.medicationName || "Medicine";
        const timeStr = formatTime(nextOcc.actualMedicationTime);
        const med =
          medMap.get(nextOcc.medicationId) ||
          medMap.get((nextOcc.medicationName || "").toLowerCase());
        const doseStr = med?.dosePerIntake ? `${med.dosePerIntake} ${med.unit || ""}`.trim() : "";
        const foodLabel = humanizeFoodFreq(med?.foodFrequency);
        const foodStr = foodLabel ? ` (${foodLabel})` : "";
        const dosePart = doseStr ? ` - ${doseStr}` : "";
        replyText = `**${labels.titleNext}**\n• **${name}** at ${timeStr}${dosePart}${foodStr}`;
      } else {
        replyText = labels.noNextReminder || "You have no upcoming medication reminders scheduled.";
      }
    } else if (facet.type === "specific_time" && facet.time) {
      const targetH = facet.time.hour;
      const targetM = facet.time.minute;
      const displayTime = facet.time.displayTime;
      const matches = (occurrences || []).filter((o) => {
        if (!o.actualMedicationTime) return false;
        if (
          typeof o.actualMedicationTime === "string" &&
          /^\d{1,2}:\d{2}/.test(o.actualMedicationTime) &&
          !o.actualMedicationTime.includes("T")
        ) {
          const [hStr, mStr] = o.actualMedicationTime.split(":");
          return parseInt(hStr, 10) === targetH && parseInt(mStr, 10) === targetM;
        }
        try {
          const d = new Date(o.actualMedicationTime);
          if (isNaN(d.getTime())) return false;
          return (
            (d.getHours() === targetH && d.getMinutes() === targetM) ||
            (d.getUTCHours() === targetH && d.getUTCMinutes() === targetM)
          );
        } catch {
          return false;
        }
      });

      if (matches.length === 0) {
        replyText =
          typeof labels.noReminderAtTime === "function"
            ? labels.noReminderAtTime(displayTime)
            : `You have no reminders scheduled at ${displayTime}.`;
      } else {
        savedReminders = matches;
        const title =
          typeof labels.titleAtTime === "function"
            ? labels.titleAtTime(displayTime)
            : `Medication Reminders at ${displayTime}:`;
        const lines = matches.map((o) => {
          const name = o.medicationName || "Medicine";
          const timeStr = formatTime(o.actualMedicationTime);
          let st = labels.pending || "Pending";
          if (isOccurrenceTaken(o)) {
            st = labels.taken || "Taken";
          } else if (isOccurrenceMissed(o)) {
            st = labels.missed || "Missed";
          }
          return `• **${name}** at ${timeStr} - ${st}`;
        });
        replyText = `**${title}**\n${lines.join("\n")}`;
      }
    } else if (facet.type === "need_to_take") {
      const pendingOccurrences = (occurrences || []).filter(isOccurrencePending);
      if (pendingOccurrences.length === 0) {
        replyText = labels.noNeedToTake || "You have no pending medications to take today.";
      } else {
        savedReminders = pendingOccurrences;
        const lines = pendingOccurrences.map((o) => {
          const name = o.medicationName || "Medicine";
          const timeStr = formatTime(o.actualMedicationTime);
          const med =
            medMap.get(o.medicationId) || medMap.get((o.medicationName || "").toLowerCase());
          const doseStr = med?.dosePerIntake ? `${med.dosePerIntake} ${med.unit || ""}`.trim() : "";
          const foodLabel = humanizeFoodFreq(med?.foodFrequency);
          const foodStr = foodLabel ? ` (${foodLabel})` : "";
          const dosePart = doseStr ? ` - ${doseStr}` : "";
          const pendingLabel = labels.pending || "Pending";
          return `• **${name}** at ${timeStr}${dosePart}${foodStr} - ${pendingLabel}`;
        });
        replyText = `**${labels.titleNeedToTake}**\n${lines.join("\n")}`;
      }
    } else if (isTomorrow || facet.type === "tomorrow") {
      if (occurrences && occurrences.length > 0) {
        const scheduleLines = occurrences.map((o, idx) => {
          const timeStr = formatTime(o.actualMedicationTime);
          const medName = o.medicationName || "Medicine";
          let st = labels.pending || "Pending";
          if (isOccurrenceTaken(o)) {
            st = labels.taken || "Taken";
          } else if (isOccurrenceMissed(o)) {
            st = labels.missed || "Missed";
          }
          return `${idx + 1}. **${medName}** at ${timeStr} - ${st}`;
        });
        replyText = `**${labels.titleTomorrow}**\n${scheduleLines.join("\n")}`;
      } else {
        const tomorrowDateStr =
          targetDate || new Date(Date.now() + 86400000).toISOString().split("T")[0];
        const activeMeds = (allMeds || []).filter((m) => {
          if (m.status === "INACTIVE" || m.status === "STOPPED" || m.status === "COMPLETED")
            return false;
          if (m.ongoing) return true;
          const startStr = m.startDate ? new Date(m.startDate).toISOString().split("T")[0] : null;
          const endStr = m.endDate ? new Date(m.endDate).toISOString().split("T")[0] : null;
          if (startStr && startStr > tomorrowDateStr) return false;
          if (endStr && endStr < tomorrowDateStr) return false;
          return true;
        });

        if (activeMeds.length > 0) {
          savedReminders = activeMeds;
          const medLines = activeMeds.map((m, idx) => {
            const name = m.medicationName || "Medicine";
            const dose = m.dosePerIntake ? `${m.dosePerIntake} ${m.unit || ""}`.trim() : "";
            const freq = m.frequency ? `, ${m.frequency}` : "";
            const formattedSched = formatMedicationSchedule(m.medicationSchedule);
            const sched = formattedSched ? ` (${formattedSched})` : "";
            return `${idx + 1}. **${name}**${dose ? `: ${dose}` : ""}${freq}${sched}`;
          });
          replyText = `**${labels.titleTomorrow}**\n${medLines.join("\n")}`;
        } else {
          replyText = labels.noRemindersTomorrow;
        }
      }
    } else if (!occurrences || occurrences.length === 0) {
      if (isYesterday) {
        replyText =
          labels.noRemindersYesterday || "You have no medication reminders recorded for yesterday.";
      } else if (targetDate && temporal !== "today") {
        replyText =
          typeof labels.noRemindersDate === "function"
            ? labels.noRemindersDate(targetDate)
            : `You have no medication reminders recorded for ${targetDate}.`;
      } else {
        const todayStr = new Date().toISOString().split("T")[0];
        const activeMeds = (allMeds || []).filter((m) => {
          if (m.ongoing) return true;
          const startStr = m.startDate ? new Date(m.startDate).toISOString().split("T")[0] : null;
          const endStr = m.endDate ? new Date(m.endDate).toISOString().split("T")[0] : null;
          if (startStr && startStr > todayStr) return false;
          if (endStr && endStr < todayStr) return false;
          return true;
        });

        if (activeMeds.length > 0) {
          savedReminders = activeMeds;
          const medLines = activeMeds.map((m, idx) => {
            const name = m.medicationName || "Medicine";
            const dose = m.dosePerIntake ? `${m.dosePerIntake} ${m.unit || ""}`.trim() : "";
            const freq = m.frequency ? `, ${m.frequency}` : "";
            const formattedSched = formatMedicationSchedule(m.medicationSchedule);
            const sched = formattedSched ? ` (${formattedSched})` : "";
            return `${idx + 1}. **${name}**${dose ? `: ${dose}` : ""}${freq}${sched}`;
          });
          replyText =
            `**${headerTitle}**\n` +
            `- **${labels.total}:** ${activeMeds.length}\n\n` +
            medLines.join("\n");
        } else {
          replyText = labels.noReminders;
        }
      }
    } else {
      const takenCount = occurrences.filter(isOccurrenceTaken).length;
      const missedCount = occurrences.filter(isOccurrenceMissed).length;
      const pendingCount = occurrences.filter(isOccurrencePending).length;

      const scheduleLines = occurrences.map((o, idx) => {
        const timeStr = formatTime(o.actualMedicationTime);
        const medName = o.medicationName || "Medicine";
        let st = labels.pending || "Pending";
        if (isOccurrenceTaken(o)) {
          st = labels.taken || "Taken";
        } else if (isOccurrenceMissed(o)) {
          st = labels.missed || "Missed";
        }
        return `${idx + 1}. **${medName}** at ${timeStr} - ${st}`;
      });

      replyText =
        `**${headerTitle}**\n` +
        `- **${labels.total}:** ${occurrences.length}\n` +
        `- **${labels.taken}:** ${takenCount}\n` +
        `- **${labels.pending}:** ${pendingCount}\n` +
        `- **${labels.missed}:** ${missedCount}\n\n` +
        scheduleLines.join("\n");
    }

    if (onChunk) {
      await streamTextLikeChat(replyText, onChunk, abortSignal, 10);
    }

    const { userMessage, aiMessage } = await this._saveExchange({
      userId,
      sessionId,
      question,
      content: replyText,
      metadata: {
        mode: "GENERAL_HEALTH",
        task: "REMINDER_STATUS",
        facet,
        temporal: temporal || "today",
        emergency: false,
        documentId: [],
        reminders: savedReminders,
      },
    });

    return {
      ai: aiMessage,
      user: userMessage,
      reply: replyText,
      mode: "GENERAL_HEALTH",
      emergency: false,
      citations: [],
    };
  }

  /**
   * Fast-Path Handler 6: REFILL_STOCK
   */
  async handleRefillStock(ctx, classification) {
    const { userId, sessionId, question, detectedLanguage, onChunk, abortSignal } = ctx;
    const labels = pickLang(REFILL_REPLY_I18N, detectedLanguage);
    const facet = classification?.entities?.refillFacet || { type: "all" };
    const facetType = facet.type || "all";

    let refillRecords = [];
    try {
      refillRecords = (await refillRepository.findAllByUserId(userId)) || [];
    } catch {
      refillRecords = [];
    }

    const allMeds = await medicationRepository.findAll(userId);

    let replyText = "";
    let processedMeds = allMeds || [];

    if (facetType === "count") {
      const count = (refillRecords || []).length;
      const countLabels = pickLang(COUNT_REPLY_I18N, detectedLanguage);
      replyText = countLabels.refills
        ? countLabels.refills(count)
        : labels.totalRefills
          ? `${labels.totalRefills}: ${count}`
          : `You have ${count} recorded medication refill(s).`;
    } else if (facetType === "latest") {
      if (refillRecords && refillRecords.length > 0) {
        const latest = refillRecords[0];
        const name = latest.medicationName || "Medicine";
        const qty = latest.refillQuantity ?? 0;
        const unit = latest.unit ? ` ${latest.unit}` : "";
        const dateStr = latest.createdAt ? toIsoDateOnly(latest.createdAt) : "Recently";
        const newBalance =
          latest.afterRefillRemainingQuantity != null
            ? latest.afterRefillRemainingQuantity
            : (latest.beforeRefillRemainingQuantity ?? 0) + qty;

        replyText =
          `**${labels.titleLatestRefill}**\n` +
          `- **${name}**: +${qty}${unit} (${labels.refillDate}: ${dateStr}, ${labels.remainingStock}: ${newBalance}${unit})`;
      } else {
        replyText = labels.noRefillsRecorded;
      }
    } else if (facetType === "history") {
      if (refillRecords && refillRecords.length > 0) {
        const medMap = new Map();
        (allMeds || []).forEach((m) => {
          if (m.id) medMap.set(m.id, m);
        });

        const historyLines = refillRecords.map((r, idx) => {
          const med = medMap.get(r.medicationId);
          const name = r.medicationName || med?.medicationName || "Medicine";
          const qty = r.refillQuantity ?? 0;
          const unitStr = r.unit || med?.unit ? ` ${r.unit || med?.unit}` : "";
          const dateStr = r.createdAt ? toIsoDateOnly(r.createdAt) : "Unknown";

          let remainingAfter = r.afterRefillRemainingQuantity;
          if (remainingAfter == null && r.beforeRefillRemainingQuantity != null) {
            remainingAfter = r.beforeRefillRemainingQuantity + qty;
          }
          if (remainingAfter == null && med) {
            remainingAfter = med.remainingQuantity ?? med.totalQuantity;
          }

          const bal =
            remainingAfter != null ? `, ${labels.remainingStock}: ${remainingAfter}${unitStr}` : "";
          return `${idx + 1}. **${name}**: +${qty}${unitStr} (${labels.refillDate}: ${dateStr}${bal})`;
        });
        replyText = `**${labels.titleHistory}**\n\n` + historyLines.join("\n");
      } else {
        replyText = labels.noRefillsRecorded;
      }
    } else if (facetType === "need_refill") {
      if (!allMeds || allMeds.length === 0) {
        replyText = labels.noMeds;
      } else {
        processedMeds = await Promise.all(
          allMeds.map(async (m) => {
            let remaining = m.remainingQuantity;
            if (remaining === undefined || remaining === null) {
              try {
                remaining = await calculateRemainingQuantity(m);
              } catch {
                remaining = m.totalQuantity ?? 0;
              }
            }
            return { ...m, remainingQuantity: remaining };
          }),
        );

        const lowStockMeds = processedMeds.filter((m) => {
          const threshold =
            m.refillWarningThreshold !== null && m.refillWarningThreshold !== undefined
              ? Number(m.refillWarningThreshold)
              : 5;
          const rem = Number(m.remainingQuantity ?? 0);
          return rem <= threshold;
        });

        if (lowStockMeds.length > 0) {
          const warningLines = lowStockMeds.map((m) => {
            const name = m.medicationName || "Medicine";
            const rem = m.remainingQuantity ?? 0;
            const unit = m.unit ? ` ${m.unit}` : "";
            return `- ⚠️ **${name}**: ${rem}${unit} remaining`;
          });
          replyText = `**${labels.titleNeedRefill}**\n\n` + warningLines.join("\n");
        } else {
          replyText = labels.noRefillNeeded;
        }
      }
    } else {
      // Default / "all": overview of stock & refills
      if (!allMeds || allMeds.length === 0) {
        replyText = labels.noMeds;
      } else {
        processedMeds = await Promise.all(
          allMeds.map(async (m) => {
            let remaining = m.remainingQuantity;
            if (remaining === undefined || remaining === null) {
              try {
                remaining = await calculateRemainingQuantity(m);
              } catch {
                remaining = m.totalQuantity ?? 0;
              }
            }
            return { ...m, remainingQuantity: remaining };
          }),
        );

        const lowStockMeds = processedMeds.filter((m) => {
          const threshold =
            m.refillWarningThreshold !== null && m.refillWarningThreshold !== undefined
              ? Number(m.refillWarningThreshold)
              : 5;
          const rem = Number(m.remainingQuantity ?? 0);
          return rem <= threshold;
        });

        const medLines = processedMeds.map((m, idx) => {
          const name = m.medicationName || "Medicine";
          const remaining = m.remainingQuantity ?? m.totalQuantity ?? 0;
          const medRefills = (refillRecords || []).filter((r) => r.medicationId === m.id);
          const refills =
            m.refillCount !== null && m.refillCount !== undefined
              ? m.refillCount
              : medRefills.length;
          const unit = m.unit ? ` ${m.unit}` : "";

          let refillDetail = "";
          if (medRefills.length > 0) {
            const latestR = medRefills[0];
            const lastQty = latestR.refillQuantity ?? 0;
            const lastDate = latestR.createdAt ? toIsoDateOnly(latestR.createdAt) : "";
            refillDetail = ` (Latest: +${lastQty}${unit} on ${lastDate})`;
          }

          return `${idx + 1}. **${name}**: ${labels.remainingStock} = ${remaining}${unit}, ${labels.refillsLeft} = ${refills}${refillDetail}`;
        });

        if (lowStockMeds.length > 0) {
          const warningLines = lowStockMeds.map(
            (m) => `- ⚠️ **${m.medicationName}**: ${m.remainingQuantity ?? 0} remaining`,
          );
          replyText =
            `**${labels.title}**\n\n` +
            `**${labels.lowStock}**\n` +
            warningLines.join("\n") +
            `\n\n` +
            medLines.join("\n");
        } else {
          replyText =
            `**${labels.title}**\n` + `${labels.sufficientStock}\n\n` + medLines.join("\n");
        }
      }
    }

    if (onChunk) {
      await streamTextLikeChat(replyText, onChunk, abortSignal, 10);
    }

    const { userMessage, aiMessage } = await this._saveExchange({
      userId,
      sessionId,
      question,
      content: replyText,
      metadata: {
        mode: "GENERAL_HEALTH",
        task: "REFILL_STATUS",
        emergency: false,
        documentId: [],
        medications: processedMeds,
      },
    });

    return {
      ai: aiMessage,
      user: userMessage,
      reply: replyText,
      mode: "GENERAL_HEALTH",
      emergency: false,
      citations: [],
    };
  }

  /**
   * Fast-Path Handler 7: NOTIFICATION_STATUS
   */
  async handleNotificationStatus(ctx, classification) {
    const { userId, sessionId, question, detectedLanguage, onChunk, abortSignal } = ctx;
    const labels = pickLang(NOTIFICATION_REPLY_I18N, detectedLanguage);
    const countLabels = pickLang(COUNT_REPLY_I18N, detectedLanguage);
    const { isUnreadOnly, notificationFacet } = classification?.entities || {};
    const facetType = notificationFacet?.type || (isUnreadOnly ? "unread" : "all");

    const notifResult = notificationRepository.list
      ? await notificationRepository.list({ userId, sort: { orderBy: "desc" } })
      : [];
    const notifs = Array.isArray(notifResult) ? notifResult : notifResult?.items || [];

    // Ensure sorted desc by createdAt
    notifs.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    let replyText = "";
    if (!notifs || notifs.length === 0) {
      replyText = labels.noNotifs;
    } else {
      const unreadCount = notifs.filter((n) => !n.isRead).length;
      const readCount = notifs.filter((n) => n.isRead).length;

      if (facetType === "count") {
        replyText = countLabels.notifications(notifs.length, unreadCount);
      } else if (facetType === "last") {
        const lastNotif = notifs[0];
        const status = lastNotif.isRead ? labels.read : labels.unread;
        const title = lastNotif.title || "Notification";
        const message = lastNotif.body || lastNotif.message || "";
        replyText = `**${labels.titleLast}**\n• [${status}] **${title}**: ${message}`;
      } else if (facetType === "latest" || facetType === "recent") {
        const topNotifs = notifs.slice(0, 3).map((n) => {
          const status = n.isRead ? labels.read : labels.unread;
          const title = n.title || "Notification";
          const message = n.body || n.message || "";
          return `• [${status}] **${title}**: ${message}`;
        });
        replyText = `**${labels.titleLatest}**\n${topNotifs.join("\n")}`;
      } else if (facetType === "today") {
        const todayDateStr = new Date().toISOString().slice(0, 10);
        const todayNotifs = notifs.filter((n) => {
          const d = n.createdAt ? new Date(n.createdAt).toISOString().slice(0, 10) : "";
          return d === todayDateStr;
        });
        if (todayNotifs.length === 0) {
          replyText = labels.noTodayNotifs;
        } else {
          const lines = todayNotifs.slice(0, 5).map((n) => {
            const status = n.isRead ? labels.read : labels.unread;
            const title = n.title || "Notification";
            const message = n.body || n.message || "";
            return `• [${status}] **${title}**: ${message}`;
          });
          replyText = `**${labels.titleToday}**\n${lines.join("\n")}`;
        }
      } else if (facetType === "important") {
        const importantNotifs = notifs.filter((n) => {
          const isUrgent = n.priority === "urgent" || n.priority === "high" || n.isUrgent;
          return isUrgent || !n.isRead;
        });
        if (importantNotifs.length === 0) {
          replyText = labels.noImportantNotifs;
        } else {
          const lines = importantNotifs.slice(0, 5).map((n) => {
            const status = n.isRead ? labels.read : labels.unread;
            const title = n.title || "Notification";
            const message = n.body || n.message || "";
            return `• [${status}] **${title}**: ${message}`;
          });
          replyText = `**${labels.titleImportant}**\n${lines.join("\n")}`;
        }
      } else if (facetType === "unread" || isUnreadOnly) {
        const unreadNotifs = notifs.filter((n) => !n.isRead);
        if (unreadNotifs.length === 0) {
          replyText = labels.noUnread;
        } else {
          const lines = unreadNotifs.slice(0, 5).map((n) => {
            const title = n.title || "Notification";
            const message = n.body || n.message || "";
            return `• [${labels.unread}] **${title}**: ${message}`;
          });
          replyText =
            `**${labels.title}**\n` +
            `- **${labels.total}:** ${notifs.length}\n` +
            `- **${labels.unread}:** ${unreadCount}\n` +
            `- **${labels.read}:** ${readCount}\n\n` +
            lines.join("\n");
        }
      } else {
        // Full list / overview
        const topNotifs = notifs.slice(0, 5).map((n) => {
          const status = n.isRead ? labels.read : labels.unread;
          const title = n.title || "Notification";
          const message = n.body || n.message || "";
          return `• [${status}] **${title}**: ${message}`;
        });

        replyText =
          `**${labels.title}**\n` +
          `- **${labels.total}:** ${notifs.length}\n` +
          `- **${labels.unread}:** ${unreadCount}\n` +
          `- **${labels.read}:** ${readCount}\n\n` +
          topNotifs.join("\n");
      }
    }

    if (onChunk) {
      await streamTextLikeChat(replyText, onChunk, abortSignal, 10);
    }

    const { userMessage, aiMessage } = await this._saveExchange({
      userId,
      sessionId,
      question,
      content: replyText,
      metadata: {
        mode: "GENERAL_HEALTH",
        task: "NOTIFICATION_STATUS",
        emergency: false,
        documentId: [],
        notifications: notifs,
      },
    });

    return {
      ai: aiMessage,
      user: userMessage,
      reply: replyText,
      mode: "GENERAL_HEALTH",
      emergency: false,
      citations: [],
    };
  }

  /**
   * Main Dispatcher for Fast-Path Execution.
   */
  async execute(ctx, classification) {
    switch (classification.fastPathType) {
      case "SPECIFIC_PROFILE_FIELD":
        return this.handleSpecificProfileField(ctx, classification);
      case "COUNT":
        return this.handleCount(ctx, classification);
      case "LIST_MEDICATION":
        return this.handleMedicationList(ctx);
      case "MEDICATION_FACET":
        return this.handleMedicationFacet(ctx, classification);
      case "LIST_DOCUMENT":
        return this.handleDocumentList(ctx, classification);
      case "REMINDER_OCCURRENCE":
        return this.handleReminderOccurrence(ctx, classification);
      case "REFILL_STOCK":
        return this.handleRefillStock(ctx, classification);
      case "NOTIFICATION_STATUS":
        return this.handleNotificationStatus(ctx, classification);
      default:
        return null;
    }
  }
}

const chatFastPath = new ChatFastPathService();

module.exports = {
  chatFastPath,
  ChatFastPathService,
};
