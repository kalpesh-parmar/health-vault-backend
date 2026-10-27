class SlotContextService {
  /**
   * Resolves and updates conversation slots for the current turn.
   *
   * @param {object} existingSlots - Slots from previous turn
   * @param {object} classification - Intent classification result from chatClassifier
   * @param {object} languageMeta - Detected language metadata from aiClient
   * @param {string[]} [documentIds=[]] - Explicit document scope
   * @param {object} [options={}] - Additional options { scopeMode, selectedDocumentMetadata, actionType }
   * @returns {object} Updated conversation slots
   */
  resolveTurnSlots(
    existingSlots = {},
    classification = {},
    languageMeta = {},
    documentIds = [],
    options = {},
  ) {
    const slots = { ...(existingSlots || {}) };
    const { scopeMode, selectedDocumentMetadata, actionType } = options;

    const medicalIntent = classification.medicalIntent || classification || {};
    const intent = medicalIntent.intent || classification.fastPathType || "GENERAL";
    const newMetric = medicalIntent.canonicalMetric;
    const newYear = medicalIntent.year;
    const newGranularity = medicalIntent.granularity;

    const clientTimestamp = options.clientTimestamp ? Number(options.clientTimestamp) : null;
    const lastScopeUpdated = slots.scopeUpdatedAt ? Number(slots.scopeUpdatedAt) : 0;

    // 0. Handle explicit scope clearing
    if (actionType === "CLEAR_DOCUMENT_SCOPE" || intent === "CLEAR_DOCUMENT_SCOPE") {
      // Prevent stale scope-clear operations from overriding newer selections
      if (clientTimestamp && lastScopeUpdated && clientTimestamp < lastScopeUpdated) {
        // Stale clear - do not overwrite newer scope selection
        return slots;
      }
      slots.activeDocumentId = null;
      slots.activeDocumentIds = [];
      slots.selectedDocumentMetadata = null;
      slots.scopeMode = "AUTHORIZED_HISTORY";
      slots.comparisonContext = null;
      slots.activeMentions = [];
      slots.scopeUpdatedAt = clientTimestamp || Date.now();
    } else {
      // 1. Document ID & Scope Mode slot update
      if (documentIds && Array.isArray(documentIds) && documentIds.length > 0) {
        slots.activeDocumentId = documentIds[0];
        slots.activeDocumentIds = Array.from(new Set(documentIds));
        slots.scopeMode =
          scopeMode || (documentIds.length === 1 ? "SINGLE_DOCUMENT" : "MULTI_DOCUMENT");
        slots.scopeUpdatedAt = clientTimestamp || Date.now();
      } else if (scopeMode === "AUTHORIZED_HISTORY") {
        slots.activeDocumentId = null;
        slots.activeDocumentIds = [];
        slots.selectedDocumentMetadata = null;
        slots.scopeMode = "AUTHORIZED_HISTORY";
        slots.comparisonContext = null;
        slots.activeMentions = [];
        slots.scopeUpdatedAt = clientTimestamp || Date.now();
      }

      if (selectedDocumentMetadata) {
        slots.selectedDocumentMetadata = selectedDocumentMetadata;
      }
      if (options.mentions && Array.isArray(options.mentions)) {
        slots.activeMentions = options.mentions;
      }
    }

    // 2. Metric slot update
    if (newMetric) {
      slots.activeMetric = newMetric;
    }

    // 3. Date / Year slot update
    if (newYear) {
      if (
        intent === "DOCUMENT_COMPARISON" &&
        slots.dateRange?.year &&
        slots.dateRange.year !== newYear
      ) {
        slots.dateRange = {
          start: `${Math.min(slots.dateRange.year, newYear)}-01-01`,
          end: `${Math.max(slots.dateRange.year, newYear)}-12-31`,
          years: [slots.dateRange.year, newYear],
        };
      } else {
        slots.dateRange = {
          start: `${newYear}-01-01`,
          end: `${newYear}-12-31`,
          year: newYear,
        };
      }
    }

    // 4. Granularity slot update
    if (newGranularity) {
      slots.chartGranularity = newGranularity;
    }

    // 5. Language slot update
    if (languageMeta && languageMeta.language) {
      slots.lastLanguage = languageMeta.language;
    }

    slots.lastIntent = intent;
    slots.lastUpdated = new Date().toISOString();

    return slots;
  }

  /**
   * Resolves scope mode and conversation slots across the 4-level priority chain:
   * 1. Explicit current turn document IDs
   * 2. Natural language entity mentions (hospital, doctor, date, predecessor comparison)
   * 3. Retained session slots from previous turns
   * 4. Authorized lifetime history fallback
   */
  resolveScopeAndSlots({
    currentTurnDocumentId,
    currentTurnScopeMode,
    sessionMetadata = {},
    userQuestion = "",
    availableDocuments = [],
  } = {}) {
    const existingSlots = sessionMetadata.slots || sessionMetadata.conversationSlots || {};
    let resolvedScopeMode = "AUTHORIZED_HISTORY";
    let resolvedDocumentIds = [];
    let selectedDocumentMetadata = null;
    let disambiguation = null;

    // Priority 1: Current-turn explicit document selection
    const explicitIds = Array.isArray(currentTurnDocumentId)
      ? currentTurnDocumentId
      : currentTurnDocumentId
        ? [currentTurnDocumentId]
        : [];

    if (explicitIds.length > 0) {
      resolvedDocumentIds = Array.from(new Set(explicitIds));
      resolvedScopeMode =
        currentTurnScopeMode ||
        (resolvedDocumentIds.length > 1 ? "MULTI_DOCUMENT" : "SINGLE_DOCUMENT");
      const matched = availableDocuments.find((d) => d.id === resolvedDocumentIds[0]);
      if (matched) {
        selectedDocumentMetadata = {
          fileName: matched.fileName,
          hospitalName: matched.hospitalName,
          doctorName: matched.doctorName,
          reportDate: matched.reportDate,
        };
      }
    } else {
      // Priority 2: Natural-language document resolution
      const { documentResolverService } = require("./documentResolver.service");
      const nlResult = documentResolverService.resolveNaturalLanguageDocumentScope({
        question: userQuestion,
        availableDocuments,
        currentDocumentIds: existingSlots.activeDocumentIds || [],
      });

      if (nlResult.resolutionType === "REQUIRE_DOCUMENT_SELECTION") {
        disambiguation = {
          requireSelection: true,
          candidates: nlResult.candidateDocuments,
          message: nlResult.disambiguationMessage,
        };
      } else if (nlResult.resolvedDocumentIds && nlResult.resolvedDocumentIds.length > 0) {
        resolvedDocumentIds = nlResult.resolvedDocumentIds;
        resolvedScopeMode = nlResult.scopeMode;
        if (nlResult.matchedDocument) {
          selectedDocumentMetadata = {
            fileName: nlResult.matchedDocument.fileName,
            hospitalName: nlResult.matchedDocument.hospitalName,
            doctorName: nlResult.matchedDocument.doctorName,
            reportDate: nlResult.matchedDocument.reportDate,
          };
        }
      } else if (
        // Priority 3: Retained session state from previous turn
        existingSlots.activeDocumentIds &&
        Array.isArray(existingSlots.activeDocumentIds) &&
        existingSlots.activeDocumentIds.length > 0 &&
        !documentResolverService.isExplicitHistoricalQuery(userQuestion)
      ) {
        resolvedDocumentIds = existingSlots.activeDocumentIds;
        resolvedScopeMode =
          existingSlots.scopeMode ||
          (resolvedDocumentIds.length > 1 ? "MULTI_DOCUMENT" : "SINGLE_DOCUMENT");
        selectedDocumentMetadata = existingSlots.selectedDocumentMetadata || null;
      } else {
        // Priority 4: Authorized lifetime history
        resolvedScopeMode = "AUTHORIZED_HISTORY";
        resolvedDocumentIds = [];
      }
    }

    const updatedSlots = this.resolveTurnSlots(existingSlots, {}, {}, resolvedDocumentIds, {
      scopeMode: resolvedScopeMode,
      selectedDocumentMetadata,
    });

    return {
      scopeMode: resolvedScopeMode,
      resolvedDocumentIds,
      updatedSlots,
      disambiguation,
    };
  }
}

const slotContextService = new SlotContextService();

module.exports = {
  slotContextService,
  SlotContextService,
};
