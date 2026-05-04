const extractValidDate = (text) => {
    const datePatterns = [
  // 02 Dec 2024
  /(\d{1,2})\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*,?\s*(\d{2,4})/i,

  // Dec 02 2024
  /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*(\d{1,2}),?\s*(\d{2,4})/i,

  // 02/12/2024 or 02-12-2024
  /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/,

  // 2024-12-02
  /(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/,

  // 02 Dec (missing year)
  /(\d{1,2})\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i
];
   const cleaned = datePatterns(text);
  console.log("CLEANED:", cleaned);

  for (const pattern of datePatterns) {
    const match = cleaned.match(pattern);

    if (match) {
      let day, month, year;

      // Pattern handling
      if (pattern === datePatterns[0]) {
        [, day, month, year] = match;
      } else if (pattern === datePatterns[1]) {
        [, month, day, year] = match;
      } else if (pattern === datePatterns[2]) {
        [, day, month, year] = match;
      } else if (pattern === datePatterns[3]) {
        [, year, month, day] = match;
      } else if (pattern === datePatterns[4]) {
        [, day, month] = match;
        year = new Date().getFullYear(); // fallback
      }
    // Fix year
      if (year && year.length === 2) {
        year = "20" + year;
      }

      const formatted = `${day} ${month} ${year}`;
      const date = new Date(formatted);

      if (!isNaN(date.getTime())) {
        return date;
      }
    }
  }

  return null;
};
module.exports={extractValidDate};