const test = require('node:test');
const assert = require('node:assert/strict');
const { CloudEdgePlatform, DomainError } = require('../server/domain/platform');

function createClock(initial = '2026-08-12T10:00:00.000Z') {
  let current = new Date(initial).getTime();
  return {
    now: () => new Date(current),
    advance: (milliseconds) => { current += milliseconds; },
  };
}

function createPlatform(options = {}) {
  const clock = options.clock || createClock();
  return {
    clock,
    platform: new CloudEdgePlatform({
      now: clock.now,
      offlineAfterMs: options.offlineAfterMs || 5_000,
      repository: options.repository,
    }),
  };
}

function assertConflict(callback, code = 'INVALID_STATE_TRANSITION') {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, code);
    return true;
  });
}

test('telemetry updates the device shadow and creates threshold alerts', () => {
  const { platform } = createPlatform();
  const result = platform.ingestTelemetry({
    deviceId: 'robot-arm-01',
    metrics: { temperatureC: 71, vibrationMmS: 8.2, batteryPct: 80, motorRpm: 1200 },
    reportedState: { firmwareVersion: '0.1.0', mode: 'manual' },
  });

  assert.equal(result.alerts.length, 2);
  const device = platform.getDevice('robot-arm-01');
  assert.equal(device.status, 'online');
  assert.equal(device.latestTelemetry.metrics.temperatureC, 71);
  assert.equal(device.shadow.reported.mode, 'manual');
});

test('active alerts are deduplicated and resolved rules create a new alert', () => {
  const { platform, clock } = createPlatform();
  const first = platform.ingestTelemetry({ deviceId: 'robot-arm-01', metrics: { temperatureC: 71 } }).alerts[0];
  clock.advance(1_000);
  platform.ingestTelemetry({ deviceId: 'robot-arm-01', metrics: { temperatureC: 72 } });

  assert.equal(platform.listAlerts().length, 1);
  assert.equal(platform.listAlerts()[0].evidence.value, 72);

  const acknowledged = platform.acknowledgeAlert(first.id, 'operator-a');
  assert.equal(acknowledged.status, 'acknowledged');
  assert.equal(acknowledged.acknowledgedBy, 'operator-a');
  const updateEventsBeforeRetry = platform.listEvents(200).filter((event) => event.type === 'alert.updated').length;
  platform.acknowledgeAlert(first.id, 'operator-a');
  assert.equal(platform.listEvents(200).filter((event) => event.type === 'alert.updated').length, updateEventsBeforeRetry);

  const resolved = platform.resolveAlert(first.id, 'operator-b', 'Temperature verified normal');
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolvedBy, 'operator-b');
  assert.equal(resolved.resolutionReason, 'Temperature verified normal');
  platform.resolveAlert(first.id, 'operator-b', 'Temperature verified normal');

  clock.advance(1_000);
  const retriggered = platform.ingestTelemetry({ deviceId: 'robot-arm-01', metrics: { temperatureC: 73 } }).alerts[0];
  assert.notEqual(retriggered.id, first.id);
  assert.equal(platform.listAlerts().length, 2);
});

test('vibration alerts deduplicate and require acknowledgement before resolution', () => {
  const { platform } = createPlatform();
  const alert = platform.ingestTelemetry({ deviceId: 'robot-arm-01', metrics: { vibrationMmS: 8.2 } }).alerts[0];
  assertConflict(
    () => platform.resolveAlert(alert.id, 'operator', 'Checked'),
    'ALERT_STATE_CONFLICT',
  );
  platform.ingestTelemetry({ deviceId: 'robot-arm-01', metrics: { vibrationMmS: 8.6 } });
  assert.equal(platform.listAlerts().length, 1);
  assert.equal(platform.listAlerts()[0].evidence.value, 8.6);
  assert.equal(platform.acknowledgeAlert(alert.id, 'operator').status, 'acknowledged');
  assert.equal(platform.resolveAlert(alert.id, 'operator', 'Bearing inspected').status, 'resolved');
});

