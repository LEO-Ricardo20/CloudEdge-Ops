const fs = require('node:fs');
const path = require('node:path');

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function sendText(response, statusCode, body) {
  response.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('Invalid JSON request body');
    error.statusCode = 400;
    throw error;
  }
}

function contentType(filePath) {
  const extension = path.extname(filePath);
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
  }[extension] || 'application/octet-stream';
}

function createHttpHandler(platform, webRoot) {
  const clients = new Set();
  const unsubscribe = platform.subscribe((event) => {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.write(payload);
  });

  const handler = async (request, response) => {
    const requestUrl = new URL(request.url, 'http://localhost');
    const { pathname, searchParams } = requestUrl;

    try {
      if (request.method === 'GET' && pathname === '/api/health') {
        return sendJson(response, 200, { ok: true, service: 'cloudedge-ai', now: new Date().toISOString() });
      }

      if (request.method === 'GET' && pathname === '/api/devices') {
        return sendJson(response, 200, { devices: platform.listDevices() });
      }

      if (request.method === 'GET' && /^\/api\/devices\/[^/]+$/.test(pathname)) {
        const deviceId = decodeURIComponent(pathname.split('/').pop());
        const device = platform.getDevice(deviceId);
        return device ? sendJson(response, 200, { device }) : sendJson(response, 404, { error: 'device not found' });
      }

      if (request.method === 'POST' && pathname === '/api/telemetry') {
        const result = platform.ingestTelemetry(await readJson(request));
        return sendJson(response, 202, result);
      }

      if (request.method === 'GET' && pathname === '/api/alerts') {
        return sendJson(response, 200, { alerts: platform.listAlerts(searchParams.get('status') || undefined) });
      }

      if (request.method === 'GET' && pathname === '/api/events/history') {
        return sendJson(response, 200, { events: platform.listEvents(Number(searchParams.get('limit')) || 40) });
      }

      if (request.method === 'POST' && /^\/api\/alerts\/[^/]+\/acknowledge$/.test(pathname)) {
        const alertId = decodeURIComponent(pathname.split('/')[3]);
        const body = await readJson(request);
        const alert = platform.acknowledgeAlert(alertId, body.actor || 'operator');
        return alert ? sendJson(response, 200, { alert }) : sendJson(response, 404, { error: 'alert not found' });
      }

      if (request.method === 'GET' && pathname === '/api/commands') {
        return sendJson(response, 200, { commands: platform.listCommands(searchParams.get('deviceId') || undefined, ['queued', 'acknowledged']) });
      }

      if (request.method === 'POST' && pathname === '/api/ota-jobs') {
        const command = platform.createOtaJob(await readJson(request));
        return sendJson(response, 201, { command });
      }

      if (request.method === 'POST' && /^\/api\/commands\/[^/]+\/ack$/.test(pathname)) {
        const commandId = decodeURIComponent(pathname.split('/')[3]);
        const command = platform.acknowledgeCommand(commandId);
        return command ? sendJson(response, 200, { command }) : sendJson(response, 404, { error: 'command not found' });
      }

      if (request.method === 'POST' && /^\/api\/commands\/[^/]+\/progress$/.test(pathname)) {
        const commandId = decodeURIComponent(pathname.split('/')[3]);
        const body = await readJson(request);
        const command = platform.updateCommandProgress(commandId, body.progress, body.status);
        return command ? sendJson(response, 200, { command }) : sendJson(response, 404, { error: 'command not found' });
      }

      if (request.method === 'POST' && pathname === '/api/demo/inject-alert') {
        const body = await readJson(request);
        const deviceId = body.deviceId || 'robot-arm-01';
        const device = platform.getDevice(deviceId);
        if (!device) return sendJson(response, 404, { error: 'device not found' });
        const previous = device.latestTelemetry?.metrics || { vibrationMmS: 2.1, batteryPct: 84, motorRpm: 1240 };
        const result = platform.ingestTelemetry({
          deviceId,
          metrics: { ...previous, temperatureC: 73.8 },
          reportedState: device.shadow.reported,
        });
        return sendJson(response, 202, result);
      }

      if (request.method === 'GET' && pathname === '/api/events') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        response.write(`event: connected\ndata: ${JSON.stringify({ occurredAt: new Date().toISOString() })}\n\n`);
        clients.add(response);
        request.on('close', () => clients.delete(response));
        return;
      }

      if (request.method === 'GET') {
        const normalizedPath = pathname === '/' ? '/index.html' : pathname;
        const filePath = path.resolve(webRoot, `.${normalizedPath}`);
        if (!filePath.startsWith(path.resolve(webRoot))) return sendText(response, 403, 'Forbidden');
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          response.writeHead(200, { 'Content-Type': contentType(filePath), 'Cache-Control': 'no-store' });
          fs.createReadStream(filePath).pipe(response);
          return;
        }
      }

      return sendJson(response, 404, { error: 'not found' });
    } catch (error) {
      return sendJson(response, error.statusCode || 400, { error: error.message || 'bad request' });
    }
  };

  handler.close = () => {
    unsubscribe();
    for (const client of clients) client.end();
    clients.clear();
  };
  return handler;
}

module.exports = { createHttpHandler };
