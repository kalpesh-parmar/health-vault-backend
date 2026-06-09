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

  const endDate = calculationDate;
  endDate.setUTCDate(endDate.getUTCDate() + totalDays - 1);
  // endDate.setUTCHours(23, 59, 59, 999);
  // const endDateString = endDate.split("T")[0];
  const now = new Date();
  endDate.setUTCHours(
    now.getUTCHours(),
    now.getUTCMinutes(),
    now.getUTCSeconds(),
    now.getUTCMilliseconds(),
  );
  const startDate = new Date(data.startDate);
  startDate.setUTCHours(
    now.getUTCHours(),
    now.getUTCMinutes(),
    now.getUTCSeconds(),
    now.getUTCMilliseconds(),
  );

  return {
    endDate,
    dailyConsumption,
    unit: getUnitByMedicationType(data.medicationType),
    startDate,
  };
}

module.exports = {
  calculateMedicationValues,
  getUnitByMedicationType,
};
