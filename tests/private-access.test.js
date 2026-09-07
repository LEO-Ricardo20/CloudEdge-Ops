const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { CloudEdgePlatform } = require('../server/domain/platform');
const { createHttpHandler } = require('../server/http');

async function start(t, options = {}) {
  const platform = new CloudEdgePlatform();
  platform.registerDevice({ id: 'device-2', name: 'Second device' });
  const handler = createHttpHandler(platform, path.resolve(__dirname, '../web'), {
    authMode: 'protected', operatorToken: 'private-operator',
    deviceTokens: { 'robot-arm-01': 'private-device', 'device-2': 'second-device' }, ...options,
  });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { handler.close(); await new Promise((resolve) => server.close(resolve)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, token, options = {}) => {
    const response = await fetch(baseUrl + route, {
      ...options, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return { platform, baseUrl, request };
}

test('protected reads deny anonymous and device access to fleet data', async (t) => {
  const { request } = await start(t);
  for (const route of ['/api/devices', '/api/alerts', '/api/events/history', '/api/metrics']) {
    assert.equal((await request(route)).status, 401, route);
    assert.equal((await request(route, 'private-device')).status, 403, route);
    assert.equal((await request(route, 'private-operator')).status, 200, route);
    assert.equal((await request(route + '?token=private-operator')).status, 401, route);
  }
  assert.equal((await request('/api/events')).status, 401);
  assert.equal((await request('/api/events', 'private-device')).status, 403);
  assert.equal((await request('/api/devices/robot-arm-01')).status, 401);
  assert.equal((await request('/api/devices/robot-arm-01', 'private-device')).status, 200);
  assert.equal((await request('/api/devices/device-2', 'private-device')).status, 403);
  assert.equal((await request('/api/devices/device-2', 'private-operator')).status, 200);
});

test('anonymous health reveals no recovery path or private persistence details', async (t) => {
  const { request, platform } = await start(t);
  platform.recovery = { source: '/private/state.json.bak.1', backupIndex: 1 };
  const health = await request('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.authMode, 'protected');
  assert.equal(health.body.recovery, undefined);
  assert.equal(health.body.persistence, undefined);
  assert.equal((await request('/api/health', 'private-operator')).body.recovery.backupIndex, 1);
});

test('event sessions expire, cannot authorize REST and are revoked by logout', async (t) => {
  const { request, baseUrl, platform } = await start(t, { sessionTtlMs: 200, sseHeartbeatMs: 20 });
  assert.equal((await request('/api/auth/session', undefined, { method: 'POST' })).status, 401);
  assert.equal((await request('/api/auth/session', 'private-device', { method: 'POST' })).status, 403);
  assert.equal((await request('/api/auth/session', 'private-operator', {
    method: 'POST', headers: { Origin: 'https://untrusted.invalid' },
  })).status, 403);
  const login = await request('/api/auth/session', 'private-operator', { method: 'POST' });
  assert.equal(login.status, 201);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(';')[0];
  assert.equal((await request('/api/devices', undefined, { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await request('/api/ota-jobs', undefined, { method: 'POST', headers: { Cookie: cookie } })).status, 401);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  t.after(() => { clearTimeout(timeout); controller.abort(); });
  const response = await fetch(baseUrl + '/api/events', { headers: { Cookie: cookie }, signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  platform.ingestTelemetry({ deviceId: 'robot-arm-01', metrics: { temperatureC: 41 } });
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  assert.match(text, /event: telemetry.updated/);
  assert.match(text, /event: auth.expired/);
  assert.equal((await request('/api/events', undefined, { headers: { Cookie: cookie } })).status, 401);
  const next = await request('/api/auth/session', 'private-operator', { method: 'POST' });
  const nextCookie = next.headers.get('set-cookie').split(';')[0];
  const logout = await request('/api/auth/session', undefined, { method: 'DELETE', headers: { Cookie: nextCookie } });
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await request('/api/events', undefined, { headers: { Cookie: nextCookie } })).status, 401);
  assert.equal((await request('/api/metrics', 'private-operator')).body.sseClients, 0);
});

test('new event login revokes the old stream and cookie immediately', async (t) => {
  const { request, baseUrl } = await start(t);
  const first = await request('/api/auth/session', 'private-operator', { method: 'POST' });
  const cookie = first.headers.get('set-cookie').split(';')[0];
  const response = await fetch(baseUrl + '/api/events', { headers: { Cookie: cookie }, signal: AbortSignal.timeout(3_000) });
  const second = await request('/api/auth/session', 'private-operator', { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(second.status, 201);
  assert.match(await response.text(), /event: auth.expired/);
  assert.equal((await request('/api/events', undefined, { headers: { Cookie: cookie } })).status, 401);
});

test('API rate limit covers anonymous authentication attempts', async (t) => {
  const { request } = await start(t, { rateLimits: { api: { limit: 2, windowMs: 60_000 } } });
  assert.equal((await request('/api/auth/operator', 'wrong')).status, 403);
  assert.equal((await request('/api/auth/operator', 'wrong')).status, 403);
  const limited = await request('/api/auth/operator', 'wrong');
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'RATE_LIMITED');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});
