const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { CloudEdgePlatform } = require('../server/domain/platform');
const { JsonFileRepository } = require('../server/persistence/json-file-repository');
const { createHttpHandler } = require('../server/http');

function clockAt(value = '2026-08-12T10:00:00.000Z') {
  let time = Date.parse(value);
  return { now: () => new Date(time), advance: (ms) => { time += ms; } };
}

test('OTA expires active commands idempotently without changing reported firmware', () => {
  const clock = clockAt();
  const platform = new CloudEdgePlatform({ now: clock.now, commandTtlMs: 2_000 });
  const command = platform.createOtaJob({ deviceId: 'robot-arm-01', targetVersion: '0.3.0' });
  assert.ok(command.expiresAt);
  clock.advance(2_000);
  const first = platform.evaluateExpiredCommands();
  const second = platform.evaluateExpiredCommands();
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  assert.equal(platform.getCommand(command.id).status, 'expired');
  assert.equal(platform.getDevice('robot-arm-01').shadow.reported.firmwareVersion, '0.1.0');
  assert.equal(platform.getDevice('robot-arm-01').shadow.desired.firmwareVersion, '0.3.0');
  assert.equal(platform.getCommand(command.id).history.at(-1).status, 'expired');
});

test('v1 snapshots migrate to v2 with command expiry metadata', () => {
  const clock = clockAt();
  const v1 = {
    version: 1,
    devices: [{ id: 'robot-arm-01', name: 'Robot Arm 01', type: 'robot', firmwareVersion: '0.1.0', desiredFirmwareVersion: '0.2.0', status: 'unknown', lastSeenAt: null, shadow: { reported: {}, desired: {} } }],
    telemetry: [['robot-arm-01', []]], alerts: [],
    commands: [{ id: 'cmd_old', requestId: null, type: 'ota', deviceId: 'robot-arm-01', payload: { targetVersion: '0.2.0', artifactUrl: 'https://example.invalid/fw', checksum: 'x' }, status: 'queued', progress: 0, createdAt: '2026-08-12T09:59:00.000Z', acknowledgedAt: null, completedAt: null, history: [{ status: 'queued', progress: 0, at: '2026-08-12T09:59:00.000Z' }] }],
    eventLog: [],
  };
  const platform = new CloudEdgePlatform({ now: clock.now, commandTtlMs: 3_600_000, repository: { load: () => v1, save: (state) => { assert.equal(state.version, 2); } } });
  assert.equal(platform.snapshot().version, 2);
  assert.equal(platform.getCommand('cmd_old').expiresAt, '2026-08-12T10:59:00.000Z');
});

