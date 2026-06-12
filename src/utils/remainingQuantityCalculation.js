const medicationReminderOccurrenceRepository = require("../repositories/medicationReminderOccurrenceRepository");

async function calculateMedicationConsumption(medication) {
  const completedCount =
    await medicationReminderOccurrenceRepository.countCompletedOccurrencesByMedicationId(
      medication.id,
    );
  const consumedQuantity = completedCount * Number(medication.dosePerIntake || 1);
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
