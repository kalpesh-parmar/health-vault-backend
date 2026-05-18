const cleanOCRText = (data) => {
  return data
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7E\n]/g, "")
    .replace(/```json|```/g, "")
    .trim();
};
module.exports = { cleanOCRText };
