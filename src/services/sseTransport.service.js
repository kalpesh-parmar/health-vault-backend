const sseTransport = {
  initialize(res) {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    // Express/Node flushes headers immediately when available.
    res.flushHeaders?.();

    return res;
  },

  write(res, event) {
    if (res.writableEnded || res.destroyed) return false;

    const id = event.eventId != null ? String(event.eventId) : undefined;
    const eventName = event.type || "progress";

    if (id !== undefined) {
      res.write(`id: ${id}\n`);
    }

    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);

    return true;
  },

  heartbeat(res) {
    if (res.writableEnded || res.destroyed) return false;

    // SSE comment frame; browser EventSource ignores it but it keeps
    // proxies/load-balancers from considering the connection idle.
    res.write(`: heartbeat ${Date.now()}\n\n`);
    return true;
  },

  close(res) {
    if (!res.writableEnded) {
      res.end();
    }
  },
};

module.exports = sseTransport;
