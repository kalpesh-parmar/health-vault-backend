const medicationUnit = Object.freeze({
  PILLS: "PILLS",
  ML: "ML",
  DROPS: "DROPS",
  UNITS: "UNITS",
  TABLET: "TABLET",
  CAPSULE: "CAPSULE",
  TSP: "TSP",
  TBSP: "TBSP",
  IU: "IU",
  PUFF: "PUFF",
});

const mediactionUnitValues = Object.values(medicationUnit);

module.exports = {
  medicationUnit,
  mediactionUnitValues,
};
