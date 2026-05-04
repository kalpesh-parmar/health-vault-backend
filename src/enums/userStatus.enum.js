const USER_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  BLOCKED: "BLOCKED",
  INACTIVE: "INACTIVE",
});

const userStatusValues = Object.values(USER_STATUS);

module.exports = {
  USER_STATUS,
  userStatusValues,
};
