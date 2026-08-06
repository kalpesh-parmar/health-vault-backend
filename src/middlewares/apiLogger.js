const { maskSensitiveData, truncatePayload } = require("../utils/apiLoggerUtil");

module.exports = (req, res, next) => {
  const enabled = process.env.ENABLE_API_LOGS === "true";
  if (!enabled) {
    next();
    return;
  }

  const startTime = process.hrtime();
  const timestamp = new Date().toISOString();

  // Construct full incoming URL
  const protocol = req.protocol;
  const host = req.get("host");
  const fullUrl = `${protocol}://${host}${req.originalUrl}`;

  // Log request metadata and body immediately (for JSON / non-multipart)
  const reqLog = {
    type: "INCOMING_REQUEST",
    timestamp,
    method: req.method,
    url: fullUrl,
    path: req.path,
    queryParams: req.query || {},
    pathParams: req.params || {},
    headers: maskSensitiveData(req.headers || {}),
  };

  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("multipart/form-data")) {
    reqLog.body = "[Multipart Form Data - Parsing in progress]";
  } else {
    reqLog.body = truncatePayload(maskSensitiveData(req.body));
  }

  console.log(`[API LOG] INCOMING REQUEST:\n${JSON.stringify(reqLog, null, 2)}`);

  // Intercept the final response send/json methods
  const originalSend = res.send;
  res.send = function (body) {
    res.responseBody = body;
    return originalSend.apply(this, arguments);
  };

  res.on("finish", () => {
    const diff = process.hrtime(startTime);
    const responseTimeMs = (diff[0] * 1e3 + diff[1] * 1e-6).toFixed(2);
    const endTimestamp = new Date().toISOString();

    let parsedResponseBody;
    try {
      parsedResponseBody = JSON.parse(res.responseBody);
    } catch {
      parsedResponseBody = res.responseBody;
    }

    // Capture request body at the end to get parsed multipart fields if any
    let finalReqBody;
    if (contentType.includes("multipart/form-data")) {
      finalReqBody = {
        description: "[Multipart Form Data]",
        fields: maskSensitiveData(req.body || {}),
        file: req.file
          ? {
              fieldname: req.file.fieldname,
              originalname: req.file.originalname,
              mimetype: req.file.mimetype,
              size: req.file.size,
            }
          : undefined,
        files: Array.isArray(req.files)
          ? req.files.map((file) => ({
              fieldname: file.fieldname,
              originalname: file.originalname,
              mimetype: file.mimetype,
              size: file.size,
            }))
          : undefined,
      };
    } else {
      finalReqBody = truncatePayload(maskSensitiveData(req.body));
    }

    const resLog = {
      type: "INCOMING_RESPONSE",
      timestamp: endTimestamp,
      method: req.method,
      url: fullUrl,
      statusCode: res.statusCode,
      responseTimeMs: `${responseTimeMs}ms`,
      requestBody: finalReqBody,
      responseBody: truncatePayload(maskSensitiveData(parsedResponseBody)),
    };

    if (res.statusCode >= 400) {
      console.error(
        `[API LOG] INCOMING RESPONSE ERROR (${res.statusCode}):\n${JSON.stringify(resLog, null, 2)}`,
      );
    } else {
      console.log(`[API LOG] INCOMING RESPONSE:\n${JSON.stringify(resLog, null, 2)}`);
    }
  });

  next();
};
