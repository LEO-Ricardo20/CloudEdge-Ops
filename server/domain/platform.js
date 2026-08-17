const crypto = require('node:crypto');

const ACTIVE_COMMAND_STATUSES = ['queued', 'acknowledged', 'downloading', 'installing'];
const TERMINAL_COMMAND_STATUSES = ['success', 'failed'];
const COMMAND_STATUSES = [...ACTIVE_COMMAND_STATUSES, ...TERMINAL_COMMAND_STATUSES];
const ALERT_STATUSES = ['open', 'acknowledged', 'resolved'];
const DEFAULT_OFFLINE_AFTER_MS = 15_000;

const DEFAULT_DEVICE = {
  id: 'robot-arm-01',
  name: 'Robot Arm 01',
  type: 'Six-axis robot arm',
  firmwareVersion: '0.1.0',
  desiredFirmwareVersion: '0.1.0',
  status: 'unknown',
  lastSeenAt: null,
  shadow: {
    reported: { mode: 'auto', firmwareVersion: '0.1.0' },
    desired: { mode: 'auto', firmwareVersion: '0.1.0' },
  },
};

class DomainError extends Error {
  constructor(message, { statusCode = 400, code = 'DOMAIN_ERROR' } = {}) {
    super(message);
    this.name = 'DomainError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DomainError(`${fieldName} is required`, { code: 'VALIDATION_ERROR' });
  }
  return value.trim();
}

function optionalString(value, fieldName) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') {
    throw new DomainError(`${fieldName} must be a string`, { code: 'VALIDATION_ERROR' });
  }
  return value.trim() || null;
}

function optionalHttpUrl(value, fieldName) {
  const normalized = optionalString(value, fieldName);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
  } catch {
    throw new DomainError(`${fieldName} must be an HTTP or HTTPS URL`, { code: 'VALIDATION_ERROR' });
  }
  return normalized;
}

function conflict(message, code = 'INVALID_STATE_TRANSITION') {
  return new DomainError(message, { statusCode: 409, code });
}

function compactEvent(event) {
  const compact = { type: event.type, occurredAt: event.occurredAt };
  if (event.alert) compact.alert = clone(event.alert);
  if (event.command) compact.command = clone(event.command);
  if (event.telemetry) compact.telemetry = clone(event.telemetry);
  if (event.device) {
    const device = event.device;
    compact.device = clone({
      id: device.id,
      name: device.name,
      type: device.type,
      status: device.status,
      firmwareVersion: device.firmwareVersion,
      desiredFirmwareVersion: device.desiredFirmwareVersion,
      lastSeenAt: device.lastSeenAt,
      shadow: device.shadow,
    });
  }
  if (event.deviceId) compact.deviceId = event.deviceId;
  if (event.detail) compact.detail = event.detail;
  return compact;
}

function assertPersistedState(state) {
  if (!isPlainObject(state) || state.version !== 1) {
    throw new Error('Unsupported or invalid persisted platform state version');
  }
  for (const field of ['devices', 'telemetry', 'alerts', 'commands', 'eventLog']) {
    if (!Array.isArray(state[field])) throw new Error(`Invalid persisted platform state: ${field} must be an array`);
  }
  if (!state.devices.length) throw new Error('Persisted platform state has no devices');

  const deviceIds = new Set();
  for (const device of state.devices) {
    if (!isPlainObject(device) || typeof device.id !== 'string' || !device.id.trim()) {
      throw new Error('Invalid persisted platform state: device id is required');
    }
    if (!['online', 'offline', 'unknown'].includes(device.status)) {
      throw new Error(`Invalid persisted platform state: invalid device status for ${device.id}`);
    }
    if (!isPlainObject(device.shadow) || !isPlainObject(device.shadow.reported) || !isPlainObject(device.shadow.desired)) {
      throw new Error(`Invalid persisted platform state: invalid shadow for ${device.id}`);
    }
    deviceIds.add(device.id);
  }
  for (const entry of state.telemetry) {
    if (!Array.isArray(entry) || entry.length !== 2 || !deviceIds.has(entry[0]) || !Array.isArray(entry[1])) {
      throw new Error('Invalid persisted platform state: invalid telemetry entry');
    }
    for (const event of entry[1]) {
      if (!isPlainObject(event) || event.deviceId !== entry[0] || !isPlainObject(event.metrics)) {
        throw new Error(`Invalid persisted platform state: invalid telemetry for ${entry[0]}`);
      }
    }
  }
  for (const alert of state.alerts) {
    if (!isPlainObject(alert) || !alert.id || !deviceIds.has(alert.deviceId)
      || !ALERT_STATUSES.includes(alert.status) || !isPlainObject(alert.evidence)
      || typeof alert.evidence.metric !== 'string') {
      throw new Error('Invalid persisted platform state: invalid alert');
    }
  }
  for (const command of state.commands) {
    if (!isPlainObject(command) || !command.id || !deviceIds.has(command.deviceId)
      || !COMMAND_STATUSES.includes(command.status) || !isPlainObject(command.payload)
      || typeof command.payload.targetVersion !== 'string' || !Array.isArray(command.history)
      || typeof command.progress !== 'number' || !Number.isFinite(command.progress)) {
      throw new Error('Invalid persisted platform state: invalid command');
    }
    for (const entry of command.history) {
      if (!isPlainObject(entry) || !COMMAND_STATUSES.includes(entry.status)
        || typeof entry.progress !== 'number' || !Number.isFinite(entry.progress)) {
        throw new Error(`Invalid persisted platform state: invalid command history for ${command.id}`);
      }
    }
  }
  for (const event of state.eventLog) {
    if (!isPlainObject(event) || typeof event.type !== 'string' || typeof event.occurredAt !== 'string') {
      throw new Error('Invalid persisted platform state: invalid event');
    }
  }
}

