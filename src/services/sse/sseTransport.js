/**
 * Express helper that turns an HTTP response into an SSE sink.
 *
 * Production concerns handled here:
 *  • Sets headers required by browsers and intermediaries (Content-Type,
 *    Cache-Control, Connection, X-Accel-Buffering for nginx).
 *  • Disables Express response buffering so events flush immediately.
 *  • Sends a heartbeat every 15 s to keep proxies and load balancers from
 *    closing idle connections.
 *  • Wires up `req.on("close")` so subscribers are evicted from the bus
 *    when the client navigates away.
 */

const HEARTBEAT_INTERVAL_MS = 15 * 1000;

function writeEvent(res, event, eventName = "progress") {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function attachSseStream(req, res, { onClose } = {}) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  // Send an initial comment so EventSource resolves immediately.
  res.write(": connected\n\n");

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, HEARTBEAT_INTERVAL_MS);

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    try {
      res.end();
    } catch {
      // Already closed.
    }
    onClose?.();
  };

  req.on("close", cleanup);
  res.on("error", cleanup);

  return {
    close: cleanup,
    isClosed: () => closed,
    write: (event, eventName) => {
      if (closed) return;
      writeEvent(res, event, eventName);
    },
  };
}

module.exports = { attachSseStream };
