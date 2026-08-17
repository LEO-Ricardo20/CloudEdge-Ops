const fs = require('node:fs');
const path = require('node:path');
const { ACTIVE_COMMAND_STATUSES, DomainError } = require('./domain/platform');

const DEFAULT_MAX_JSON_BODY_BYTES = 64 * 1024;

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

async function readJson(request, maxBytes = DEFAULT_MAX_JSON_BODY_BYTES) {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new DomainError(`Request body exceeds ${maxBytes} bytes`, {
      statusCode: 413,
      code: 'PAYLOAD_TOO_LARGE',
    });
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      throw new DomainError(`Request body exceeds ${maxBytes} bytes`, {
        statusCode: 413,
        code: 'PAYLOAD_TOO_LARGE',
      });
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new DomainError('JSON request body must be an object', { code: 'VALIDATION_ERROR' });
    }
    return body;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('Invalid JSON request body', { code: 'INVALID_JSON' });
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

function positiveInteger(value, fieldName, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DomainError(`${fieldName} must be a positive integer`, { code: 'VALIDATION_ERROR' });
  }
  return parsed;
}

function errorBody(error, statusCode) {
  if (statusCode >= 500) return { error: 'Internal server error', code: 'INTERNAL_ERROR' };
  const body = { error: error.message || 'Internal server error' };
  if (error.code) body.code = error.code;
  return body;
}

function createHttpHandler(platform, webRoot, options = {}) {
  const clients = new Set();
  const maxJsonBodyBytes = options.maxJsonBodyBytes || DEFAULT_MAX_JSON_BODY_BYTES;
  const sseHeartbeatMs = options.sseHeartbeatMs || 15_000;
  const resolvedWebRoot = path.resolve(webRoot);
  const unsubscribe = platform.subscribe((event) => {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.write(payload);
  });
  const heartbeatTimer = setInterval(() => {
    for (const client of clients) client.write(': heartbeat\n\n');
  }, sseHeartbeatMs);
  heartbeatTimer.unref();

  const handler = async (request, response) => {
    try {
      const requestUrl = new URL(request.url, 'http://localhost');
      const { pathname, searchParams } = requestUrl;

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
        const result = platform.ingestTelemetry(await readJson(request, maxJsonBodyBytes));
        return sendJson(response, 202, result);
      }

      if (request.method === 'GET' && pathname === '/api/alerts') {
        return sendJson(response, 200, { alerts: platform.listAlerts(searchParams.get('status') || undefined) });
      }

      if (request.method === 'GET' && pathname === '/api/events/history') {
        const limit = positiveInteger(searchParams.get('limit'), 'limit', 40);
        return sendJson(response, 200, { events: platform.listEvents(limit) });
      }

      if (request.method === 'POST' && /^\/api\/alerts\/[^/]+\/acknowledge$/.test(pathname)) {
        const alertId = decodeURIComponent(pathname.split('/')[3]);
        const body = await readJson(request, maxJsonBodyBytes);
        const alert = platform.acknowledgeAlert(alertId, body.actor || 'operator');
        return alert ? sendJson(response, 200, { alert }) : sendJson(response, 404, { error: 'alert not found' });
      }

      if (request.method === 'POST' && /^\/api\/alerts\/[^/]+\/resolve$/.test(pathname)) {
        const alertId = decodeURIComponent(pathname.split('/')[3]);
        const body = await readJson(request, maxJsonBodyBytes);
        const alert = platform.resolveAlert(
          alertId,
          body.actor || 'operator',
          body.reason || 'Resolved by operator',
        );
        return alert ? sendJson(response, 200, { alert }) : sendJson(response, 404, { error: 'alert not found' });
      }

      if (request.method === 'GET' && pathname === '/api/commands') {
        const scope = searchParams.get('scope') || 'active';
        if (!['active', 'all'].includes(scope)) {
          throw new DomainError('scope must be active or all', { code: 'VALIDATION_ERROR' });
        }
        const statuses = scope === 'all' ? undefined : ACTIVE_COMMAND_STATUSES;
        return sendJson(response, 200, {
          commands: platform.listCommands(searchParams.get('deviceId') || undefined, statuses),
        });
      }

      if (request.method === 'POST' && pathname === '/api/ota-jobs') {
        const command = platform.createOtaJob(await readJson(request, maxJsonBodyBytes));
        return sendJson(response, 201, { command });
      }

      if (request.method === 'POST' && /^\/api\/commands\/[^/]+\/ack$/.test(pathname)) {
        const commandId = decodeURIComponent(pathname.split('/')[3]);
        await readJson(request, maxJsonBodyBytes);
        const command = platform.acknowledgeCommand(commandId);
        return command ? sendJson(response, 200, { command }) : sendJson(response, 404, { error: 'command not found' });
      }

      if (request.method === 'POST' && /^\/api\/commands\/[^/]+\/progress$/.test(pathname)) {
        const commandId = decodeURIComponent(pathname.split('/')[3]);
        const body = await readJson(request, maxJsonBodyBytes);
        const command = platform.updateCommandProgress(commandId, body.progress, body.status);
        return command ? sendJson(response, 200, { command }) : sendJson(response, 404, { error: 'command not found' });
      }

      if (request.method === 'POST' && pathname === '/api/demo/inject-alert') {
        const body = await readJson(request, maxJsonBodyBytes);
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
        const filePath = path.resolve(resolvedWebRoot, `.${normalizedPath}`);
        const relativePath = path.relative(resolvedWebRoot, filePath);
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return sendText(response, 403, 'Forbidden');
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          response.writeHead(200, { 'Content-Type': contentType(filePath), 'Cache-Control': 'no-store' });
          fs.createReadStream(filePath).pipe(response);
          return;
        }
      }

      return sendJson(response, 404, { error: 'not found' });
    } catch (error) {
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      return sendJson(response, statusCode, errorBody(error, statusCode));
    }
  };

  handler.close = () => {
    clearInterval(heartbeatTimer);
    unsubscribe();
    for (const client of clients) client.end();
    clients.clear();
  };
  return handler;
}

module.exports = { createHttpHandler, DEFAULT_MAX_JSON_BODY_BYTES, readJson };
