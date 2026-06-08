const { medictationType } = require("../enums/medicationType");

function getUnitByMedicationType(type) {
  switch (type) {
    case medictationType.TABLET:
      return "PILLS";

    case medictationType.CAPSULE:
      return "PILLS";

    case medictationType.SYRUP:
      return "ML";

    case medictationType.DROP:
      return "ML";

    case medictationType.INJECTION:
      return "UNITS";

    default:
      return "PILLS";
  }
}

function calculateMedicationValues(data, baseDate = null) {
  const timesPerDay = data.medicationTime?.length || 1;
  const dailyConsumption = data.dosePerIntake * timesPerDay;
  const quantity = data.remainingQuantity ?? data.totalQuantity;
  const totalDays = Math.ceil(quantity / dailyConsumption);
  const calculationDate = baseDate ? new Date(baseDate) : new Date(data.startDate);

  const endDate = new Date(calculationDate);
  endDate.setUTCDate(endDate.getUTCDate() + totalDays - 1);
  const endDateString = endDate.toISOString().split("T")[0];
  const unit = getUnitByMedicationType(data.medicationType);

  return {
    endDate: endDateString,
    dailyConsumption,
    unit,
  };
}

module.exports = {
  calculateMedicationValues,
  getUnitByMedicationType,
};
