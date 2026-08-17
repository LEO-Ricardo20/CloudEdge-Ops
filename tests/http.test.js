const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { CloudEdgePlatform } = require('../server/domain/platform');
const { createHttpHandler } = require('../server/http');

async function startApi(t, options = {}) {
  const platform = new CloudEdgePlatform();
  const handler = createHttpHandler(platform, path.resolve(__dirname, '..', 'web'), options);
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    handler.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address();
  return { platform, baseUrl: `http://127.0.0.1:${port}` };
}

async function jsonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json();
  return { response, body };
}

test('HTTP polling keeps OTA active through downloading and installing', async (t) => {
  const { baseUrl } = await startApi(t);
  const created = await jsonRequest(baseUrl, '/api/ota-jobs', {
    method: 'POST',
    body: JSON.stringify({ deviceId: 'robot-arm-01', targetVersion: '0.2.0', requestId: 'http-release' }),
  });
  assert.equal(created.response.status, 201);
  const commandId = created.body.command.id;

  let active = await jsonRequest(baseUrl, '/api/commands?deviceId=robot-arm-01');
  assert.equal(active.body.commands[0].status, 'queued');
  await jsonRequest(baseUrl, `/api/commands/${commandId}/ack`, { method: 'POST', body: '{}' });
  await jsonRequest(baseUrl, `/api/commands/${commandId}/progress`, {
    method: 'POST',
    body: JSON.stringify({ progress: 25, status: 'downloading' }),
  });
  active = await jsonRequest(baseUrl, '/api/commands?deviceId=robot-arm-01');
  assert.equal(active.body.commands[0].status, 'downloading');
  await jsonRequest(baseUrl, `/api/commands/${commandId}/progress`, {
    method: 'POST',
    body: JSON.stringify({ progress: 50, status: 'installing' }),
  });
  active = await jsonRequest(baseUrl, '/api/commands?deviceId=robot-arm-01');
  assert.equal(active.body.commands[0].status, 'installing');
  await jsonRequest(baseUrl, `/api/commands/${commandId}/progress`, {
    method: 'POST',
    body: JSON.stringify({ progress: 100, status: 'success' }),
  });

  active = await jsonRequest(baseUrl, '/api/commands?deviceId=robot-arm-01');
  assert.deepEqual(active.body.commands, []);
  const all = await jsonRequest(baseUrl, '/api/commands?deviceId=robot-arm-01&scope=all');
  assert.equal(all.body.commands[0].status, 'success');
  const detail = await jsonRequest(baseUrl, '/api/devices/robot-arm-01');
  assert.equal(detail.body.device.pendingCommands.length, 0);
  assert.equal(detail.body.device.commandHistory[0].history.length, 5);
  assert.equal(detail.body.device.shadow.reported.firmwareVersion, '0.2.0');
});

test('HTTP maps state conflicts to 409 and validates query parameters', async (t) => {
  const { baseUrl } = await startApi(t);
  const created = await jsonRequest(baseUrl, '/api/ota-jobs', {
    method: 'POST',
    body: JSON.stringify({ deviceId: 'robot-arm-01', targetVersion: '0.2.0' }),
  });
  const commandId = created.body.command.id;
  await jsonRequest(baseUrl, `/api/commands/${commandId}/ack`, { method: 'POST', body: '{}' });
  const conflict = await jsonRequest(baseUrl, `/api/commands/${commandId}/progress`, {
    method: 'POST',
    body: JSON.stringify({ progress: 50, status: 'installing' }),
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.code, 'INVALID_STATE_TRANSITION');

  const invalidScope = await jsonRequest(baseUrl, '/api/commands?scope=terminal');
  assert.equal(invalidScope.response.status, 400);
  assert.equal(invalidScope.body.code, 'VALIDATION_ERROR');
  const invalidLimit = await jsonRequest(baseUrl, '/api/events/history?limit=zero');
  assert.equal(invalidLimit.response.status, 400);
});

test('HTTP exposes the acknowledge and resolve alert lifecycle', async (t) => {
  const { baseUrl } = await startApi(t);
  const telemetry = await jsonRequest(baseUrl, '/api/telemetry', {
    method: 'POST',
    body: JSON.stringify({ deviceId: 'robot-arm-01', metrics: { temperatureC: 72 } }),
  });
  const alertId = telemetry.body.alerts[0].id;
  const earlyResolve = await jsonRequest(baseUrl, `/api/alerts/${alertId}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ actor: 'dashboard', reason: 'Checked' }),
  });
  assert.equal(earlyResolve.response.status, 409);

  const acknowledged = await jsonRequest(baseUrl, `/api/alerts/${alertId}/acknowledge`, {
    method: 'POST',
    body: JSON.stringify({ actor: 'dashboard' }),
  });
  assert.equal(acknowledged.body.alert.status, 'acknowledged');
  const resolved = await jsonRequest(baseUrl, `/api/alerts/${alertId}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ actor: 'dashboard', reason: 'Machine inspected' }),
  });
  assert.equal(resolved.body.alert.status, 'resolved');
  assert.equal(resolved.body.alert.resolutionReason, 'Machine inspected');
  const retry = await jsonRequest(baseUrl, `/api/alerts/${alertId}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ actor: 'dashboard', reason: 'Machine inspected' }),
  });
  assert.equal(retry.body.alert.status, 'resolved');
});

test('HTTP rejects malformed JSON, invalid telemetry and oversized request bodies', async (t) => {
  const { baseUrl } = await startApi(t, { maxJsonBodyBytes: 128 });
  const malformed = await jsonRequest(baseUrl, '/api/telemetry', {
    method: 'POST',
    body: '{',
  });
  assert.equal(malformed.response.status, 400);
  assert.equal(malformed.body.code, 'INVALID_JSON');

  const invalid = await jsonRequest(baseUrl, '/api/telemetry', {
    method: 'POST',
    body: JSON.stringify({ deviceId: 'robot-arm-01', metrics: { temperatureC: 'hot' } }),
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.code, 'VALIDATION_ERROR');

  const oversized = await jsonRequest(baseUrl, '/api/telemetry', {
    method: 'POST',
    body: JSON.stringify({ deviceId: 'robot-arm-01', metrics: {}, padding: 'x'.repeat(256) }),
  });
  assert.equal(oversized.response.status, 413);
  assert.equal(oversized.body.code, 'PAYLOAD_TOO_LARGE');
});

test('HTTP does not expose unexpected internal error details', async (t) => {
  const platform = new CloudEdgePlatform();
  platform.listDevices = () => {
    throw new Error('ENOSPC at C:\\private\\platform-state.json');
  };
  const handler = createHttpHandler(platform, path.resolve(__dirname, '..', 'web'));
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    handler.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address();
  const result = await jsonRequest(`http://127.0.0.1:${port}`, '/api/devices');
  assert.equal(result.response.status, 500);
  assert.deepEqual(result.body, { error: 'Internal server error', code: 'INTERNAL_ERROR' });
});
