const debugLogger = {
  // eslint-disable-next-line no-console
  info: (msg, data) => console.log(`[DEBUG] ${msg}`, JSON.stringify(data, null, 2)),
  // eslint-disable-next-line no-console
  warn: (msg, data) => console.warn(`[DEBUG WARN] ${msg}`, JSON.stringify(data, null, 2)),
  // eslint-disable-next-line no-console
  error: (msg, data) => console.error(`[DEBUG ERROR] ${msg}`, JSON.stringify(data, null, 2)),
};

module.exports = {
  debugLogger,
};
