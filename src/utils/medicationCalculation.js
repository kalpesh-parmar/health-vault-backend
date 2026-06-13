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
  let timesPerDay = 1;
  if (data.medicationTime && Array.isArray(data.medicationTime)) {
    timesPerDay = data.medicationTime.length || 1;
  } else if (data.medicationSchedule && typeof data.medicationSchedule === "object") {
    timesPerDay = Object.keys(data.medicationSchedule).length || 1;
  }

  const dailyConsumption = data.dosePerIntake * timesPerDay;
  const quantity = data.remainingQuantity ?? data.totalQuantity;
  const totalDays = Math.ceil(quantity / dailyConsumption) || 1;
  const calculationDate = baseDate ? new Date(baseDate) : new Date(data.startDate);

  const now = new Date();
  const timeParts = {
    hours: now.getUTCHours(),
    minutes: now.getUTCMinutes(),
    seconds: now.getUTCSeconds(),
    milliseconds: now.getUTCMilliseconds(),
  };

  const endDate = new Date(calculationDate);
  endDate.setUTCDate(endDate.getUTCDate() + totalDays - 1);

  const updatedEndDate = set(endDate, timeParts);
  const startDate = set(new Date(data.startDate), timeParts);

  // Backward compatible remaining quantity calculation for when occurrences aren't tracked
  const daysPassed = Math.max(Math.floor((now - startDate) / (1000 * 60 * 60 * 24)), 0);
  const consumed = daysPassed * dailyConsumption;
  const remainingQuantity = Math.max(data.totalQuantity - consumed, 0);

  return {
    endDate: updatedEndDate,
    remainingQuantity,
    dailyConsumption,
    unit: getUnitByMedicationType(data.medicationType),
    startDate,
  };
}

module.exports = {
  calculateMedicationValues,
  getUnitByMedicationType,
};
