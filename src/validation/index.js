const messageConstant = require("../constant/MessageConstant");
const { success } = require("../helpers/genralResponse");
const { patch } = require("../routes");

async function zodValidateData(schema, data) {
  try {
    if (!schema || !data) {
      return { success: false, error: messageConstant.INTERNAL_SERVER_ERROR };
    }
    const result = await schema.safeParseAsync(data);
    if (!result.success) {
      return {
        success: false,
        error: result.error.issues,
      };
    }
    return {
      success: true,
      data: result.data,
    };
  } catch (errors) {
    const issues = errors?.issues || [];
    const error = issues?.[0] || {};
    return {
      success: false,
      error: issues,
    };
  }
}
module.exports = zodValidateData;
