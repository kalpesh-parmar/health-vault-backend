const foodType = Object.freeze({
  BEFORE_FOOD: "BEFORE_FOOD",
  AFTER_FOOD: "AFTER_FOOD",
});

const foodTypeValues = Object.values(foodType);

module.exports = {
  foodTypeValues,
  foodType,
};
