const sseEmitter = Object.freeze({
  heartbeatMs: 15000, // SSE heartbeat interval
  streamTtlMs: 30 * 60 * 1000, // Maximum lifetime of an active stream
  terminalRetainMs: 5 * 60 * 1000, // Terminal stream retention time
  documentBufferSize: 100, // Maximum documents stored in buffer
  batchBufferSize: 500, // Maximum batches stored in buffer
  maxChannels: 5000, // Maximum number of active SSE channels
});

module.exports = sseEmitter;
