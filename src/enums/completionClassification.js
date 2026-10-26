const completionClassification = Object.freeze({
  ON_TIME: "ON_TIME",
  LATE: "LATE",
  SKIPPED: "SKIPPED",
  EARLY: "EARLY",
});

const completionClassificationValues = Object.values(completionClassification);

module.exports = {
  completionClassification,
  completionClassificationValues,
};
