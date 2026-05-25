require("dotenv").config({ quiet: true });

const http = require("http");

const cors = require("cors");
const express = require("express");
require("./jobs/medicationCron");

const { pool } = require("./configs/db");
const { env } = require("./configs/env");
const { apiRateLimiter, helmetMiddleware } = require("./configs/security");
const swaggerDocs = require("./configs/swagger");
const { errorConstants } = require("./constants/errorConstants");
const { NotFoundException } = require("./exceptions/appError");
const errorHandler = require("./middlewares/errorHandler");
const routes = require("./routes");

const app = express();
const server = http.createServer(app);
const port = env.port;

app.use(helmetMiddleware);
app.use(cors());
app.use(apiRateLimiter);
app.use(express.json());

app.use(routes);
swaggerDocs(app, port);

app.use((_req, _res, next) => next(new NotFoundException(errorConstants.ROUTE_NOT_FOUND)));
app.use(errorHandler);

if (require.main === module) {
  server.listen(port, () => {
    console.log(`Server started on port ${port}`);
  });

  const shutdown = (signal) => {
    console.log(`${signal} received. Closing server.`);
    server.close(() => {
      pool
        .end()
        .then(() => process.exit(0))
        .catch((error) => {
          console.error("Failed to close database pool", error);
          process.exit(1);
        });
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

module.exports = app;
