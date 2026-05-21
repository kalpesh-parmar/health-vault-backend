const swaggerUi = require("swagger-ui-express");
const swaggerJsDocs = require("swagger-jsdoc");

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Health Vault API",
      version: "1.0.0",
      description: "Production API documentation for Health Vault",
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
    },
    security: [
      {
        bearerAuth: [],
      },
    ],
  },
  apis: ["./src/api-docs/*.yaml"],
};

const swaggerSpec = swaggerJsDocs(options);

function swaggerDocs(app, port) {
  app.use("/swagger-ui", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  console.log(`http://localhost:${port}/swagger-ui`);
}

module.exports = swaggerDocs;
