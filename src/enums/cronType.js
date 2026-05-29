const cronType = {
  SEND_REMINDERS: "SEND_REMINDERS",
  // GENERATE_OCCURRENCES: "0 0 * * *",
};
const cronTypeValues = [
  {
    key: cronType.SEND_REMINDERS,
    expression: "* * * * *",
  },
];
module.exports = { cronType, cronTypeValues };
