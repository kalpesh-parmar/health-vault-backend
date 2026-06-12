const cron = require("node-cron");

const medicationRepository = require("../repositories/medicationRepository");

//every minute
cron.schedule("0 0 * * *", async () => {
  console.log("Medication cron started");

  try {
    const medications = await medicationRepository.findAllActive();

    for (const item of medications) {
      if (item.remainingQuantity <= 0) {
        continue;
      }

      const updatedRemaining = item.remainingQuantity - item.dailyConsumption;

      await medicationRepository.updateById(item.id, {
        remainingQuantity: Math.max(updatedRemaining, 0),
      });

      console.log(`Updated medication ${item.id}`);
    }

    console.log("Medication cron completed");
  } catch (error) {
    console.error(error);
  }
});
