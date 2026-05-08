const bestTakenType = Object.freeze({
  MORNING: "MORNING",
  NOON: "NOON",
  EVENING: "ENEVING",
  NIGHT: "NIGHT",
});

const bestTakenValues = Object.values(bestTakenType);

module.exports = {
  bestTakenType,
  bestTakenValues,
};
