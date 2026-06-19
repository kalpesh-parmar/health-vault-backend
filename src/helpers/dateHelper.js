/**
 * Calculates exact completed years from date of birth.
 * Returns null if dateOfBirth is missing or invalid.
 * Uses UTC-safe logic to prevent timezone shifts.
 *
 * @param {Date|string} dateOfBirth
 * @returns {number|null} Age in completed years, or null
 */
function getAgeFromDateOfBirth(dateOfBirth) {
  if (!dateOfBirth) {
    return null;
  }

  const birthDate = new Date(dateOfBirth);
  if (isNaN(birthDate.getTime())) {
    return null;
  }

  const today = new Date();

  const birthYear = birthDate.getUTCFullYear();
  const birthMonth = birthDate.getUTCMonth();
  const birthDay = birthDate.getUTCDate();

  const currentYear = today.getUTCFullYear();
  const currentMonth = today.getUTCMonth();
  const currentDay = today.getUTCDate();

  let age = currentYear - birthYear;

  if (currentMonth < birthMonth || (currentMonth === birthMonth && currentDay < birthDay)) {
    age -= 1;
  }

  return age;
}

module.exports = {
  getAgeFromDateOfBirth,
};
