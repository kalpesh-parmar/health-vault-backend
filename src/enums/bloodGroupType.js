const bloodGroupType = Object.freeze({
  A_POSITIVE: "A+",
  A_NEGATIVE: "A-",
  B_POSITIVE: "B+",
  B_NEGATIVE: "B-",
  O_POSITIVE: "O+",
  O_NEGATIVE: "O-",
  AB_POSITIVE: "AB+",
  AB_NEGATIVE: "AB-",
});

const bloodGroupTypeValues = Object.values(bloodGroupType);

module.exports = {
  bloodGroupType,
  bloodGroupTypeValues,
};
