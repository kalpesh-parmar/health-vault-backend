/**
 * Stage catalogue used by the OCR progress bus.
 *
 * Centralizing stage names + percentages keeps the FE timeline display
 * consistent regardless of which step emits the event.
 */

const STAGES = Object.freeze({
  OCR_QUEUED: { stage: "OCR_QUEUED", percentage: 0, label: "Queued" },
  OCR_STARTED: { stage: "OCR_STARTED", percentage: 5, label: "Started" },

  // 1. Uploading File
  UPLOADING_FILE: { stage: "UPLOADING_FILE", percentage: 10, label: "Uploading File" },

  // 2. Medical Document Validation
  VALIDATING: { stage: "VALIDATING", percentage: 20, label: "Medical Document Validation" },

  // 3. Extracting Text
  EXTRACTING: { stage: "EXTRACTING", percentage: 40, label: "Extracting Text" },

  // 4. Analyzing Report
  ANALYZING: { stage: "ANALYZING", percentage: 60, label: "Analyzing Report" },

  // 5. Generating Summary
  SUMMARIZING: { stage: "SUMMARIZING", percentage: 80, label: "Generating Summary" },

  // 6. Ready / Completed
  COMPLETED: { stage: "COMPLETED", percentage: 100, label: "Ready" },
  FAILED: { stage: "FAILED", percentage: 100, label: "Failed" },
});

const ORDERED_STAGES = [
  STAGES.OCR_QUEUED,
  STAGES.OCR_STARTED,
  STAGES.UPLOADING_FILE,
  STAGES.VALIDATING,
  STAGES.EXTRACTING,
  STAGES.ANALYZING,
  STAGES.SUMMARIZING,
  STAGES.COMPLETED,
];

function buildStageEvent(stage, { currentStep, message, metadata } = {}) {
  const total = ORDERED_STAGES.length;
  const idx = ORDERED_STAGES.findIndex((s) => s.stage === stage.stage);
  const completed = idx + 1;
  return {
    stage: stage.stage,
    percentage: stage.percentage,
    currentStep: currentStep || stage.label,
    completedSteps: idx >= 0 ? completed : null,
    pendingSteps: idx >= 0 ? Math.max(0, total - completed) : null,
    message: message || null,
    metadata: metadata || {},
  };
}

module.exports = { ORDERED_STAGES, STAGES, buildStageEvent };
