const { STAGE_WEIGHTS } = require("../constants/documentProgress.constants");

function getStageProgress(stage, stageProgress = 0) {
  const range = STAGE_WEIGHTS[stage];

  if (!range) {
    return 0;
  }

  const [start, end] = range;
  const normalizedProgress = Math.max(0, Math.min(100, stageProgress));

  return Math.round(start + ((end - start) * normalizedProgress) / 100);
}

module.exports = {
  getStageProgress,
};