class CloudEdgePlatform {
  constructor(options = {}) {
    this.now = options.now || (() => new Date());
    this.offlineAfterMs = Number.isFinite(options.offlineAfterMs) && options.offlineAfterMs > 0
      ? options.offlineAfterMs
      : DEFAULT_OFFLINE_AFTER_MS;
    this.repository = options.repository || null;
    this.devices = new Map();
    this.telemetry = new Map();
    this.alerts = new Map();
    this.commands = new Map();
    this.eventLog = [];
    this.listeners = new Set();
    this.transaction = null;
    this.alertRules = {
      temperatureC: { threshold: 65, severity: 'critical', title: 'High temperature' },
      vibrationMmS: { threshold: 7.5, severity: 'warning', title: 'High vibration' },
    };

    const restored = this.repository?.load?.();
    if (restored) {
      this.restoreState(restored);
    } else {
      this.registerDevice(options.seedDevice || DEFAULT_DEVICE, { emitEvent: false, persist: false });
      this.persist();
    }
  }

  registerDevice(device, options = {}) {
    if (!this.transaction && options.persist !== false) {
      return this.runMutation(() => this.registerDevice(device, options));
    }
    if (!isPlainObject(device)) {
      throw new DomainError('device is required', { code: 'VALIDATION_ERROR' });
    }
    const deviceId = requireNonEmptyString(device.id, 'device.id');
    const current = this.devices.get(deviceId);
    const next = {
      ...DEFAULT_DEVICE,
      ...(current ? clone(current) : {}),
      ...clone(device),
      id: deviceId,
      shadow: {
        reported: {
          ...DEFAULT_DEVICE.shadow.reported,
          ...(current?.shadow?.reported || {}),
          ...(device.shadow?.reported || {}),
        },
        desired: {
          ...DEFAULT_DEVICE.shadow.desired,
          ...(current?.shadow?.desired || {}),
          ...(device.shadow?.desired || {}),
        },
      },
    };
    this.devices.set(next.id, next);
    if (!this.telemetry.has(next.id)) this.telemetry.set(next.id, []);

    if (options.emitEvent !== false) {
      this.emit('device.updated', { device: this.getDevice(next.id) });
    }
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
      pendingCommands: this.listCommands(deviceId, ACTIVE_COMMAND_STATUSES),
      commandHistory: this.listCommands(deviceId),
    };
  }

  ingestTelemetry(input) {
    if (!this.transaction) return this.runMutation(() => this.ingestTelemetry(input));
    if (!isPlainObject(input)) {
      throw new DomainError('telemetry payload is required', { code: 'VALIDATION_ERROR' });
    }
    const deviceId = requireNonEmptyString(input.deviceId, 'deviceId');
    if (!isPlainObject(input.metrics)) {
      throw new DomainError('metrics is required', { code: 'VALIDATION_ERROR' });
    }
    for (const [metric, value] of Object.entries(input.metrics)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new DomainError(`metrics.${metric} must be a finite number`, { code: 'VALIDATION_ERROR' });
      }
    }
    if (input.reportedState != null && !isPlainObject(input.reportedState)) {
      throw new DomainError('reportedState must be an object', { code: 'VALIDATION_ERROR' });
    }

    const receivedAt = this.now().toISOString();
    const timestamp = input.timestamp == null
      ? receivedAt
      : this.validateTimestamp(input.timestamp);
    const wasKnown = this.devices.has(deviceId);
    const device = this.devices.get(deviceId) || this.registerDevice({
      id: deviceId,
      name: deviceId,
      type: 'Unclassified edge device',
      status: 'online',
    }, { emitEvent: false, persist: false });
    const storedDevice = this.devices.get(device.id);
    const wasUnavailable = storedDevice.status !== 'online';
    const event = {
      id: createId('tel'),
      deviceId: storedDevice.id,
      timestamp,
      receivedAt,
      metrics: clone(input.metrics),
      reportedState: clone(input.reportedState || {}),
    };
    const history = this.telemetry.get(storedDevice.id) || [];
    history.push(event);
    if (history.length > 240) history.splice(0, history.length - 240);
    this.telemetry.set(storedDevice.id, history);

    storedDevice.status = 'online';
    storedDevice.lastSeenAt = receivedAt;
    storedDevice.shadow.reported = { ...storedDevice.shadow.reported, ...event.reportedState };
    if (event.reportedState.firmwareVersion) {
      storedDevice.firmwareVersion = event.reportedState.firmwareVersion;
    }

    if (wasUnavailable) {
      const offlineAlert = this.findActiveAlert(storedDevice.id, 'connectivity');
      if (offlineAlert) {
        this.resolveAlertInternal(offlineAlert, 'system', 'Device telemetry resumed', true);
      }
      this.emit('device.updated', { device: this.getDevice(storedDevice.id) });
    } else if (!wasKnown) {
      this.emit('device.updated', { device: this.getDevice(storedDevice.id) });
    }

    const createdAlerts = this.evaluateTelemetryRules(event);
    this.emit('telemetry.updated', { telemetry: clone(event), device: this.getDevice(storedDevice.id) });
    return { telemetry: clone(event), alerts: createdAlerts };
  }

  getTelemetry(deviceId, limit = 60) {
    const normalizedLimit = Number.isFinite(Number(limit))
      ? Math.max(1, Math.min(Math.trunc(Number(limit)), 240))
      : 60;
    return clone((this.telemetry.get(deviceId) || []).slice(-normalizedLimit));
  }

  latestTelemetry(deviceId) {
    const history = this.telemetry.get(deviceId) || [];
    return history.length ? clone(history[history.length - 1]) : null;
  }

  listAlerts(status) {
    if (status && !ALERT_STATUSES.includes(status)) {
      throw new DomainError(`invalid alert status: ${status}`, { code: 'VALIDATION_ERROR' });
    }
    return [...this.alerts.values()]
      .filter((alert) => !status || alert.status === status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(clone);
  }

  listEvents(limit = 40) {
    const normalizedLimit = Number.isFinite(Number(limit))
      ? Math.max(1, Math.min(Math.trunc(Number(limit)), 200))
      : 40;
    return clone(this.eventLog.slice(-normalizedLimit).reverse());
  }

  acknowledgeAlert(alertId, actor = 'operator') {
    if (!this.transaction) return this.runMutation(() => this.acknowledgeAlert(alertId, actor));
    const alert = this.alerts.get(alertId);
    if (!alert) return null;
    const normalizedActor = requireNonEmptyString(actor, 'actor');
    if (alert.status === 'acknowledged') return clone(alert);
    if (alert.status !== 'open') {
      throw conflict(`cannot acknowledge alert in ${alert.status} state`, 'ALERT_STATE_CONFLICT');
    }

    alert.status = 'acknowledged';
    alert.acknowledgedAt = this.now().toISOString();
    alert.acknowledgedBy = normalizedActor;
    this.emit('alert.updated', { alert: clone(alert) });
    return clone(alert);
  }

  resolveAlert(alertId, actor = 'operator', reason = 'Resolved by operator') {
    if (!this.transaction) return this.runMutation(() => this.resolveAlert(alertId, actor, reason));
    const alert = this.alerts.get(alertId);
    if (!alert) return null;
    const normalizedActor = requireNonEmptyString(actor, 'actor');
    const normalizedReason = requireNonEmptyString(reason, 'reason');
    if (alert.status === 'resolved') return clone(alert);
    if (alert.status !== 'acknowledged') {
      throw conflict('alert must be acknowledged before it can be resolved', 'ALERT_STATE_CONFLICT');
    }
    return this.resolveAlertInternal(alert, normalizedActor, normalizedReason, false);
  }

  createOtaJob(input) {
    if (!this.transaction) return this.runMutation(() => this.createOtaJob(input));
    if (!isPlainObject(input)) {
      throw new DomainError('OTA job payload is required', { code: 'VALIDATION_ERROR' });
    }
    const deviceId = requireNonEmptyString(input.deviceId, 'deviceId');
    const targetVersion = requireNonEmptyString(input.targetVersion, 'targetVersion');
    const artifactUrl = optionalHttpUrl(input.artifactUrl, 'artifactUrl');
    const checksum = optionalString(input.checksum, 'checksum');
    const requestId = optionalString(input.requestId, 'requestId');
    const device = this.devices.get(deviceId);
    if (!device) {
      throw new DomainError('device not found', { statusCode: 404, code: 'DEVICE_NOT_FOUND' });
    }

    const payload = {
      targetVersion,
      artifactUrl: artifactUrl || 'https://example.invalid/firmware.bin',
      checksum: checksum || 'demo-checksum',
    };
    if (requestId) {
      const existing = [...this.commands.values()].find((command) => command.requestId === requestId);
      if (existing) {
        const sameRequest = existing.deviceId === deviceId
          && existing.type === 'ota'
          && JSON.stringify(existing.payload) === JSON.stringify(payload);
        if (!sameRequest) {
          throw conflict('requestId was already used for a different OTA request', 'IDEMPOTENCY_KEY_REUSE');
        }
        return clone(existing);
      }
    }
    const activeOta = [...this.commands.values()].find((command) =>
      command.deviceId === deviceId
      && command.type === 'ota'
      && ACTIVE_COMMAND_STATUSES.includes(command.status),
    );
    if (activeOta) {
      throw conflict(`device already has active OTA command ${activeOta.id}`, 'OTA_ALREADY_ACTIVE');
    }

    const createdAt = this.now().toISOString();
    const command = {
      id: createId('cmd'),
      requestId,
      type: 'ota',
      deviceId,
      payload,
      status: 'queued',
      progress: 0,
      createdAt,
      acknowledgedAt: null,
      completedAt: null,
      history: [{ status: 'queued', progress: 0, at: createdAt }],
    };
    this.commands.set(command.id, command);
    device.desiredFirmwareVersion = targetVersion;
    device.shadow.desired.firmwareVersion = targetVersion;
    this.emit('command.created', { command: clone(command), device: this.getDevice(deviceId) });
    this.emit('device.updated', { device: this.getDevice(deviceId) });
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
    if (!this.transaction) return this.runMutation(() => this.acknowledgeCommand(commandId));
    const command = this.commands.get(commandId);
    if (!command) return null;
    if (command.status === 'acknowledged') return clone(command);
    if (command.status !== 'queued') {
      throw conflict(`cannot acknowledge command in ${command.status} state`);
    }

    this.transitionCommand(command, 'acknowledged', 0);
    return clone(command);
  }

  updateCommandProgress(commandId, progress, status) {
    if (!this.transaction) {
      return this.runMutation(() => this.updateCommandProgress(commandId, progress, status));
    }
    const command = this.commands.get(commandId);
    if (!command) return null;
    if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 100) {
      throw new DomainError('progress must be a number between 0 and 100', { code: 'VALIDATION_ERROR' });
    }
    const normalizedProgress = progress;
    const nextStatus = status || this.inferCommandStatus(command.status, normalizedProgress);
    if (!COMMAND_STATUSES.includes(nextStatus) || nextStatus === 'queued' || nextStatus === 'acknowledged') {
      throw new DomainError(`invalid progress status: ${nextStatus}`, { code: 'VALIDATION_ERROR' });
    }

    this.transitionCommand(command, nextStatus, normalizedProgress);
    return clone(command);
  }

  evaluateOfflineDevices(referenceTime = this.now()) {
    if (!this.transaction) {
      return this.runMutation(() => this.evaluateOfflineDevices(referenceTime), { persistIfUnchanged: false });
    }
    const now = referenceTime instanceof Date ? referenceTime : new Date(referenceTime);
    if (Number.isNaN(now.getTime())) {
      throw new DomainError('referenceTime must be a valid date', { code: 'VALIDATION_ERROR' });
    }
    const created = [];
    for (const device of this.devices.values()) {
      if (!device.lastSeenAt) continue;
      const lastSeenAt = new Date(device.lastSeenAt);
      if (Number.isNaN(lastSeenAt.getTime()) || now.getTime() - lastSeenAt.getTime() < this.offlineAfterMs) continue;

      if (device.status !== 'offline') {
        device.status = 'offline';
        this.emit('device.updated', { device: this.getDevice(device.id) });
      }
      const existing = this.findActiveAlert(device.id, 'connectivity');
      if (existing) continue;

      const alert = this.createAlert({
        deviceId: device.id,
        title: 'Device offline',
        severity: 'critical',
        evidence: {
          metric: 'connectivity',
          value: 'offline',
          threshold: this.offlineAfterMs,
          thresholdUnit: 'ms',
          lastSeenAt: device.lastSeenAt,
          observedAt: now.toISOString(),
        },
      });
      created.push(alert);
    }
    return created;
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  evaluateTelemetryRules(event) {
    const created = [];
    for (const [metric, rule] of Object.entries(this.alertRules)) {
      const value = Number(event.metrics[metric]);
      if (Number.isNaN(value) || value <= rule.threshold) continue;
      const existing = this.findActiveAlert(event.deviceId, metric);
      if (existing) {
        const evidence = { metric, value, threshold: rule.threshold, observedAt: event.timestamp };
        if (JSON.stringify(existing.evidence) !== JSON.stringify(evidence)) {
          existing.evidence = evidence;
          this.emit('alert.updated', { alert: clone(existing) });
        }
        continue;
      }
      created.push(this.createAlert({
        deviceId: event.deviceId,
        title: rule.title,
        severity: rule.severity,
        evidence: { metric, value, threshold: rule.threshold, observedAt: event.timestamp },
      }));
    }
    return created;
  }

  findActiveAlert(deviceId, metric) {
    return [...this.alerts.values()].find((alert) =>
      alert.deviceId === deviceId && alert.status !== 'resolved' && alert.evidence.metric === metric,
    );
  }

  createAlert({ deviceId, title, severity, evidence }) {
    const alert = {
      id: createId('alert'),
      deviceId,
      title,
      severity,
      status: 'open',
      createdAt: this.now().toISOString(),
      acknowledgedAt: null,
      acknowledgedBy: null,
      resolvedAt: null,
      resolvedBy: null,
      resolutionReason: null,
      evidence: clone(evidence),
    };
    this.alerts.set(alert.id, alert);
    this.emit('alert.created', { alert: clone(alert) });
    return clone(alert);
  }

  resolveAlertInternal(alert, actor, reason, allowOpen) {
    if (alert.status === 'resolved') return clone(alert);
    if (alert.status === 'open' && !allowOpen) {
      throw conflict('alert must be acknowledged before it can be resolved', 'ALERT_STATE_CONFLICT');
    }
    alert.status = 'resolved';
    alert.resolvedAt = this.now().toISOString();
    alert.resolvedBy = actor;
    alert.resolutionReason = reason;
    this.emit('alert.updated', { alert: clone(alert) });
    return clone(alert);
  }

  inferCommandStatus(currentStatus, progress) {
    if (progress === 100) return 'success';
    if (currentStatus === 'acknowledged') return 'downloading';
    if (currentStatus === 'downloading' || currentStatus === 'installing') return currentStatus;
    return currentStatus;
  }

  transitionCommand(command, nextStatus, progress) {
    if (command.status === nextStatus && command.progress === progress) return false;
    if (TERMINAL_COMMAND_STATUSES.includes(command.status)) {
      throw conflict(`command is already ${command.status}`);
    }
    if (progress < command.progress) {
      throw conflict(`command progress cannot regress from ${command.progress} to ${progress}`, 'COMMAND_PROGRESS_REGRESSION');
    }

    const allowedNext = {
      queued: ['acknowledged'],
      acknowledged: ['downloading'],
      downloading: ['downloading', 'installing'],
      installing: ['installing', 'success', 'failed'],
    }[command.status] || [];
    if (!allowedNext.includes(nextStatus)) {
      throw conflict(`cannot transition command from ${command.status} to ${nextStatus}`);
    }
    if (nextStatus === 'success' && progress !== 100) {
      throw conflict('successful command must report 100% progress', 'COMMAND_PROGRESS_CONFLICT');
    }

    command.status = nextStatus;
    command.progress = progress;
    const at = this.now().toISOString();
    if (nextStatus === 'acknowledged' && !command.acknowledgedAt) command.acknowledgedAt = at;
    if (TERMINAL_COMMAND_STATUSES.includes(nextStatus) && !command.completedAt) command.completedAt = at;
    command.history.push({ status: nextStatus, progress, at });

    if (nextStatus === 'success') {
      const device = this.devices.get(command.deviceId);
      device.firmwareVersion = command.payload.targetVersion;
      device.desiredFirmwareVersion = command.payload.targetVersion;
      device.shadow.reported.firmwareVersion = command.payload.targetVersion;
      device.shadow.desired.firmwareVersion = command.payload.targetVersion;
    }

    this.emit('command.updated', { command: clone(command), device: this.getDevice(command.deviceId) });
    if (nextStatus === 'success') {
      this.emit('device.updated', { device: this.getDevice(command.deviceId) });
    }
    return true;
  }

  validateTimestamp(value) {
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
      throw new DomainError('timestamp must be a valid ISO date string', { code: 'VALIDATION_ERROR' });
    }
    return new Date(value).toISOString();
  }

  restoreState(state) {
    assertPersistedState(state);
    const { devices, telemetry, alerts, commands, eventLog } = state;
    this.devices.clear();
    this.telemetry.clear();
    this.alerts.clear();
    this.commands.clear();
    this.eventLog = [];

    for (const device of devices) {
      const restoredDevice = clone(device);
      if (!restoredDevice.lastSeenAt && restoredDevice.status === 'online') restoredDevice.status = 'unknown';
      this.registerDevice(restoredDevice, { emitEvent: false, persist: false });
    }
    for (const entry of telemetry) {
      if (Array.isArray(entry) && entry.length === 2 && Array.isArray(entry[1])) {
        this.telemetry.set(entry[0], clone(entry[1]).slice(-240));
      }
    }
    for (const alert of alerts) {
      if (alert?.id) this.alerts.set(alert.id, clone(alert));
    }
    for (const command of commands) {
      if (command?.id) this.commands.set(command.id, clone(command));
    }
    this.eventLog = clone(eventLog).slice(-200).map(compactEvent);
  }

  snapshot() {
    return {
      version: 1,
      devices: clone([...this.devices.values()]),
      telemetry: clone([...this.telemetry.entries()]),
      alerts: clone([...this.alerts.values()]),
      commands: clone([...this.commands.values()]),
      eventLog: clone(this.eventLog),
    };
  }

  persist() {
    if (this.repository?.save) this.repository.save(this.snapshot());
  }

  runMutation(callback, { persistIfUnchanged = true } = {}) {
    const before = this.snapshot();
    this.transaction = { dirty: false, events: [] };
    try {
      const result = callback();
      const transaction = this.transaction;
      if (transaction.dirty || persistIfUnchanged) this.persist();
      this.transaction = null;
      for (const event of transaction.events) this.notify(event);
      return result;
    } catch (error) {
      this.transaction = null;
      this.restoreState(before);
      throw error;
    }
  }

  notify(event) {
    for (const listener of this.listeners) {
      try {
        listener(clone(event));
      } catch {
        // Subscribers must not be able to roll back a completed domain mutation.
      }
    }
  }

  emit(type, payload) {
    const event = { type, occurredAt: this.now().toISOString(), ...clone(payload) };
    this.eventLog.push(compactEvent(event));
    if (this.eventLog.length > 200) this.eventLog.splice(0, this.eventLog.length - 200);
    if (this.transaction) {
      this.transaction.dirty = true;
      this.transaction.events.push(event);
      return;
    }
    this.persist();
    this.notify(event);
  }
}

module.exports = {
  ACTIVE_COMMAND_STATUSES,
  ALERT_STATUSES,
  CloudEdgePlatform,
  COMMAND_STATUSES,
  DEFAULT_DEVICE,
  DEFAULT_OFFLINE_AFTER_MS,
  DomainError,
};
