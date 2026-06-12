const bestTakenType = Object.freeze({
  MORNING: "MORNING",
  NOON: "NOON",
  NIGHT: "NIGHT",
  CUSTOM: "CUSTOM",
});

const bestTakenValues = Object.values(bestTakenType);

module.exports = {
  bestTakenType,
  bestTakenValues,
};
