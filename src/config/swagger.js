const swaggerUi = require("swagger-ui-express");
const swaggerJsDocs = require("swagger-jsdoc");

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Node.js API",
      version: "1.0.0",
      description: "API documentation using Swagger",
    },
    // servers: [
    //   {
    //     url: "http://localhost:3003/api",
    //     description: "Local server",
    //   },
    // ],
    components: {
      // securitySchemes: {
      //   bearerAuth: {
      //     type: "http",
      //     scheme: "bearer",
      //     bearerFormat: "JWT",
      //   },
      // },
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

const swaggerSpec = swaggerJsDocs(options);

function swaggerDocs (app,port){
  app.use("/swagger-ui", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  console.log(`http://localhost:${port}/swagger-ui`);
}

module.exports = swaggerDocs;
