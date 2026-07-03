const bestTakenType = Object.freeze({
  MORNING: "Morning",
  NOON: "Noon",
  NIGHT: "Night",
  CUSTOM: "Custom",
});

const bestTakenValues = Object.values(bestTakenType);

module.exports = {
  bestTakenType,
  bestTakenValues,
};
