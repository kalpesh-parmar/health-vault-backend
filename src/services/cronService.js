const cron = require("node-cron");
const { cronTypeValues } = require("../enums/cronType");
const { env } = require("../configs/env");

class cronService {
  constructor() {
    this.handlers = new Map();
    this.jobs = new Map();
  }
  // register business logic
  register(key, handler) {
    this.handlers.set(key, handler);
  }

  // start cron job
  async start(key, expression, source = "MANUAL") {
    if (this.jobs.has(key)) {
      await this.stop(key); // restart if already running
    }

    const handlers = this.handlers;

    const job = cron.schedule(
      expression,
      async () => {
        console.log(`Running cron: ${key}`);

        const handler = handlers.get(key);

        if (handler) {
          try {
            await handler();
          } catch (err) {
            console.error(` Error in cron ${key}:`, err);
          }
        } else {
          console.warn(` No handler found for cron: ${key}`);
        }
      },
      {
        timezone: process.env.TZ || "UTC",
      },
    );
    this.jobs.set(key, {
      job,
      expression,
      source,
      status: "RUNNING",
    });

    console.log(` Cron started: ${key} -> ${expression}`);
    return {
      key,
      expression,
      source,
      status: "RUNNING",
    };
  }

  // stop cron job
  async stop(key) {
    const jobData = this.jobs.get(key);

    if (jobData) {
      jobData.job.stop();
      this.jobs.delete(key);

      console.log("Cron stopped:", Array.from(this.jobs.keys()));
      return key;
    }
    return key;
  }

  // start multiple jobs
  async loadStartAll() {
    const cronDisable = env.cronDisable;
    if (cronDisable === "false") {
      console.log("cron is Disable...");
      return;
    }

    for (const cron of cronTypeValues) {
      if (!cron.key || !cron.expression) continue;
      await this.start(cron.key, cron.expression, "SCHEDULED");
    }
  }
  // debug
  async list() {
    const result = [];
    for (const [key, value] of this.jobs.entries()) {
      result.push({
        key,
        expression: value.expression,
        source: value.source,
        status: value.status,
      });
    }
    // console.log("Cron list: ",result);
    return result;
  }
}

module.exports = new cronService();
