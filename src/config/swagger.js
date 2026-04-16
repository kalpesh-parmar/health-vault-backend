const swaggerJsdoc = require("swagger-jsdoc");

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Node.js API",
      version: "1.0.0",
      description: "API documentation using Swagger",
    },
    servers: [
      {
        url: "http://localhost:3000/api",
        description: "Local server",
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
    },
    //applies authentication to ALL endpoints by default
    security: [
      {
        bearerAuth: [],
      },
    ],
  },
  apis: ["./src/api-docs/*.yaml"], // swagger routes file
};

const swaggerSpec = swaggerJsdoc(options);
// console.log(swaggerSpec);
module.exports = swaggerSpec;
