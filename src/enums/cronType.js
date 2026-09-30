const cronType = {
  SEND_REMINDERS: "SEND_REMINDERS",
  PROCESS_OVERDUE: "PROCESS_OVERDUE",
  // GENERATE_OCCURRENCES: "0 0 * * *",
};
const cronTypeValues = [
  {
    key: cronType.SEND_REMINDERS,
    expression: "* * * * *",
  },
  {
    key: cronType.PROCESS_OVERDUE,
    expression: "* * * * *",
  },
];
module.exports = { cronType, cronTypeValues };