test('OTA follows the complete state machine and identical retries are idempotent', () => {
  const { platform } = createPlatform();
  const command = platform.createOtaJob({
    deviceId: 'robot-arm-01',
    targetVersion: '0.2.0',
    requestId: 'release-0.2.0',
  });
  const duplicate = platform.createOtaJob({
    deviceId: 'robot-arm-01',
    targetVersion: '0.2.0',
    requestId: 'release-0.2.0',
  });
  assert.equal(duplicate.id, command.id);
  assert.equal(platform.listCommands().length, 1);
  assertConflict(
    () => platform.createOtaJob({
      deviceId: 'robot-arm-01',
      targetVersion: '9.9.9',
      requestId: 'release-0.2.0',
    }),
    'IDEMPOTENCY_KEY_REUSE',
  );
  assertConflict(
    () => platform.createOtaJob({
      deviceId: 'robot-arm-01',
      targetVersion: '0.3.0',
      requestId: 'release-0.3.0',
    }),
    'OTA_ALREADY_ACTIVE',
  );

  platform.acknowledgeCommand(command.id);
  platform.acknowledgeCommand(command.id);
  platform.updateCommandProgress(command.id, 25, 'downloading');
  platform.updateCommandProgress(command.id, 25, 'downloading');
  platform.updateCommandProgress(command.id, 50, 'installing');
  platform.updateCommandProgress(command.id, 75, 'installing');
  const complete = platform.updateCommandProgress(command.id, 100, 'success');
  platform.updateCommandProgress(command.id, 100, 'success');

  assert.equal(complete.status, 'success');
  assert.equal(complete.progress, 100);
  assert.deepEqual(complete.history.map((entry) => entry.status), [
    'queued',
    'acknowledged',
    'downloading',
    'installing',
    'installing',
    'success',
  ]);
  const device = platform.getDevice('robot-arm-01');
  assert.equal(device.firmwareVersion, '0.2.0');
  assert.equal(device.desiredFirmwareVersion, '0.2.0');
  assert.equal(device.shadow.reported.firmwareVersion, '0.2.0');
  assert.equal(device.shadow.desired.firmwareVersion, '0.2.0');
  assert.equal(device.pendingCommands.length, 0);
  assert.equal(device.commandHistory.length, 1);
});

test('OTA rejects skipped states, progress regression and premature success', () => {
  const { platform } = createPlatform();
  const command = platform.createOtaJob({ deviceId: 'robot-arm-01', targetVersion: '0.2.0' });
  platform.acknowledgeCommand(command.id);

  assertConflict(() => platform.updateCommandProgress(command.id, 50, 'installing'));
  platform.updateCommandProgress(command.id, 25, 'downloading');
  assertConflict(
    () => platform.updateCommandProgress(command.id, 10, 'downloading'),
    'COMMAND_PROGRESS_REGRESSION',
  );
  assertConflict(() => platform.updateCommandProgress(command.id, 100, 'success'));
  platform.updateCommandProgress(command.id, 50, 'installing');
  assertConflict(
    () => platform.updateCommandProgress(command.id, 99, 'success'),
    'COMMAND_PROGRESS_CONFLICT',
  );
});

test('failed is terminal and can only follow installing', () => {
  const { platform } = createPlatform();
  const command = platform.createOtaJob({ deviceId: 'robot-arm-01', targetVersion: '0.2.0' });
  platform.acknowledgeCommand(command.id);
  platform.updateCommandProgress(command.id, 25, 'downloading');
  assertConflict(() => platform.updateCommandProgress(command.id, 25, 'failed'));
  platform.updateCommandProgress(command.id, 50, 'installing');
  const failed = platform.updateCommandProgress(command.id, 60, 'failed');
  assert.equal(failed.status, 'failed');
  assert.ok(failed.completedAt);
  assertConflict(() => platform.updateCommandProgress(command.id, 100, 'success'));
});

