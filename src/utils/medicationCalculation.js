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
      return "DROPS";

    case medictationType.INJECTION:
      return "UNITS";

    default:
      return "PILLS";
  }
}

function calculateMedicationValues(data) {
  const timesPerDay = data.medicationTime.length;

  const dailyConsumption = data.dosePerIntake * timesPerDay;

  const totalDays = Math.ceil(data.totalPills / dailyConsumption);

  let endDate = null;

  if (!data.ongoing) {
    endDate = new Date(data.startDate);

    endDate.setDate(endDate.getDate() + totalDays);
  }

  const today = new Date();

  const startDate = new Date(data.startDate);

  const daysPassed = Math.max(Math.floor((today - startDate) / (1000 * 60 * 60 * 24)), 0);

  const consumed = daysPassed * dailyConsumption;

  const remainingQuantity = Math.max(data.totalPills - consumed, 0);

  const unit = getUnitByMedicationType(data.medicationType);

  return {
    endDate,
    remainingQuantity,
    dailyConsumption,
    unit,
  };
}

module.exports = {
  calculateMedicationValues,
};
