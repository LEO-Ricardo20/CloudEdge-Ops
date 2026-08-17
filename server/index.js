const http = require('node:http');
const path = require('node:path');
const { CloudEdgePlatform, DEFAULT_OFFLINE_AFTER_MS } = require('./domain/platform');
const { createHttpHandler } = require('./http');
const { JsonFileRepository } = require('./persistence/json-file-repository');

const port = Number(process.env.PORT || 4173);
const offlineAfterMs = positiveNumber(process.env.OFFLINE_AFTER_MS, DEFAULT_OFFLINE_AFTER_MS);
const offlineCheckIntervalMs = positiveNumber(
  process.env.OFFLINE_CHECK_INTERVAL_MS,
  Math.max(1_000, Math.min(Math.floor(offlineAfterMs / 2), 5_000)),
);
const stateFile = path.resolve(process.env.STATE_FILE || path.resolve(__dirname, '..', 'data', 'platform-state.json'));
const repository = new JsonFileRepository(stateFile);
const platform = new CloudEdgePlatform({ repository, offlineAfterMs });
const handler = createHttpHandler(platform, path.resolve(__dirname, '..', 'web'));
const server = http.createServer(handler);
const offlineTimer = setInterval(() => platform.evaluateOfflineDevices(), offlineCheckIntervalMs);
offlineTimer.unref();

server.listen(port, '127.0.0.1', () => {
  console.log(`CloudEdge AI dashboard: http://localhost:${port}`);
  console.log(`API health: http://localhost:${port}/api/health`);
  console.log(`State file: ${stateFile}`);
});

function shutdown() {
  clearInterval(offlineTimer);
  handler.close();
  server.close(() => process.exit(0));
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
