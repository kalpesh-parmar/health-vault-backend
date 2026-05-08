const foodType = Object.freeze({
  WITH_FOOD: "WITH_FOOD",
  BEFORE_FOOD: "BEFORE_FOOD",
  AFTER_FOOD: " AFTER_FOOD",
  EMPTY_STOMACH: "EMPTY_STOMACH",
});

const foodTypeValues = Object.values(foodType);

module.exports = {
  foodTypeValues,
  foodType,
};
