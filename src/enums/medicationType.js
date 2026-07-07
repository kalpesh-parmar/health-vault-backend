const medictationType = Object.freeze({
  TABLET: "TABLET",
  CAPSULE: "CAPSULE",
  SYRUP: "SYRUP",
  DROP: "DROP",
  INJECTION: "INJECTION",
  DROPS: "DROPS",
  SPRAY: "SPRAY",
  INHALER: "INHALER",
});

const medicationTypeValues = Object.values(medictationType);

module.exports = {
  medicationTypeValues,
  medictationType,
};
