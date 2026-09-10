require("dotenv").config({ quiet: true });
require("./configs/axiosLogger");
// Force nodemon restart to load latest ts changes
const http = require("http");
const cors = require("cors");
const express = require("express");

// Import background crons/jobs
require("./jobs/medicationCron");
const documentJobSweeper = require("./jobs/documentJobSweeper");

const { pool } = require("./configs/db");
const { env } = require("./configs/env");
const { apiRateLimiter, helmetMiddleware } = require("./configs/security");
const swaggerDocs = require("./configs/swagger");
const { errorConstants } = require("./constants/errorConstants");
const { NotFoundException } = require("./exceptions/appError");
const errorHandler = require("./middlewares/errorHandler");
const routes = require("./routes/index.route");
const cronService = require("./services/cron.service");
const cronRegisterHandler = require("./configs/cronConfig");
// const { ollamaClient } = require("./clients/ollamaClient");
const sseConnectionService = require("./services/sseConnection.service");
const ocrProgressBus = require("./services/sse/ocrProgressBus");
const documentProcessingJobRepository = require("./repositories/documentProcessingJobRepository");

const app = express();
const server = http.createServer(app);
const port = env.port;
app.set("trust proxy", 1);

app.use(helmetMiddleware);
app.use(cors());
app.use(apiRateLimiter);
app.use(express.json());
app.use(require("./middlewares/apiLogger"));

// Routes registration
app.use(routes);

// Swagger initialization
swaggerDocs(app, port);

// NotFound error handling
app.use((_req, _res, next) => next(new NotFoundException(errorConstants.ROUTE_NOT_FOUND)));
app.use(errorHandler);

if (require.main === module) {
  server.listen(port, async () => {
    console.log(`Server started on port ${port}`);
    // Initialize cron tasks
    cronRegisterHandler();
    cronService.loadStartAll();
    console.log("cron system initialized...");

    // Reconcile zombie/running jobs from prior ungraceful shutdowns
    try {
      const reconciled = await documentProcessingJobRepository.reconcileRunningJobsOnBoot();
      if (reconciled?.length) {
        console.log(`[boot-reconcile] reconciled ${reconciled.length} interrupted running jobs`);
      }
    } catch (err) {
      console.error("[boot-reconcile] failed to reconcile running jobs on boot", err);
    }
  });

  function shutdown(signal) {
    console.log(signal + " received, shutting down");

    // Stop accepting new SSE connections and release active streams
    sseConnectionService.destroy();
    ocrProgressBus.destroy();
    documentJobSweeper.stopSweeper();

    //Stop accepting new HTTP requests
    server.close(async () => {
      try {
        // Close database connections
        await pool.end();

        console.log("Graceful shutdown completed.");
        process.exit(0);
      } catch (error) {
        console.error("Failed during shutdown:", error);
        process.exit(1);
      }
    });

    // Force shutdown if cleanup takes too long
    setTimeout(() => {
      console.error("Graceful shutdown timed out.");
      process.exit(1);
    }, 10_000).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

module.exports = app;
