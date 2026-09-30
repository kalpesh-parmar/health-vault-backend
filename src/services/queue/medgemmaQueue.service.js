const { env } = require("../../configs/env");

/**
 * Concurrency limiter and queue for MedGemma LLM / VLM calls.
 * Ensures the Ollama server is never overwhelmed by unbounded parallel inference.
 */
class MedGemmaQueue {
  constructor(concurrency = env.medgemmaConcurrency || 2) {
    this.concurrency = Math.max(1, concurrency);
    this.activeCount = 0;
    this.waitingQueue = [];
  }

  /**
   * Updates concurrency limit dynamically.
   * @param {number} limit
   */
  setConcurrency(limit) {
    this.concurrency = Math.max(1, Number(limit) || 1);
    this._drain();
  }

  /**
   * Gets current queue statistics.
   * @returns {{ concurrency: number, active: number, waiting: number }}
   */
  getStats() {
    return {
      concurrency: this.concurrency,
      active: this.activeCount,
      waiting: this.waitingQueue.length,
    };
  }

  /**
   * Enqueues an async task to run when a concurrency slot is free.
   * @param {Function} taskFn - Zero-argument async function
   * @returns {Promise<any>}
   */
  async run(taskFn) {
    if (typeof taskFn !== "function") {
      throw new TypeError("taskFn must be a function");
    }

    return new Promise((resolve, reject) => {
      this.waitingQueue.push({ taskFn, resolve, reject });
      this._drain();
    });
  }

  _drain() {
    while (this.activeCount < this.concurrency && this.waitingQueue.length > 0) {
      const item = this.waitingQueue.shift();
      if (!item) break;

      this.activeCount++;
      Promise.resolve()
        .then(() => item.taskFn())
        .then(
          (result) => {
            item.resolve(result);
          },
          (error) => {
            item.reject(error);
          },
        )
        .finally(() => {
          this.activeCount--;
          this._drain();
        });
    }
  }

  /**
   * Clears all waiting tasks, rejecting their promises.
   */
  clear() {
    const error = new Error("Queue cancelled");
    while (this.waitingQueue.length > 0) {
      const item = this.waitingQueue.shift();
      if (item) {
        item.reject(error);
      }
    }
  }
}

const medgemmaQueue = new MedGemmaQueue();

module.exports = {
  MedGemmaQueue,
  medgemmaQueue,
};
