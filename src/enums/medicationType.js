const medictationType = Object.freeze({
  TABLET: "TABLET",
  CAPSULE: "CAPSULE",
  SYRUP: "SYRUP",
  DROP: "DROP",
  INJECTION: "INJECTION",
});

const medicationTypeValues = Object.values(medictationType);

module.exports = {
  medicationTypeValues,
  medictationType,
};
