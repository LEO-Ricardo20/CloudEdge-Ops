const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { CloudEdgePlatform } = require('../server/domain/platform');
const { JsonFileRepository } = require('../server/persistence/json-file-repository');
const { createHttpHandler } = require('../server/http');
const { TelemetryDelivery } = require('../simulator/telemetry-delivery');

const payload = () => ({ deviceId: 'robot-arm-01', bootId: 'boot-1', sequence: 0, timestamp: '2026-09-08T00:00:00Z', metrics: { temperatureC: 72, vibrationMmS: 2 } });

test('deduplication window is bounded by the retained 240 samples', () => {
  const platform = new CloudEdgePlatform();
  for (let sequence = 0; sequence <= 240; sequence++) {
    platform.ingestTelemetry({ ...payload(), sequence, metrics: { temperatureC: 40 } });
  }
  assert.equal(platform.getTelemetry('robot-arm-01', 240).length, 240);
  assert.equal(platform.ingestTelemetry({ ...payload(), sequence: 240, metrics: { temperatureC: 40 } }).duplicate, true);
  assert.equal(platform.ingestTelemetry({ ...payload(), metrics: { temperatureC: 40 } }).duplicate, false);
});

test('duplicate telemetry survives restart without events, writes or liveness refresh', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudedge-dedup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new JsonFileRepository(path.join(directory, 'state.json'));
  const first = new CloudEdgePlatform({ repository });
  const accepted = first.ingestTelemetry(payload());
  const restored = new CloudEdgePlatform({ repository });
  const before = restored.snapshot();
  const events = [];
  restored.subscribe((event) => events.push(event));
  const save = t.mock.method(repository, 'save', () => { throw new Error('unexpected write'); });
  const retry = restored.ingestTelemetry({ ...payload(), metrics: { vibrationMmS: 2, temperatureC: 72 } });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.telemetry.id, accepted.telemetry.id);
  assert.deepEqual(restored.snapshot(), before);
  assert.equal(events.length, 0);
  assert.equal(save.mock.callCount(), 0);
});

test('identities validate, conflicting retries reject, boot and device scope remain independent', () => {
  const platform = new CloudEdgePlatform();
  platform.ingestTelemetry(payload());
  assert.throws(() => platform.ingestTelemetry({ ...payload(), metrics: { temperatureC: 40 } }), { code: 'TELEMETRY_IDENTITY_REUSE' });
  for (const fields of [{ bootId: '' }, { sequence: -1 }, { sequence: '0' }, { sequence: Number.MAX_SAFE_INTEGER + 1 }, { timestamp: null }, { bootId: null }]) {
    assert.throws(() => platform.ingestTelemetry({ ...payload(), ...fields }), { code: 'VALIDATION_ERROR' });
  }
  assert.equal(platform.ingestTelemetry({ ...payload(), bootId: 'boot-2' }).duplicate, false);
  assert.equal(platform.ingestTelemetry({ ...payload(), deviceId: 'sensor-2' }).duplicate, false);
  assert.equal(platform.getDevice('robot-arm-01').recentTelemetry.length, 2);
});

test('retry after a committed HTTP response is lost produces one sample and one alarm', async (t) => {
  const platform = new CloudEdgePlatform();
  const handler = createHttpHandler(platform, path.resolve(__dirname, '../web'));
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { handler.close(); await new Promise((resolve) => server.close(resolve)); });
  let loseResponse = true;
  let samples = 0;
  const delivery = new TelemetryDelivery({
    deviceId: 'robot-arm-01', bootId: 'test-boot',
    sample: () => { samples++; return { metrics: { temperatureC: 72 } }; },
    send: async (body) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/telemetry`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 202);
      const result = await response.json();
      if (loseResponse) { loseResponse = false; throw new Error('simulated response loss after server commit'); }
      return result;
    },
  });
  await assert.rejects(delivery.deliver(), /response loss/);
  assert.equal((await delivery.deliver()).duplicate, true);
  assert.equal(samples, 1);
  assert.equal(platform.getDevice('robot-arm-01').recentTelemetry.length, 1);
  assert.equal(platform.listAlerts().length, 1);
  assert.equal((await delivery.deliver()).telemetry.sequence, 1);
});

test('unavailable transport retains one original sample until delivery resumes', async () => {
  let available = false;
  const sent = [];
  const delivery = new TelemetryDelivery({ deviceId: 'robot-arm-01', sample: () => ({ metrics: { temperatureC: 40 } }),
    send: async (body) => { sent.push(structuredClone(body)); if (!available) throw new Error('offline'); return {}; },
  });
  await assert.rejects(delivery.deliver(), /offline/);
  await assert.rejects(delivery.deliver(), /offline/);
  available = true;
  await delivery.deliver();
  assert.deepEqual(sent[0], sent[2]);
  assert.equal(delivery.pending, null);
});
