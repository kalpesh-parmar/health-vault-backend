const medicationUnit = Object.freeze({
  PILLS: "PILLS",
  ML: "ML",
  DROPS: "DROPS",
  UNITS: "UNITS",
});

const mediactionUnitValues = Object.values(medicationUnit);

module.exports = {
  medicationUnit,
  mediactionUnitValues,
};
