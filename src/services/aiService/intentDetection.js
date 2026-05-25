const detectIntent = async (message) => {
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes("summary") || lowerMessage.includes("summarize")) {
    return "SUMMARY";
  }

  if (
    lowerMessage.includes("medicine") ||
    lowerMessage.includes("medication") ||
    lowerMessage.includes("tablet")
  ) {
    return "MEDICATION";
  }

  if (
    lowerMessage.includes("diagnosis") ||
    lowerMessage.includes("disease") ||
    lowerMessage.includes("condition")
  ) {
    return "DIAGNOSIS";
  }

  if (
    lowerMessage.includes("lab") ||
    lowerMessage.includes("blood report") ||
    lowerMessage.includes("test result")
  ) {
    return "LAB_REPORT";
  }

  return "GENERAL_CHAT";
};

module.exports = {
  detectIntent,
};
