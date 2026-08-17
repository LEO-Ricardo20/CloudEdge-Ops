const test = require('node:test');
const assert = require('node:assert/strict');
const { CloudEdgePlatform } = require('../server/domain/platform');

function createPlatform() {
  let index = 0;
  return new CloudEdgePlatform({ now: () => new Date(`2026-08-12T10:00:${String(index++).padStart(2, '0')}.000Z`) });
}

test('telemetry updates the device shadow and creates a temperature alert', () => {
  const platform = createPlatform();
  const result = platform.ingestTelemetry({
    deviceId: 'robot-arm-01',
    metrics: { temperatureC: 71, vibrationMmS: 1.8, batteryPct: 80, motorRpm: 1200 },
    reportedState: { firmwareVersion: '0.1.0', mode: 'auto' },
  });

  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].severity, 'critical');
  const device = platform.getDevice('robot-arm-01');
  assert.equal(device.status, 'online');
  assert.equal(device.latestTelemetry.metrics.temperatureC, 71);
  assert.equal(device.shadow.reported.mode, 'auto');
});

test('an open alert is deduplicated by device and metric', () => {
  const platform = createPlatform();
  platform.ingestTelemetry({ deviceId: 'robot-arm-01', metrics: { temperatureC: 71 } });
  platform.ingestTelemetry({ deviceId: 'robot-arm-01', metrics: { temperatureC: 72 } });

  assert.equal(platform.listAlerts().length, 1);
  assert.equal(platform.listAlerts()[0].evidence.value, 72);
});

test('ota command moves from queue to success and aligns device firmware', () => {
  const platform = createPlatform();
  const command = platform.createOtaJob({ deviceId: 'robot-arm-01', targetVersion: '0.2.0' });
  assert.equal(command.status, 'queued');
  assert.equal(platform.getDevice('robot-arm-01').shadow.desired.firmwareVersion, '0.2.0');

  assert.equal(platform.acknowledgeCommand(command.id).status, 'acknowledged');
  assert.equal(platform.updateCommandProgress(command.id, 50, 'installing').progress, 50);
  const complete = platform.updateCommandProgress(command.id, 100, 'success');
  assert.equal(complete.status, 'success');
  assert.equal(platform.getDevice('robot-arm-01').firmwareVersion, '0.2.0');
});

test('acknowledging an alert records the operator', () => {
  const platform = createPlatform();
  const alert = platform.ingestTelemetry({ deviceId: 'robot-arm-01', metrics: { vibrationMmS: 8.2 } }).alerts[0];
  const acknowledged = platform.acknowledgeAlert(alert.id, 'li-zhuolin');
  assert.equal(acknowledged.status, 'acknowledged');
  assert.equal(acknowledged.acknowledgedBy, 'li-zhuolin');
});

test('event history captures command and alert lifecycle events', () => {
  const platform = createPlatform();
  const command = platform.createOtaJob({ deviceId: 'robot-arm-01', targetVersion: '0.2.0' });
  platform.acknowledgeCommand(command.id);
  platform.ingestTelemetry({ deviceId: 'robot-arm-01', metrics: { temperatureC: 70 } });

  const eventTypes = platform.listEvents().map((event) => event.type);
  assert.deepEqual(eventTypes, ['telemetry.updated', 'alert.created', 'command.updated', 'command.created']);
});
