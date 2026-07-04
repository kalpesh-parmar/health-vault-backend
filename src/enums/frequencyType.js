const frequencyType = Object.freeze({
  ONCE_DAILY: "Once Daily",
  TWICE_DAILY: "Twice Daily",
  THREE_TIMES_DAILY: "Three Times Daily",
  AS_NEEDED: "As Needed",
});

const frequencyTypeValues = Object.values(frequencyType);

module.exports = {
  frequencyTypeValues,
  frequencyType,
};
