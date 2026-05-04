const nlp = require("compromise");
const nlpDates = require("compromise-dates");
nlp.extend(nlpDates);

const parseMedicalData = (text) => {
  let hospitalName = "";
  let doctorName = "";
  let reportDate = "";
  let remark = "";

  let parameters = {};

  const cleanedText = text.replace(/\r/g, "").replace(/[|]/g, " ").replace(/\s+/g, " ").trim();

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const doc = nlp(cleanedText);
  // lines.forEach((lines) => {
  //   const lower = line.toLowerCase();
  //hospitalName
  if (!hospitalName) {
    const hospitalLine = lines.find((line) =>
      /(hospital|lab|pathology|diagnostic|clinic|medical center)/i.test(line),
    );
    if (hospitalLine) hospitalName = hospitalLine;
  }
  //doctorName
  const people = doc.people().out("array");
  const doctor = people.find((name) => /dr|doctor/i.test(cleanedText.toLowerCase()));
  if (doctor) {
    doctorName = doctor;
  } else {
    const doctorLine = lines.find((line) => /(dr\.?|doctor|pathologist)/i.test(line));
    if (doctorLine) doctorName = doctorLine;
  }
  //dates
  const dates = doc.dates().out("array");

  if (dates.length > 0) {
    reportDate = dates[0];
  } else {
    const dateLine = lines.find((line) =>
      /(reported on|registered on|collected on|date)/i.test(line),
    );
    if (dateLine) {
      const cleanDate = dateLine.match(/(\d{1,2}\s\w{3,9}.*)/i);
      reportDate = cleanDate ? cleanDate[0] : dateLine;
    }
  }
  //remarks
  const remarksLine = lines.find((line) =>
    /(remarks|interpretation|impression|conclusion|note)/i.test(line),
  );
  if (remarksLine) {
    remark = remarksLine;
  }
  //parameters
  lines.forEach((line) => {
    const match = line.match(
      /^([A-Za-z\s()]+?)\s+([\d.]+)\s*(Low|High|Borderline)?\s*([\d.\-]+)?\s*([A-Za-z/%]+)?$/i,
    );

    if (match) {
      const parameterName = match[1].trim();

      parameters[parameterName] = {
        value: match[2] || "",
        status: match[3] || "",
        referenceRange: match[4] || "",
        unit: match[5] || "",
      };
    }
  });
  // });
  return {
    hospitalName,
    doctorName,
    reportDate,
    remark,
    parameters,
  };
};
module.exports = { parseMedicalData };