test('repository rotates backups and platform reports recovery metadata', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudedge-v03-'));
  const file = path.join(directory, 'platform-state.json');
  try {
    const repository = new JsonFileRepository(file);
    const platform = new CloudEdgePlatform({ repository });
    platform.registerDevice({ id: 'device-2', name: 'Device 2', type: 'sensor' });
    assert.ok(fs.existsSync(`${file}.bak.1`));
    fs.writeFileSync(file, '{broken', 'utf8');
    const restored = new CloudEdgePlatform({ repository: new JsonFileRepository(file) });
    assert.equal(restored.recovery.backupIndex, 1);
    assert.equal(restored.getDevice('robot-arm-01').id, 'robot-arm-01');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function startProtected(t, options = {}) {
  const platform = new CloudEdgePlatform();
  const handler = createHttpHandler(platform, path.resolve(__dirname, '..', 'web'), { authMode: 'protected', operatorToken: 'op-secret', deviceTokens: { 'robot-arm-01': 'dev-secret' }, ...options });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { handler.close(); await new Promise((resolve) => server.close(resolve)); });
  return { platform, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test('protected HTTP routes enforce device/operator credentials and request ids', async (t) => {
  const { baseUrl } = await startProtected(t, { rateLimits: { telemetry: { limit: 1, windowMs: 30_000 } } });
  const request = (pathname, options = {}) => fetch(`${baseUrl}${pathname}`, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const missing = await request('/api/telemetry', { method: 'POST', body: JSON.stringify({ deviceId: 'robot-arm-01', metrics: { temperatureC: 40 } }) });
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get('x-request-id')?.startsWith('req_'), true);
  const first = await request('/api/telemetry', { method: 'POST', headers: { Authorization: 'Bearer dev-secret' }, body: JSON.stringify({ deviceId: 'robot-arm-01', metrics: { temperatureC: 40 } }) });
  assert.equal(first.status, 202);
  const limited = await request('/api/telemetry', { method: 'POST', headers: { Authorization: 'Bearer dev-secret', 'X-Request-Id': 'client-trace-1' }, body: JSON.stringify({ deviceId: 'robot-arm-01', metrics: { temperatureC: 40 } }) });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '30');
  assert.equal((await limited.json()).code, 'RATE_LIMITED');
  const forbidden = await request('/api/ota-jobs', { method: 'POST', body: JSON.stringify({ deviceId: 'robot-arm-01', targetVersion: '0.2.0' }) });
  assert.equal(forbidden.status, 401);
  const created = await request('/api/ota-jobs', { method: 'POST', headers: { Authorization: 'Bearer op-secret' }, body: JSON.stringify({ deviceId: 'robot-arm-01', targetVersion: '0.2.0' }) });
  assert.equal(created.status, 201);
});

test('devices cannot expire commands and expiry releases the next OTA slot immediately', () => {
  const clock = clockAt();
  const platform = new CloudEdgePlatform({ now: clock.now, commandTtlMs: 1_000 });
  const input = { deviceId: 'robot-arm-01', targetVersion: '0.3.0' };
  const first = platform.createOtaJob(input);
  assert.throws(() => platform.updateCommandProgress(first.id, 0, 'expired'), { code: 'VALIDATION_ERROR' });
  assert.equal(platform.getCommand(first.id).status, 'queued');
  clock.advance(1_000);
  const second = platform.createOtaJob({ ...input, targetVersion: '0.4.0' });
  assert.equal(platform.getCommand(first.id).status, 'expired');
  assert.equal(second.status, 'queued');
  for (const expiresInSeconds of [true, '5', 0, 0.5, 2_592_001]) {
    assert.throws(() => platform.createOtaJob({ ...input, expiresInSeconds }), { code: 'VALIDATION_ERROR' });
  }
});

test('protected credentials cannot act on another device or validate as an operator', async (t) => {
  const { platform, baseUrl } = await startProtected(t, { deviceTokens: { 'robot-arm-01': 'first', 'device-2': 'second' } });
  const command = platform.createOtaJob({ deviceId: 'robot-arm-01', targetVersion: '0.3.0' });
  for (const [route, method, token, status] of [
    ['/api/auth/operator', 'GET', '', 401],
    ['/api/auth/operator', 'GET', 'first', 403],
    ['/api/auth/operator', 'GET', 'op-secret', 200],
    ['/api/commands?deviceId=robot-arm-01', 'GET', 'second', 403],
    [`/api/commands/${command.id}/ack`, 'POST', 'second', 403],
    [`/api/commands/${command.id}/progress`, 'POST', 'second', 403],
  ]) {
    const response = await fetch(baseUrl + route, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
    assert.equal(response.status, status, route);
    await response.text();
  }
  assert.equal(platform.getCommand(command.id).status, 'queued');
});

test('late command acknowledgement is rejected and expiry survives restart', async (t) => {
  const { platform, baseUrl } = await startProtected(t);
  const clock = clockAt();
  platform.now = clock.now;
  const command = platform.createOtaJob({ deviceId: 'robot-arm-01', targetVersion: '0.3.0', expiresInSeconds: 1 });
  clock.advance(1_000);
  const response = await fetch(`${baseUrl}/api/commands/${command.id}/ack`, {
    method: 'POST', headers: { Authorization: 'Bearer dev-secret' }, body: '{}',
  });
  assert.equal(response.status, 409);
  await response.text();
  const restored = new CloudEdgePlatform({ repository: { load: () => platform.snapshot() } });
  assert.equal(restored.getCommand(command.id).status, 'expired');
  assert.equal(restored.getCommand(command.id).history.length, 2);
});
