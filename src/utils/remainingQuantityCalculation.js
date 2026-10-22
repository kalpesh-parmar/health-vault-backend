const medicationReminderOccurrenceRepository = require("../repositories/medicationReminderOccurrenceRepository");

async function calculateMedicationConsumption(medication) {
  const completedCount =
    await medicationReminderOccurrenceRepository.countCompletedOccurrencesByMedicationId(
      medication.id,
    );
  const dosePerIntake = Number(medication.dosePerIntake || 1);
  const consumedQuantity = completedCount * dosePerIntake;

  if (medication.remainingQuantity !== undefined && medication.remainingQuantity !== null) {
    return {
      completedCount,
      consumedQuantity,
      remainingQuantity: Math.max(0, Number(medication.remainingQuantity)),
    };
  }

  if (medication.totalQuantity === null || medication.totalQuantity === undefined) {
    return {
      completedCount,
      consumedQuantity,
      remainingQuantity: null,
    };
  }

  const remainingQuantity = Math.max(0, Number(medication.totalQuantity) - consumedQuantity);
  return {
    completedCount,
    consumedQuantity,
    remainingQuantity,
  };
}

async function calculateRemainingQuantity(medication) {
  const { remainingQuantity } = await calculateMedicationConsumption(medication);
  return remainingQuantity;
}

module.exports = {
  calculateMedicationConsumption,
  calculateRemainingQuantity,
};
