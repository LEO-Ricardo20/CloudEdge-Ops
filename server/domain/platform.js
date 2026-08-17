const crypto = require('node:crypto');

const DEFAULT_DEVICE = {
  id: 'robot-arm-01',
  name: 'Robot Arm 01',
  type: 'Six-axis robot arm',
  firmwareVersion: '0.1.0',
  desiredFirmwareVersion: '0.1.0',
  status: 'online',
  lastSeenAt: null,
  shadow: {
    reported: { mode: 'auto', firmwareVersion: '0.1.0' },
    desired: { mode: 'auto', firmwareVersion: '0.1.0' },
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

class CloudEdgePlatform {
  constructor(options = {}) {
    this.now = options.now || (() => new Date());
    this.devices = new Map();
    this.telemetry = new Map();
    this.alerts = new Map();
    this.commands = new Map();
    this.eventLog = [];
    this.listeners = new Set();
    this.alertRules = {
      temperatureC: { threshold: 65, severity: 'critical', title: 'High temperature' },
      vibrationMmS: { threshold: 7.5, severity: 'warning', title: 'High vibration' },
    };

    this.registerDevice(options.seedDevice || DEFAULT_DEVICE);
  }

  registerDevice(device) {
    const current = this.devices.get(device.id);
    const next = {
      ...DEFAULT_DEVICE,
      ...clone(device),
      shadow: {
        reported: { ...DEFAULT_DEVICE.shadow.reported, ...(current?.shadow?.reported || {}), ...(device.shadow?.reported || {}) },
        desired: { ...DEFAULT_DEVICE.shadow.desired, ...(current?.shadow?.desired || {}), ...(device.shadow?.desired || {}) },
      },
    };
    this.devices.set(next.id, next);
    if (!this.telemetry.has(next.id)) this.telemetry.set(next.id, []);
    return clone(next);
  }

  listDevices() {
    return [...this.devices.values()]
      .map((device) => ({ ...clone(device), latestTelemetry: this.latestTelemetry(device.id) }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  getDevice(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) return null;
    return {
      ...clone(device),
      latestTelemetry: this.latestTelemetry(deviceId),
      recentTelemetry: this.getTelemetry(deviceId, 80),
      pendingCommands: this.listCommands(deviceId, ['queued', 'acknowledged']),
    };
  }

  ingestTelemetry(input) {
    if (!input?.deviceId) throw new Error('deviceId is required');
    if (!input.metrics || typeof input.metrics !== 'object') throw new Error('metrics is required');

    const device = this.devices.get(input.deviceId) || this.registerDevice({
      id: input.deviceId,
      name: input.deviceId,
      type: 'Unclassified edge device',
      status: 'online',
    });
    const timestamp = input.timestamp || this.now().toISOString();
    const event = {
      id: createId('tel'),
      deviceId: device.id,
      timestamp,
      metrics: clone(input.metrics),
      reportedState: clone(input.reportedState || {}),
    };
    const history = this.telemetry.get(device.id) || [];
    history.push(event);
    if (history.length > 240) history.splice(0, history.length - 240);
    this.telemetry.set(device.id, history);

    const storedDevice = this.devices.get(device.id);
    storedDevice.status = 'online';
    storedDevice.lastSeenAt = timestamp;
    storedDevice.shadow.reported = { ...storedDevice.shadow.reported, ...event.reportedState };
    if (event.reportedState.firmwareVersion) storedDevice.firmwareVersion = event.reportedState.firmwareVersion;

    const createdAlerts = this.evaluateTelemetryRules(event);
    this.emit('telemetry.updated', { telemetry: event, device: this.getDevice(device.id) });
    return { telemetry: clone(event), alerts: createdAlerts };
  }

  getTelemetry(deviceId, limit = 60) {
    return clone((this.telemetry.get(deviceId) || []).slice(-Math.max(1, Math.min(limit, 240))));
  }

  latestTelemetry(deviceId) {
    const history = this.telemetry.get(deviceId) || [];
    return history.length ? clone(history[history.length - 1]) : null;
  }

  listAlerts(status) {
    return [...this.alerts.values()]
      .filter((alert) => !status || alert.status === status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(clone);
  }

  listEvents(limit = 40) {
    return clone(this.eventLog.slice(-Math.max(1, Math.min(limit, 200))).reverse());
  }

  acknowledgeAlert(alertId, actor = 'operator') {
    const alert = this.alerts.get(alertId);
    if (!alert) return null;
    if (alert.status === 'open') {
      alert.status = 'acknowledged';
      alert.acknowledgedAt = this.now().toISOString();
      alert.acknowledgedBy = actor;
      this.emit('alert.updated', { alert: clone(alert) });
    }
    return clone(alert);
  }

  createOtaJob({ deviceId, targetVersion, artifactUrl, checksum }) {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error('device not found');
    if (!targetVersion) throw new Error('targetVersion is required');

    const command = {
      id: createId('cmd'),
      type: 'ota',
      deviceId,
      payload: {
        targetVersion,
        artifactUrl: artifactUrl || 'https://example.invalid/firmware.bin',
        checksum: checksum || 'demo-checksum',
      },
      status: 'queued',
      progress: 0,
      createdAt: this.now().toISOString(),
      acknowledgedAt: null,
      completedAt: null,
      history: [{ status: 'queued', progress: 0, at: this.now().toISOString() }],
    };
    this.commands.set(command.id, command);
    device.desiredFirmwareVersion = targetVersion;
    device.shadow.desired.firmwareVersion = targetVersion;
    this.emit('command.created', { command: clone(command), device: this.getDevice(deviceId) });
    return clone(command);
  }

  listCommands(deviceId, statuses) {
    const allowedStatuses = statuses ? new Set(statuses) : null;
    return [...this.commands.values()]
      .filter((command) => !deviceId || command.deviceId === deviceId)
      .filter((command) => !allowedStatuses || allowedStatuses.has(command.status))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(clone);
  }

  acknowledgeCommand(commandId) {
    const command = this.commands.get(commandId);
    if (!command) return null;
    if (command.status === 'queued') this.updateCommand(command, 'acknowledged', 0);
    return clone(command);
  }

  updateCommandProgress(commandId, progress, status) {
    const command = this.commands.get(commandId);
    if (!command) return null;
    const normalizedProgress = Math.max(0, Math.min(100, Number(progress) || 0));
    const nextStatus = status || (normalizedProgress >= 100 ? 'success' : 'installing');
    this.updateCommand(command, nextStatus, normalizedProgress);

    if (nextStatus === 'success') {
      const device = this.devices.get(command.deviceId);
      device.firmwareVersion = command.payload.targetVersion;
      device.shadow.reported.firmwareVersion = command.payload.targetVersion;
    }
    return clone(command);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  evaluateTelemetryRules(event) {
    const created = [];
    for (const [metric, rule] of Object.entries(this.alertRules)) {
      const value = Number(event.metrics[metric]);
      if (Number.isNaN(value) || value <= rule.threshold) continue;
      const existing = this.findOpenAlert(event.deviceId, metric);
      if (existing) {
        existing.evidence = { metric, value, threshold: rule.threshold, observedAt: event.timestamp };
        this.emit('alert.updated', { alert: clone(existing) });
        continue;
      }
      const alert = {
        id: createId('alert'),
        deviceId: event.deviceId,
        title: rule.title,
        severity: rule.severity,
        status: 'open',
        createdAt: this.now().toISOString(),
        evidence: { metric, value, threshold: rule.threshold, observedAt: event.timestamp },
      };
      this.alerts.set(alert.id, alert);
      created.push(clone(alert));
      this.emit('alert.created', { alert: clone(alert) });
    }
    return created;
  }

  findOpenAlert(deviceId, metric) {
    return [...this.alerts.values()].find((alert) =>
      alert.deviceId === deviceId && alert.status !== 'resolved' && alert.evidence.metric === metric,
    );
  }

  updateCommand(command, status, progress) {
    if (command.status === 'success' || command.status === 'failed') return;
    command.status = status;
    command.progress = progress;
    const at = this.now().toISOString();
    if (status === 'acknowledged' && !command.acknowledgedAt) command.acknowledgedAt = at;
    if ((status === 'success' || status === 'failed') && !command.completedAt) command.completedAt = at;
    command.history.push({ status, progress, at });
    this.emit('command.updated', { command: clone(command), device: this.getDevice(command.deviceId) });
  }

  emit(type, payload) {
    const event = { type, occurredAt: this.now().toISOString(), ...payload };
    this.eventLog.push(event);
    if (this.eventLog.length > 200) this.eventLog.splice(0, this.eventLog.length - 200);
    for (const listener of this.listeners) listener(event);
  }
}

module.exports = { CloudEdgePlatform, DEFAULT_DEVICE };
