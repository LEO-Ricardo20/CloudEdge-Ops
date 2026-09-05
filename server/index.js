const http = require('node:http');
const path = require('node:path');
const { CloudEdgePlatform } = require('./domain/platform');
const { readConfig } = require('./config');
const { createHttpHandler } = require('./http');
const { JsonFileRepository } = require('./persistence/json-file-repository');

const config = readConfig();
const { port, offlineAfterMs, offlineCheckIntervalMs, commandTtlMs } = config;
const stateFile = path.resolve(process.env.STATE_FILE || path.resolve(__dirname, '..', 'data', 'platform-state.json'));
const repository = new JsonFileRepository(stateFile);
const platform = new CloudEdgePlatform({ repository, offlineAfterMs, commandTtlMs });
const handler = createHttpHandler(platform, path.resolve(__dirname, '..', 'web'), {
  ...config,
});
const server = http.createServer(handler);
const offlineTimer = setInterval(() => evaluate('offline', () => platform.evaluateOfflineDevices()), offlineCheckIntervalMs);
offlineTimer.unref();
const expiryTimer = setInterval(() => evaluate('expiry', () => platform.evaluateExpiredCommands()), Math.max(1_000, Math.min(Math.floor(commandTtlMs / 4), 5_000)));
expiryTimer.unref();

server.listen(port, '127.0.0.1', () => {
  console.log(`CloudEdge Ops dashboard: http://localhost:${server.address().port}`);
  console.log(`API health: http://localhost:${server.address().port}/api/health`);
  console.log(`State file: ${stateFile}`);
});

function shutdown() {
  clearInterval(offlineTimer);
  clearInterval(expiryTimer);
  handler.close();
  server.close(() => process.exit(0));
}

function evaluate(name, callback) {
  try {
    callback();
  } catch (error) {
    console.error(`[${name}] evaluation failed: ${error.code || error.name}`);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
