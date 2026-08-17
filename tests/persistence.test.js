const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { CloudEdgePlatform } = require('../server/domain/platform');
const { JsonFileRepository } = require('../server/persistence/json-file-repository');

test('JSON repository restores devices, telemetry, alerts, commands and events after restart', (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudedge-state-'));
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const stateFile = path.join(temporaryDirectory, 'platform-state.json');
  const repository = new JsonFileRepository(stateFile);
  const now = () => new Date('2026-08-12T10:00:00.000Z');
  const platform = new CloudEdgePlatform({ repository, now });

  const alert = platform.ingestTelemetry({
    deviceId: 'robot-arm-01',
    metrics: { temperatureC: 72, vibrationMmS: 2.1 },
    reportedState: { mode: 'manual' },
  }).alerts[0];
  platform.acknowledgeAlert(alert.id, 'operator');
  platform.resolveAlert(alert.id, 'operator', 'Inspection complete');
  const command = platform.createOtaJob({
    deviceId: 'robot-arm-01',
    targetVersion: '0.2.0',
    requestId: 'persisted-release',
  });
  platform.acknowledgeCommand(command.id);
  platform.updateCommandProgress(command.id, 25, 'downloading');
  platform.updateCommandProgress(command.id, 50, 'installing');
  platform.updateCommandProgress(command.id, 100, 'success');

  assert.ok(fs.existsSync(stateFile));
  const storedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const storedTelemetryEvent = storedState.eventLog.find((event) => event.type === 'telemetry.updated');
  assert.equal(storedTelemetryEvent.device.recentTelemetry, undefined);
  assert.equal(storedTelemetryEvent.device.commandHistory, undefined);
  const restored = new CloudEdgePlatform({ repository: new JsonFileRepository(stateFile), now });
  const device = restored.getDevice('robot-arm-01');
  assert.equal(device.recentTelemetry.length, 1);
  assert.equal(device.shadow.reported.mode, 'manual');
  assert.equal(device.firmwareVersion, '0.2.0');
  assert.equal(device.commandHistory[0].status, 'success');
  assert.equal(device.commandHistory[0].requestId, 'persisted-release');
  assert.equal(restored.listAlerts()[0].status, 'resolved');
  assert.equal(restored.listAlerts()[0].resolutionReason, 'Inspection complete');
  assert.ok(restored.listEvents(200).some((event) => event.type === 'command.updated'));
});

test('JSON repository reports corrupt persisted state instead of silently discarding it', (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudedge-state-'));
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const stateFile = path.join(temporaryDirectory, 'platform-state.json');
  fs.writeFileSync(stateFile, '{broken', 'utf8');
  const repository = new JsonFileRepository(stateFile);
  assert.throws(() => repository.load(), /Invalid JSON in platform state file/);
});

test('platform rejects incompatible or semantically invalid snapshots at startup', () => {
  const incompatible = {
    load: () => ({ version: 999, devices: [], telemetry: [], alerts: [], commands: [], eventLog: [] }),
    save: () => {},
  };
  assert.throws(
    () => new CloudEdgePlatform({ repository: incompatible }),
    /Unsupported or invalid persisted platform state version/,
  );

  const invalidAlert = {
    load: () => ({
      version: 1,
      devices: [{
        id: 'robot-arm-01',
        name: 'Robot Arm 01',
        type: 'robot',
        firmwareVersion: '0.1.0',
        desiredFirmwareVersion: '0.1.0',
        status: 'online',
        lastSeenAt: '2026-08-12T10:00:00.000Z',
        shadow: { reported: {}, desired: {} },
      }],
      telemetry: [['robot-arm-01', []]],
      alerts: [{ id: 'alert_bad', deviceId: 'robot-arm-01', status: 'open' }],
      commands: [],
      eventLog: [],
    }),
    save: () => {},
  };
  assert.throws(
    () => new CloudEdgePlatform({ repository: invalidAlert }),
    /Invalid persisted platform state: invalid alert/,
  );
});

test('a failed persistence write rolls back the in-memory mutation', () => {
  let saveCount = 0;
  const repository = {
    load: () => null,
    save: () => {
      saveCount += 1;
      if (saveCount === 2) {
        const error = new Error('disk full');
        error.code = 'ENOSPC';
        throw error;
      }
    },
  };
  const platform = new CloudEdgePlatform({ repository });
  const request = { deviceId: 'robot-arm-01', targetVersion: '0.2.0', requestId: 'rollback-release' };

  assert.throws(() => platform.createOtaJob(request), /disk full/);
  assert.equal(platform.listCommands().length, 0);
  assert.equal(platform.getDevice('robot-arm-01').shadow.desired.firmwareVersion, '0.1.0');

  const command = platform.createOtaJob(request);
  assert.equal(command.status, 'queued');
  assert.equal(platform.listCommands().length, 1);
});
