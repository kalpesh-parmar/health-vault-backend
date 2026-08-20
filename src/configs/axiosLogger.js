const axios = require("axios");
const { maskSensitiveData, truncatePayload } = require("../utils/apiLoggerUtil");

function attachLoggingInterceptors(instance = axios) {
  const enabled = process.env.ENABLE_API_LOGS === "true";
  if (!enabled) return instance;

  instance.interceptors.request.use(
    (config) => {
      config.metadata = { startTime: Date.now() };

      const fullUrl = config.baseURL ? `${config.baseURL}${config.url || ""}` : config.url;

      const reqLog = {
        type: "OUTGOING_REQUEST",
        timestamp: new Date().toISOString(),
        method: config.method ? config.method.toUpperCase() : "GET",
        url: fullUrl,
        queryParams: config.params || {},
        headers: maskSensitiveData(config.headers || {}),
      };

      if (config.data) {
        if (config.data.constructor && config.data.constructor.name === "FormData") {
          reqLog.body = "[FormData Outgoing Payload]";
        } else {
          reqLog.body = truncatePayload(maskSensitiveData(config.data));
        }
      }

      console.log(`[API LOG] OUTGOING REQUEST:\n${JSON.stringify(reqLog, null, 2)}`);
      return config;
    },
    (error) => {
      const errLog = {
        type: "OUTGOING_REQUEST_ERROR",
        timestamp: new Date().toISOString(),
        message: error.message,
      };
      console.error(`[API LOG] OUTGOING REQUEST ERROR:\n${JSON.stringify(errLog, null, 2)}`);
      return Promise.reject(error);
    },
  );

  instance.interceptors.response.use(
    (response) => {
      const config = response.config || {};
      const startTime = config.metadata ? config.metadata.startTime : Date.now();
      const duration = Date.now() - startTime;
      const fullUrl = config.baseURL ? `${config.baseURL}${config.url || ""}` : config.url;

      const resLog = {
        type: "OUTGOING_RESPONSE",
        timestamp: new Date().toISOString(),
        method: config.method ? config.method.toUpperCase() : "GET",
        url: fullUrl,
        statusCode: response.status,
        responseTimeMs: `${duration}ms`,
        responseBody: truncatePayload(maskSensitiveData(response.data)),
      };

      console.log(`[API LOG] OUTGOING RESPONSE:\n${JSON.stringify(resLog, null, 2)}`);
      return response;
    },
    (error) => {
      const config = error.config || {};
      const startTime = config.metadata ? config.metadata.startTime : Date.now();
      const duration = Date.now() - startTime;
      const fullUrl = config.baseURL ? `${config.baseURL}${config.url || ""}` : config.url;

      const errorLog = {
        type: "OUTGOING_RESPONSE_ERROR",
        timestamp: new Date().toISOString(),
        method: config.method ? config.method.toUpperCase() : "UNKNOWN",
        url: fullUrl,
        statusCode: error.response ? error.response.status : undefined,
        responseTimeMs: `${duration}ms`,
        message: error.message,
        responseBody: error.response
          ? truncatePayload(maskSensitiveData(error.response.data))
          : undefined,
      };

      console.error(`[API LOG] OUTGOING RESPONSE ERROR:\n${JSON.stringify(errorLog, null, 2)}`);
      return Promise.reject(error);
    },
  );

  return instance;
}

attachLoggingInterceptors(axios);

module.exports = {
  attachLoggingInterceptors,
};
