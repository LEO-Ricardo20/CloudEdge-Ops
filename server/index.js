const http = require('node:http');
const path = require('node:path');
const { CloudEdgePlatform } = require('./domain/platform');
const { createHttpHandler } = require('./http');

const port = Number(process.env.PORT || 4173);
const platform = new CloudEdgePlatform();
const handler = createHttpHandler(platform, path.resolve(__dirname, '..', 'web'));
const server = http.createServer(handler);

server.listen(port, '127.0.0.1', () => {
  console.log(`CloudEdge AI dashboard: http://localhost:${port}`);
  console.log(`API health: http://localhost:${port}/api/health`);
});

function shutdown() {
  handler.close();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