test('offline evaluation deduplicates alerts and telemetry automatically restores the device', () => {
  const { platform, clock } = createPlatform({ offlineAfterMs: 5_000 });
  platform.ingestTelemetry({ deviceId: 'robot-arm-01', metrics: { temperatureC: 42 } });
  clock.advance(4_999);
  assert.equal(platform.evaluateOfflineDevices().length, 0);
  clock.advance(1);

  const created = platform.evaluateOfflineDevices();
  assert.equal(created.length, 1);
  assert.equal(created[0].evidence.metric, 'connectivity');
  assert.equal(platform.getDevice('robot-arm-01').status, 'offline');
  assert.equal(platform.evaluateOfflineDevices().length, 0);
  assert.equal(platform.listAlerts().filter((alert) => alert.evidence.metric === 'connectivity').length, 1);
  assert.equal(platform.acknowledgeAlert(created[0].id, 'operator').status, 'acknowledged');

  clock.advance(1_000);
  platform.ingestTelemetry({ deviceId: 'robot-arm-01', metrics: { temperatureC: 43 } });
  const offlineAlert = platform.listAlerts().find((alert) => alert.evidence.metric === 'connectivity');
  assert.equal(platform.getDevice('robot-arm-01').status, 'online');
  assert.equal(offlineAlert.status, 'resolved');
  assert.equal(offlineAlert.resolvedBy, 'system');
  assert.equal(offlineAlert.resolutionReason, 'Device telemetry resumed');
});

test('liveness uses server receive time instead of the device timestamp', () => {
  const { platform, clock } = createPlatform({ offlineAfterMs: 5_000 });
  assert.equal(platform.getDevice('robot-arm-01').status, 'unknown');
  platform.ingestTelemetry({
    deviceId: 'robot-arm-01',
    timestamp: '2099-01-01T00:00:00.000Z',
    metrics: { temperatureC: 42 },
  });
  assert.equal(platform.getDevice('robot-arm-01').lastSeenAt, '2026-08-12T10:00:00.000Z');
  clock.advance(5_000);
  assert.equal(platform.evaluateOfflineDevices().length, 1);
  assert.equal(platform.getDevice('robot-arm-01').status, 'offline');
});

test('telemetry and OTA inputs reject invalid values', () => {
  const { platform } = createPlatform();
  assert.throws(
    () => platform.ingestTelemetry({ deviceId: 'robot-arm-01', metrics: { temperatureC: 'hot' } }),
    /finite number/,
  );
  assert.throws(
    () => platform.ingestTelemetry({ deviceId: 'robot-arm-01', metrics: {}, timestamp: 'not-a-date' }),
    /valid ISO date/,
  );
  assert.throws(
    () => platform.createOtaJob({ deviceId: 'missing', targetVersion: '0.2.0' }),
    (error) => error.statusCode === 404 && error.code === 'DEVICE_NOT_FOUND',
  );
  assert.throws(
    () => platform.createOtaJob({
      deviceId: 'robot-arm-01',
      targetVersion: '0.2.0',
      artifactUrl: 'file:///firmware.bin',
    }),
    /HTTP or HTTPS URL/,
  );
  const command = platform.createOtaJob({ deviceId: 'robot-arm-01', targetVersion: '0.2.0' });
  platform.acknowledgeCommand(command.id);
  assert.throws(
    () => platform.updateCommandProgress(command.id, null, 'downloading'),
    /progress must be a number/,
  );
});

test('event history captures device, alert and command lifecycle events', () => {
  const { platform } = createPlatform();
  const command = platform.createOtaJob({ deviceId: 'robot-arm-01', targetVersion: '0.2.0' });
  platform.acknowledgeCommand(command.id);
  platform.ingestTelemetry({ deviceId: 'robot-arm-01', metrics: { temperatureC: 70 } });

  const eventTypes = platform.listEvents().map((event) => event.type);
  assert.deepEqual(eventTypes, [
    'telemetry.updated',
    'alert.created',
    'device.updated',
    'command.updated',
    'device.updated',
    'command.created',
  ]);
});
