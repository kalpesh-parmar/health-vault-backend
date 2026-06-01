const frequencyType = Object.freeze({
  ONCE_DAILY: "ONCE_DAILY",
  TWICE_DAILY: "TWICE_DAILY",
  THREE_TIMES_DAILY: "THREE_TIMES_DAILY",
  AS_NEEDED: "AS_NEEDED",
});

const frequencyTypeValues = Object.values(frequencyType);

module.exports = {
  frequencyTypeValues,
  frequencyType,
};
