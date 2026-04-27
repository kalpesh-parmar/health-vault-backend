// utils/generatePatientCode.js
const generateNumericPatientCode = () => {
  const min = 10000;
  const max = 999999;
  const randomNumber =
    Math.floor(Math.random() * (max - min + 1)) + min;

  return randomNumber.toString();
};

module.exports = { generateNumericPatientCode };