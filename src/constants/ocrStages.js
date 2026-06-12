/**
 * Stage catalogue used by the OCR progress bus.
 *
 * Centralizing stage names + percentages keeps the FE timeline display
 * consistent regardless of which step emits the event.
 */

const STAGES = Object.freeze({
  OCR_QUEUED: { stage: "OCR_QUEUED", percentage: 0, label: "Queued" },
  OCR_STARTED: { stage: "OCR_STARTED", percentage: 5, label: "OCR started" },
  PDF_DOWNLOADING: {
    stage: "PDF_DOWNLOADING",
    percentage: 10,
    label: "Downloading PDF from cloud storage",
  },
  PDF_DOWNLOADED: { stage: "PDF_DOWNLOADED", percentage: 18, label: "PDF downloaded" },
  PAGE_EXTRACTION_STARTED: {
    stage: "PAGE_EXTRACTION_STARTED",
    percentage: 25,
    label: "Extracting page text",
  },
  PAGE_EXTRACTION_COMPLETED: {
    stage: "PAGE_EXTRACTION_COMPLETED",
    percentage: 55,
    label: "Page extraction complete",
  },
  AI_SUMMARY_STARTED: {
    stage: "AI_SUMMARY_STARTED",
    percentage: 65,
    label: "Generating AI summary",
  },
  MEDICATION_EXTRACTION: {
    stage: "MEDICATION_EXTRACTION",
    percentage: 75,
    label: "Extracting medications",
  },
  GRAPH_EXTRACTION: { stage: "GRAPH_EXTRACTION", percentage: 82, label: "Extracting graphs" },
  EMBEDDING_GENERATION: {
    stage: "EMBEDDING_GENERATION",
    percentage: 90,
    label: "Generating embeddings",
  },
  SAVING_DATA: { stage: "SAVING_DATA", percentage: 96, label: "Saving extracted data" },
  COMPLETED: { stage: "COMPLETED", percentage: 100, label: "Completed" },
  FAILED: { stage: "FAILED", percentage: 100, label: "Failed" },
});

const ORDERED_STAGES = [
  STAGES.OCR_STARTED,
  STAGES.PDF_DOWNLOADING,
  STAGES.PDF_DOWNLOADED,
  STAGES.PAGE_EXTRACTION_STARTED,
  STAGES.PAGE_EXTRACTION_COMPLETED,
  STAGES.AI_SUMMARY_STARTED,
  STAGES.MEDICATION_EXTRACTION,
  STAGES.GRAPH_EXTRACTION,
  STAGES.EMBEDDING_GENERATION,
  STAGES.SAVING_DATA,
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
