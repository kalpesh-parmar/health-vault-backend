const { validateSchema } = require("../validations");

function validateRequest(schema = {}) {
  return async (req, _res, next) => {
    try {
      if (schema.params) {
        req.params = await validateSchema(schema.params, req.params);
      }

      if (schema.query) {
        req.query = await validateSchema(schema.query, req.query);
      }

      if (schema.body) {
        req.body = await validateSchema(schema.body, req.body || {});
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = { validateRequest };
