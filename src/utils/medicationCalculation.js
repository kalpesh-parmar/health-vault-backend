const { medictationType } = require("../enums/medicationType");
const { set } = require("date-fns");
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

  const now = new Date();

  const timeParts = {
    hours: now.getUTCHours(),
    minutes: now.getUTCMinutes(),
    seconds: now.getUTCSeconds(),
    milliseconds: now.getUTCMilliseconds(),
  };
  const endDate = calculationDate;
  endDate.setUTCDate(endDate.getUTCDate() + totalDays - 1);

  const updatedEndDate = set(endDate, timeParts);
  const startDate = set(new Date(data.startDate), timeParts);

  return {
    endDate: updatedEndDate,
    dailyConsumption,
    unit: getUnitByMedicationType(data.medicationType),
    startDate,
  };
}

module.exports = {
  calculateMedicationValues,
  getUnitByMedicationType,
};
