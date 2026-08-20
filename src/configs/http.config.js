const axios = require("axios");
const { attachLoggingInterceptors } = require("./axiosLogger");

/**
 * Creates and configures a service-specific Axios instance.
 *
 * @param {Object} options Configuration options for the HTTP client
 * @param {string} [options.baseURL] Base URL for the target API service
 * @param {number} [options.timeout=30000] Request timeout in milliseconds
 * @param {Object} [options.headers] Default headers to send with requests
 * @param {boolean} [options.proxy=false] Proxy configuration override
 * @returns {import("axios").AxiosInstance} Configured Axios instance
 */
function createHttpClient(options = {}) {
  const { baseURL, timeout = 30000, headers = {}, proxy = false, ...customOptions } = options;

  const instance = axios.create({
    baseURL,
    timeout,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    proxy,
    ...customOptions,
  });

  attachLoggingInterceptors(instance);

  return instance;
}

module.exports = {
  createHttpClient,
};
