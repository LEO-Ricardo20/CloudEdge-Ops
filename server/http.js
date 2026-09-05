const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ACTIVE_COMMAND_STATUSES, DomainError } = require('./domain/platform');

const DEFAULT_MAX_JSON_BODY_BYTES = 64 * 1024;
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

function sendJson(response, statusCode, body, requestId) {
  const payload = { ...body };
  if (requestId && statusCode < 500 && payload.requestId == null) payload.requestId = requestId;
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(requestId ? { 'X-Request-Id': requestId } : {}) });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, body, requestId) {
  response.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8', ...(requestId ? { 'X-Request-Id': requestId } : {}) });
  response.end(body);
}

async function readJson(request, maxBytes = DEFAULT_MAX_JSON_BODY_BYTES) {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new DomainError(`Request body exceeds ${maxBytes} bytes`, { statusCode: 413, code: 'PAYLOAD_TOO_LARGE' });
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) throw new DomainError(`Request body exceeds ${maxBytes} bytes`, { statusCode: 413, code: 'PAYLOAD_TOO_LARGE' });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DomainError('JSON request body must be an object', { code: 'VALIDATION_ERROR' });
    return body;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('Invalid JSON request body', { code: 'INVALID_JSON' });
  }
}

function contentType(filePath) {
  return { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml' }[path.extname(filePath)] || 'application/octet-stream';
}

function positiveInteger(value, fieldName, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new DomainError(`${fieldName} must be a positive integer`, { code: 'VALIDATION_ERROR' });
  return parsed;
}

function errorBody(error, statusCode, requestId) {
  if (statusCode >= 500) return { error: 'Internal server error', code: 'INTERNAL_ERROR' };
  return { error: error.message || 'Internal server error', ...(error.code ? { code: error.code } : {}), requestId };
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function bearerToken(request) {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function createLimiter(config = {}) {
  const buckets = new Map();
  const defaults = { limit: 1000, windowMs: 60_000 };
  return (name, key) => {
    const input = config[name] || config.default || defaults;
    const limit = Number(input?.limit || input?.max || input);
    const windowMs = Number(input?.windowMs || 60_000);
    if (!Number.isFinite(limit) || limit <= 0) return null;
    const now = Date.now(); const bucketKey = `${name}:${key}`;
    let bucket = buckets.get(bucketKey);
    if (!bucket || now >= bucket.resetAt) { bucket = { count: 0, resetAt: now + windowMs }; buckets.set(bucketKey, bucket); }
    bucket.count += 1;
    return bucket.count > limit ? Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) : null;
  };
}

function createHttpHandler(platform, webRoot, options = {}) {
  const clients = new Set();
  const counters = { requests: 0, errors: 0, rateLimited: 0 };
  const maxJsonBodyBytes = options.maxJsonBodyBytes || DEFAULT_MAX_JSON_BODY_BYTES;
  const sseHeartbeatMs = options.sseHeartbeatMs || 15_000;
  const resolvedWebRoot = path.resolve(webRoot);
  const authMode = options.authMode || 'demo';
  const operatorToken = options.operatorToken || process.env.OPERATOR_TOKEN || null;
  const configuredDeviceTokens = options.deviceTokens || {};
  const deviceTokens = configuredDeviceTokens instanceof Map ? configuredDeviceTokens : new Map(Object.entries(configuredDeviceTokens));
  const limit = createLimiter(options.rateLimits || {});
  const unsubscribe = platform.subscribe((event) => {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) { try { client.write(payload); } catch { clients.delete(client); } }
  });
  const heartbeatTimer = setInterval(() => {
    for (const client of clients) { try { client.write(': heartbeat\n\n'); } catch { clients.delete(client); } }
  }, sseHeartbeatMs);
  heartbeatTimer.unref();

  function requireOperator(request) {
    if (authMode !== 'protected') return 'demo-operator';
    const token = bearerToken(request);
    if (!token) throw new DomainError('operator authentication required', { statusCode: 401, code: 'AUTH_REQUIRED' });
    if (!operatorToken || !safeEqual(token, operatorToken)) throw new DomainError('operator is not authorized', { statusCode: 403, code: 'FORBIDDEN' });
    return 'operator';
  }
  function requireDevice(request, deviceId) {
    if (authMode !== 'protected') return 'demo-device';
    const token = bearerToken(request);
    if (!token) throw new DomainError('device authentication required', { statusCode: 401, code: 'AUTH_REQUIRED' });
    const expected = deviceTokens.get(deviceId);
    if (!expected || !safeEqual(token, expected)) throw new DomainError('device is not authorized', { statusCode: 403, code: 'FORBIDDEN' });
    return `device:${deviceId}`;
  }
  function requestIp(request) { return request.socket?.remoteAddress || 'unknown'; }
  function enforceLimit(name, key, response) {
    const retry = limit(name, key);
    if (!retry) return;
    counters.rateLimited += 1; response.setHeader('Retry-After', String(retry));
    throw new DomainError('request rate limit exceeded', { statusCode: 429, code: 'RATE_LIMITED' });
  }

  const handler = async (request, response) => {
    const supplied = request.headers['x-request-id'];
    const requestId = typeof supplied === 'string' && SAFE_REQUEST_ID.test(supplied) ? supplied : `req_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    response.setHeader('X-Request-Id', requestId); counters.requests += 1;
    try {
      const requestUrl = new URL(request.url, 'http://localhost'); const { pathname, searchParams } = requestUrl; const method = request.method || 'GET'; const ip = requestIp(request);
      if (method === 'GET' && pathname === '/api/health') {
        const health = typeof platform.getHealth === 'function' ? platform.getHealth() : { status: 'ok', persistence: 'unknown', recovery: null, schemaVersion: 1 };
        const ok = health.status === 'ok';
        return sendJson(response, ok ? 200 : 503, { ok, service: 'cloudedge-ops', authMode, now: new Date().toISOString(), ...health }, requestId);
      }
      if (method === 'GET' && pathname === '/api/metrics') {
        const metrics = typeof platform.getMetrics === 'function' ? platform.getMetrics() : {};
        return sendJson(response, 200, { ...metrics, sseClients: clients.size, requests: counters.requests, errors: counters.errors, rateLimited: counters.rateLimited }, requestId);
      }
      if (method === 'GET' && pathname === '/api/auth/operator') {
        const actor = requireOperator(request);
        return sendJson(response, 200, { actor, authMode }, requestId);
      }
      if (method === 'GET' && pathname === '/api/devices') return sendJson(response, 200, { devices: platform.listDevices() }, requestId);
      if (method === 'GET' && /^\/api\/devices\/[^/]+$/.test(pathname)) {
        const deviceId = decodeURIComponent(pathname.split('/').pop()); const device = platform.getDevice(deviceId);
        return device ? sendJson(response, 200, { device }, requestId) : sendJson(response, 404, { error: 'device not found', code: 'DEVICE_NOT_FOUND' }, requestId);
      }
      if (method === 'POST' && pathname === '/api/telemetry') {
        const body = await readJson(request, maxJsonBodyBytes); const identity = requireDevice(request, body.deviceId); enforceLimit('telemetry', `${identity}:${ip}`, response);
        return sendJson(response, 202, platform.ingestTelemetry(body), requestId);
      }
      if (method === 'GET' && pathname === '/api/alerts') return sendJson(response, 200, { alerts: platform.listAlerts(searchParams.get('status') || undefined) }, requestId);
      if (method === 'GET' && pathname === '/api/events/history') return sendJson(response, 200, { events: platform.listEvents(positiveInteger(searchParams.get('limit'), 'limit', 40)) }, requestId);
      if (method === 'POST' && /^\/api\/alerts\/[^/]+\/(acknowledge|resolve)$/.test(pathname)) {
        const actor = requireOperator(request); enforceLimit('operatorWrite', `${actor}:${ip}`, response); const alertId = decodeURIComponent(pathname.split('/')[3]); const body = await readJson(request, maxJsonBodyBytes);
        const alert = pathname.endsWith('/acknowledge') ? platform.acknowledgeAlert(alertId, authMode === 'protected' ? 'operator' : (body.actor || 'operator')) : platform.resolveAlert(alertId, authMode === 'protected' ? 'operator' : (body.actor || 'operator'), body.reason || 'Resolved by operator');
        return alert ? sendJson(response, 200, { alert }, requestId) : sendJson(response, 404, { error: 'alert not found', code: 'ALERT_NOT_FOUND' }, requestId);
      }
      if (method === 'GET' && pathname === '/api/commands') {
        const deviceId = searchParams.get('deviceId') || undefined;
        if (deviceId) requireDevice(request, deviceId); else if (authMode === 'protected') throw new DomainError('deviceId is required for command polling', { statusCode: 400, code: 'VALIDATION_ERROR' });
        platform.evaluateExpiredCommands(); const scope = searchParams.get('scope') || 'active';
        if (!['active', 'all'].includes(scope)) throw new DomainError('scope must be active or all', { code: 'VALIDATION_ERROR' });
        return sendJson(response, 200, { commands: platform.listCommands(deviceId, scope === 'all' ? undefined : ACTIVE_COMMAND_STATUSES) }, requestId);
      }
      if (method === 'POST' && pathname === '/api/ota-jobs') {
        const actor = requireOperator(request); enforceLimit('operatorWrite', `${actor}:${ip}`, response); return sendJson(response, 201, { command: platform.createOtaJob(await readJson(request, maxJsonBodyBytes)) }, requestId);
      }
      if (method === 'POST' && /^\/api\/commands\/[^/]+\/(ack|progress)$/.test(pathname)) {
        const commandId = decodeURIComponent(pathname.split('/')[3]); const commandBefore = platform.getCommand ? platform.getCommand(commandId) : platform.listCommands(undefined).find((item) => item.id === commandId);
        if (!commandBefore) return sendJson(response, 404, { error: 'command not found', code: 'COMMAND_NOT_FOUND' }, requestId);
        requireDevice(request, commandBefore.deviceId); platform.evaluateExpiredCommands(); const body = await readJson(request, maxJsonBodyBytes);
        const command = pathname.endsWith('/ack') ? platform.acknowledgeCommand(commandId) : platform.updateCommandProgress(commandId, body.progress, body.status);
        return command ? sendJson(response, 200, { command }, requestId) : sendJson(response, 404, { error: 'command not found', code: 'COMMAND_NOT_FOUND' }, requestId);
      }
      if (method === 'POST' && pathname === '/api/demo/inject-alert') {
        const actor = requireOperator(request); enforceLimit('operatorWrite', `${actor}:${ip}`, response); const body = await readJson(request, maxJsonBodyBytes); const deviceId = body.deviceId || 'robot-arm-01'; const device = platform.getDevice(deviceId);
        if (!device) return sendJson(response, 404, { error: 'device not found', code: 'DEVICE_NOT_FOUND' }, requestId);
        const previous = device.latestTelemetry?.metrics || { vibrationMmS: 2.1, batteryPct: 84, motorRpm: 1240 };
        return sendJson(response, 202, platform.ingestTelemetry({ deviceId, metrics: { ...previous, temperatureC: 73.8 }, reportedState: device.shadow.reported }), requestId);
      }
      if (method === 'GET' && pathname === '/api/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Request-Id': requestId });
        response.write(`event: connected\ndata: ${JSON.stringify({ occurredAt: new Date().toISOString(), requestId })}\n\n`); clients.add(response); request.on('close', () => clients.delete(response)); return;
      }
      if (method === 'GET') {
        const normalizedPath = pathname === '/' ? '/index.html' : pathname; const filePath = path.resolve(resolvedWebRoot, `.${normalizedPath}`); const relativePath = path.relative(resolvedWebRoot, filePath);
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return sendText(response, 403, 'Forbidden', requestId);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) { response.writeHead(200, { 'Content-Type': contentType(filePath), 'Cache-Control': 'no-store', 'X-Request-Id': requestId }); fs.createReadStream(filePath).pipe(response); return; }
      }
      return sendJson(response, 404, { error: 'not found', code: 'NOT_FOUND' }, requestId);
    } catch (error) {
      counters.errors += 1;
      if (error instanceof URIError) error = new DomainError('Invalid URL encoding', { code: 'VALIDATION_ERROR' });
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      return sendJson(response, statusCode, errorBody(error, statusCode, requestId), requestId);
    }
  };
  handler.close = () => { clearInterval(heartbeatTimer); unsubscribe(); for (const client of clients) client.end(); clients.clear(); };
  handler.metrics = counters;
  return handler;
}

module.exports = { createHttpHandler, DEFAULT_MAX_JSON_BODY_BYTES, readJson };
