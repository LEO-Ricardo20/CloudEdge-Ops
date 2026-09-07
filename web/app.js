const state = {
  devices: [],
  selectedDeviceId: null,
  device: null,
  alerts: [],
  events: [],
  health: null,
  metrics: null,
  credentials: { operatorToken: '', deviceToken: '' },
  alertStatus: 'all',
  alertSeverity: 'all',
  search: '',
  deviceStatus: 'all',
  telemetryMetric: 'temperatureC',
  resolvingAlertId: null,
  loading: true,
  detailLoading: false,
  busy: new Set(),
  loadSequence: 0,
  refreshTimer: null,
  eventSource: null,
  authSequence: 0,
  commandDisclosure: new Map(),
  pendingOtaRequest: null,
};

const metricDefinitions = CloudEdgeOperations.metrics;

const statusLabels = {
  online: '在线',
  offline: '上报超时',
  unknown: '尚未上报',
  open: '待确认',
  acknowledged: '已确认',
  resolved: '已关闭',
  queued: '排队中',
  downloading: '下载中',
  installing: '安装中',
  success: '成功',
  failed: '失败',
  expired: '已过期',
  cancelled: '已取消',
};

const terminalCommandStatuses = new Set(['success', 'failed', 'expired', 'cancelled']);
const eventTypes = [
  'telemetry.updated',
  'device.updated',
  'alert.created',
  'alert.updated',
  'command.created',
  'command.updated',
];

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function query(selector) {
  return document.querySelector(selector);
}

function createElement(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function createSvgElement(tagName, attributes = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tagName);
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
  return node;
}

function replaceChildren(container, children) {
  container.replaceChildren(...children.filter(Boolean));
}

function focusKey(node) {
  return node instanceof HTMLElement ? node.dataset.focusKey || null : null;
}

function findFocusTarget(key) {
  if (!key) return null;
  return [...document.querySelectorAll('[data-focus-key]')]
    .find((node) => node.dataset.focusKey === key) || null;
}

function captureInteractionState() {
  query('#commands')?.querySelectorAll('details[data-command-id]').forEach((details) => {
    state.commandDisclosure.set(details.dataset.commandId, details.open);
  });
  return focusKey(document.activeElement);
}

function restoreInteractionState(key) {
  const target = findFocusTarget(key);
  if (target && !target.disabled) target.focus({ preventScroll: true });
}

function statusLabel(status) {
  const normalized = String(status || 'unknown').toLowerCase();
  return statusLabels[normalized] || normalized;
}

function statusClass(status) {
  const normalized = String(status || 'unknown').toLowerCase();
  const allowed = new Set([
    'online', 'offline', 'unknown', 'open', 'acknowledged', 'resolved',
    'queued', 'downloading', 'installing', 'success', 'failed', 'expired', 'cancelled',
  ]);
  return allowed.has(normalized) ? normalized : 'unknown';
}

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTime(value) {
  const date = validDate(value);
  return date ? dateTimeFormatter.format(date) : '-';
}

function formatRelativeTime(value) {
  const date = validDate(value);
  if (!date) return '从未上报';
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 10) return '刚刚';
  if (seconds < 60) return seconds + ' 秒前';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + ' 分钟前';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + ' 小时前';
  return Math.round(hours / 24) + ' 天前';
}

function formatMetric(metric, value) {
  if (value === null || value === undefined || value === '') return '-';
  const definition = metricDefinitions[metric];
  const numeric = Number(value);
  if (!definition || !Number.isFinite(numeric)) return String(value);
  return numeric.toFixed(definition.decimals) + ' ' + definition.unit;
}

function clampProgress(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function reportedFirmware(device) {
  return device?.shadow?.reported?.firmwareVersion || device?.firmwareVersion || '-';
}

function desiredFirmware(device) {
  return device?.shadow?.desired?.firmwareVersion || device?.desiredFirmwareVersion || '-';
}

function suggestedVersion(device) {
  const current = String(desiredFirmware(device) === '-' ? reportedFirmware(device) : desiredFirmware(device));
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) return '';
  return match[1] + '.' + (Number(match[2]) + 1) + '.0';
}

function currentDevice() {
  return state.device && state.device.id === state.selectedDeviceId ? state.device : null;
}

function deviceCommands(device = currentDevice()) {
  if (!device) return [];
  const sources = [device.commandHistory, device.activeCommands, device.pendingCommands];
  const byId = new Map();
  sources.forEach((source) => {
    if (!Array.isArray(source)) return;
    source.forEach((command) => {
      if (!command || !command.id) return;
      const previous = byId.get(command.id) || {};
      const history = Array.isArray(command.history) && command.history.length
        ? command.history
        : previous.history;
      byId.set(command.id, { ...previous, ...command, history: history || [] });
    });
  });
  return [...byId.values()].sort((left, right) => {
    const leftTime = validDate(left.createdAt)?.getTime() || 0;
    const rightTime = validDate(right.createdAt)?.getTime() || 0;
    return rightTime - leftTime;
  });
}

function activeOtaCommand(device = currentDevice()) {
  return deviceCommands(device).find((command) =>
    command.type === 'ota' && !terminalCommandStatuses.has(String(command.status).toLowerCase()),
  ) || null;
}

async function api(path, options = {}) {
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  const method = String(options.method || 'GET').toUpperCase();
  const isTelemetry = path === '/api/telemetry';
  const isDeviceCommand = /^\/api\/commands(?:\?|$)/.test(path) || /^\/api\/commands\/[^/]+\/(ack|progress)/.test(path);
  const token = isDeviceCommand || isTelemetry ? state.credentials.deviceToken : state.credentials.operatorToken;
  if (token && !headers.Authorization) headers.Authorization = 'Bearer ' + token;
  if (options.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { signal: AbortSignal.timeout(10_000), ...options, headers });
  const text = await response.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text };
    }
  }
  if (!response.ok) {
    const retryAfter = response.headers.get('Retry-After') || '';
    const error = new Error(apiErrorMessage(response.status, { ...body, retryAfter }));
    error.status = response.status;
    error.body = body;
    error.code = body.code || '';
    error.requestId = body.requestId || response.headers.get('X-Request-Id') || '';
    error.retryAfter = retryAfter;
    throw error;
  }
  return body;
}

function apiErrorMessage(status, body = {}) {
  const code = body.code || '';
  const messages = {
    AUTH_REQUIRED: '需要提供访问凭据。请在“连接与访问设置”中填写 Token。',
    FORBIDDEN: '当前凭据没有执行此操作的权限。',
    RATE_LIMITED: '请求过于频繁，请稍后再试。',
    COMMAND_EXPIRED: '该命令已经过期，无法继续执行。',
    IDEMPOTENCY_KEY_REUSE: '请求编号已被其他内容使用，请重新提交。',
    VALIDATION_ERROR: '请求参数无效。',
    PERSISTENCE_UNAVAILABLE: '持久化暂时不可用，请检查服务状态。',
  };
  const base = messages[code] || body.error || body.message || ('请求失败（' + status + '）');
  return status === 429 && body.retryAfter ? base + ' ' + body.retryAfter + ' 秒后重试。' : base;
}

function setPageError(message) {
  const container = query('#page-error');
  container.hidden = !message;
  container.textContent = message || '';
}

function renderPageState() {
  const status = query('#page-status');
  const summary = query('#summary');
  summary.setAttribute('aria-busy', state.loading ? 'true' : 'false');
  if (state.loading) {
    status.hidden = false;
    status.textContent = '正在加载运行数据...';
  } else if (!state.devices.length) {
    status.hidden = false;
    status.textContent = '尚未注册设备。';
  } else {
    status.hidden = true;
    status.textContent = '';
  }
}

function renderHealth() {
  const panel = query('#health-panel');
  const badge = query('#health-status');
  const details = query('#health-details');
  const health = state.health;
  if (!health) {
    badge.className = 'status compact unknown';
    badge.textContent = state.loading ? '检测中' : '不可用';
    details.replaceChildren(createElement('span', '', state.loading ? '正在检测 API、持久化和数据版本...' : '无法读取服务健康状态。'));
    return;
  }
  const status = String(health.status || (health.ok ? 'ok' : 'unknown')).toLowerCase();
  const healthy = status === 'ok' || status === 'healthy';
  badge.className = 'status compact ' + (healthy ? 'online' : 'offline');
  badge.textContent = healthy ? '服务正常' : '需要检查';
  const items = [
    ['API', healthy ? '可用' : '异常'],
    ['持久化', health.persistence || '未知'],
    ['数据版本', health.schemaVersion ?? '-'],
  ];
  if (health.recovery) items.push(['恢复来源', '备份 #' + (health.recovery.backupIndex || '?')]);
  details.replaceChildren(...items.map(([label, value]) => {
    const item = createElement('span', 'health-item');
    item.append(createElement('strong', '', label), createElement('span', '', value));
    return item;
  }));
  const authMode = query('#auth-mode');
  const accessPanel = query('#access-panel');
  if (authMode && accessPanel) {
    const protectedMode = health.authMode === 'protected';
    authMode.className = 'status compact ' + (protectedMode ? 'acknowledged' : 'online');
    authMode.textContent = protectedMode ? '受保护模式' : '演示模式';
    accessPanel.hidden = !protectedMode;
  }
}

function renderMetrics() {
  const metrics = state.metrics;
  if (!metrics) return;
  const detail = query('#health-details');
  const existing = detail.querySelector('.health-metrics');
  if (existing) existing.remove();
  const item = createElement('span', 'health-metrics');
  item.textContent = '请求 ' + (metrics.requests ?? '-') + ' · 错误 ' + (metrics.errors ?? '-') + ' · 限流 ' + (metrics.rateLimited ?? '-');
  detail.append(item);
}

function renderSummary() {
  const selected = currentDevice();
  const unresolvedAlerts = state.alerts.filter((alert) => alert.status !== 'resolved').length;
  const offlineDevices = state.devices.filter((device) => device.status === 'offline').length;
  const unknownDevices = state.devices.filter((device) => device.status === 'unknown').length;
  const activeCommand = activeOtaCommand(selected);
  const items = state.loading ? [
    ['注册设备', '-', '正在加载'],
    ['离线设备', '-', '正在加载'],
    ['待处理告警', '-', '正在加载'],
    ['当前 OTA', '-', '正在加载'],
  ] : [
    ['注册设备', state.devices.length, state.devices.filter((device) => device.status === 'online').length + ' 台在线'],
    ['离线设备', offlineDevices, offlineDevices ? '需要检查连接' : unknownDevices ? unknownDevices + ' 台尚未上报' : '连接状态正常'],
    ['未关闭告警', unresolvedAlerts, unresolvedAlerts ? '包含待确认与已确认' : '没有未关闭告警'],
    ['当前 OTA', activeCommand ? clampProgress(activeCommand.progress) + '%' : '无', activeCommand ? statusLabel(activeCommand.status) : selected ? '没有进行中任务' : '请选择设备'],
  ];
  const cards = items.map(([label, value, detail]) => {
    const card = createElement('article', 'summary-card');
    card.append(
      createElement('p', '', label),
      createElement('strong', '', value),
      createElement('span', 'subtle', detail),
    );
    return card;
  });
  replaceChildren(query('#summary'), cards);
}

function deviceSearchText(device) {
  return [device.name, device.id, device.type].filter(Boolean).join(' ').toLowerCase();
}

function selectDevice(deviceId) {
  if (!deviceId || deviceId === state.selectedDeviceId) return;
  state.selectedDeviceId = deviceId;
  state.device = null;
  state.detailLoading = true;
  const targetInput = query('#target-version');
  targetInput.dataset.deviceId = '';
  const url = new URL(window.location.href);
  url.searchParams.set('device', deviceId);
  window.history.replaceState({}, '', url);
  renderAll();
  loadDashboard(false).catch((error) => setPageError('无法加载设备：' + error.message));
}

function renderDeviceList() {
  const container = query('#device-list');
  query('#device-count').textContent = String(state.devices.length);
  if (state.loading) {
    container.className = 'device-list empty-state';
    container.textContent = '正在加载设备...';
    return;
  }
  const search = state.search.trim().toLowerCase();
  const devices = state.devices.filter((device) => (!search || deviceSearchText(device).includes(search))
    && (state.deviceStatus === 'all' || device.status === state.deviceStatus));
  query('#device-count').textContent = devices.length + ' / ' + state.devices.length;
  if (!devices.length) {
    container.className = 'device-list empty-state';
    container.textContent = search || state.deviceStatus !== 'all' ? '没有匹配的设备。' : '暂无设备。';
    return;
  }
  container.className = 'device-list';
  const buttons = devices.map((device) => {
    const selected = device.id === state.selectedDeviceId;
    const button = createElement('button', 'device-item' + (selected ? ' selected' : ''));
    button.type = 'button';
    button.dataset.focusKey = 'device:' + device.id;
    button.setAttribute('aria-current', selected ? 'true' : 'false');
    const heading = createElement('span', 'device-item-heading');
    heading.append(
      createElement('strong', '', device.name || device.id),
      createElement('span', 'status compact ' + statusClass(device.status), statusLabel(device.status)),
    );
    const identity = createElement('span', 'device-identity', device.id + (device.type ? ' · ' + device.type : ''));
    const unresolved = state.alerts.filter((alert) => alert.deviceId === device.id && alert.status !== 'resolved').length;
    const footer = createElement('span', 'device-item-footer');
    footer.append(
      createElement('span', '', '固件 ' + reportedFirmware(device)),
      createElement('span', unresolved ? 'has-alerts' : '', unresolved ? unresolved + ' 条告警' : '无未关闭告警'),
    );
    button.append(heading, identity, footer);
    button.addEventListener('click', () => selectDevice(device.id));
    return button;
  });
  replaceChildren(container, buttons);
}

function addMeta(container, text) {
  if (text) container.append(createElement('span', '', text));
}

function renderDevice() {
  const device = currentDevice();
  const empty = query('#device-empty');
  const details = query('#device-details');
  const meta = query('#device-meta');
  meta.replaceChildren();
  if (state.detailLoading && !device) {
    query('#device-name').textContent = '正在加载设备...';
    query('#device-status').className = 'status unknown';
    query('#device-status').textContent = '加载中';
    empty.hidden = false;
    empty.textContent = '正在读取设备影子与命令记录...';
    details.hidden = true;
    return;
  }
  if (!device) {
    query('#device-name').textContent = '未选择设备';
    query('#device-status').className = 'status unknown';
    query('#device-status').textContent = '未知';
    empty.hidden = false;
    empty.textContent = '选择一台设备查看运行状态。';
    details.hidden = true;
    return;
  }
  query('#device-name').textContent = device.name || device.id;
  const status = query('#device-status');
  status.className = 'status ' + statusClass(device.status);
  status.textContent = statusLabel(device.status);
  addMeta(meta, device.id);
  addMeta(meta, device.type);
  addMeta(meta, device.location || device.metadata?.location);
  empty.hidden = true;
  details.hidden = false;
  query('#reported-firmware').textContent = reportedFirmware(device);
  query('#desired-firmware').textContent = desiredFirmware(device);
  const lastSeen = query('#last-seen');
  lastSeen.textContent = device.lastSeenAt ? formatRelativeTime(device.lastSeenAt) : '从未上报';
  lastSeen.title = device.lastSeenAt ? formatTime(device.lastSeenAt) : '';
  const mode = device.shadow?.reported?.mode;
  query('#device-mode').textContent = ({ auto: '自动', manual: '手动' })[mode] || mode || '-';
  query('#firmware-alignment').textContent = reportedFirmware(device) === desiredFirmware(device) ? '上报与期望一致' : '上报与期望不一致';
  query('#observed-at').textContent = formatTime(device.latestTelemetry?.timestamp);
  query('#observed-at').title = '设备上报 timestamp；未提供时使用服务端接收时间';
}

function temperatureSeries(device) {
  return CloudEdgeOperations.series(device?.recentTelemetry, state.telemetryMetric);
}

function renderTelemetryChart(records) {
  const svg = query('#telemetry-chart');
  svg.replaceChildren();
  if (!records.length) {
    const message = createSvgElement('text', { x: 310, y: 92, class: 'chart-empty', 'text-anchor': 'middle' });
    message.textContent = '暂无有效采样';
    svg.append(message);
    return;
  }
  const width = 620;
  const height = 180;
  const paddingX = 30;
  const paddingY = 22;
  const values = records.map((item) => item.metrics[state.telemetryMetric]);
  const margin = Math.max((Math.max(...values) - Math.min(...values)) * 0.1, 1);
  const min = Math.min(...values) - margin;
  const max = Math.max(...values) + margin;
  const spread = Math.max(1, max - min);
  const times = records.map((item) => Date.parse(item.receivedAt || item.timestamp));
  const timeSpan = Math.max(1, times.at(-1) - times[0]);
  const points = records.map((item, index) => ({
    x: paddingX + ((times[index] - times[0]) / timeSpan) * (width - paddingX * 2),
    y: height - paddingY - ((item.metrics[state.telemetryMetric] - min) / spread) * (height - paddingY * 2),
  }));
  [0, 0.5, 1].forEach((ratio) => {
    const y = paddingY + ratio * (height - paddingY * 2);
    svg.append(createSvgElement('line', { class: 'chart-grid', x1: paddingX, y1: y, x2: width - paddingX, y2: y }));
    const label = createSvgElement('text', { class: 'chart-label', x: 0, y: y + 4 });
    label.textContent = (max - ratio * spread).toFixed(state.telemetryMetric === 'vibrationMmS' ? 1 : 0);
    svg.append(label);
  });
  const line = points.map((point, index) => (index ? 'L ' : 'M ') + point.x.toFixed(1) + ' ' + point.y.toFixed(1)).join(' ');
  const area = line + ' L ' + points[points.length - 1].x.toFixed(1) + ' ' + (height - paddingY) + ' L ' + points[0].x.toFixed(1) + ' ' + (height - paddingY) + ' Z';
  svg.append(
    createSvgElement('path', { class: 'chart-area', d: area }),
    createSvgElement('path', { class: 'chart-line', d: line }),
  );
  const last = points[points.length - 1];
  svg.append(createSvgElement('circle', { class: 'chart-point', cx: last.x, cy: last.y, r: 4 }));
}

function renderTelemetry() {
  const device = currentDevice();
  const latest = device?.latestTelemetry?.metrics || {};
  const metric = state.telemetryMetric;
  query('#temperature-value').textContent = formatMetric(metric, latest[metric]);
  query('#telemetry-heading').textContent = metricDefinitions[metric].label + '趋势';
  query('#telemetry-chart').setAttribute('aria-label', metricDefinitions[metric].label + '趋势，按服务端接收时间');
  const records = temperatureSeries(device).slice(-48);
  renderTelemetryChart(records);
  query('#telemetry-window').textContent = records.length
    ? '接收时间 ' + formatTime(records[0].receivedAt || records[0].timestamp) + ' 至 ' + formatTime(records.at(-1).receivedAt || records.at(-1).timestamp) + ' · ' + records.length + ' 个采样点' + (device.status !== 'online' ? ' · 历史数据' : '') : '暂无采样';
  const metrics = Object.entries(metricDefinitions).map(([metric, definition]) => {
    const item = createElement('div', 'metric-item');
    item.append(
      createElement('span', '', definition.label),
      createElement('strong', '', formatMetric(metric, latest[metric])),
    );
    return item;
  });
  replaceChildren(query('#metric-list'), metrics);
}

function commandTarget(command) {
  return command?.payload?.targetVersion || command?.targetVersion || '-';
}

function renderProgress(command, className = '') {
  const wrapper = createElement('div', 'progress-block ' + className);
  const labels = createElement('div', 'progress-labels');
  labels.append(
    createElement('span', '', statusLabel(command.status)),
    createElement('strong', '', clampProgress(command.progress) + '%'),
  );
  const progress = document.createElement('progress');
  progress.max = 100;
  progress.value = clampProgress(command.progress);
  progress.setAttribute('aria-label', 'OTA 进度 ' + clampProgress(command.progress) + '%');
  wrapper.append(labels, progress);
  return wrapper;
}

function renderActiveCommand() {
  const container = query('#active-command');
  const command = activeOtaCommand();
  if (!command) {
    container.className = 'active-command empty-state';
    container.textContent = currentDevice() ? '当前没有进行中的 OTA 任务。' : '选择设备后可创建 OTA 任务。';
    return;
  }
  container.className = 'active-command';
  const heading = createElement('div', 'active-command-heading');
  heading.append(
    createElement('strong', '', '升级至 ' + commandTarget(command)),
    createElement('span', 'status compact ' + statusClass(command.status), statusLabel(command.status)),
  );
  const expiry = command.expiresAt ? ' · ' + (String(command.status).toLowerCase() === 'expired' ? '已于 ' : '过期于 ') + formatTime(command.expiresAt) : '';
  const meta = createElement('p', 'command-meta', command.id + ' · 创建于 ' + formatTime(command.createdAt) + expiry);
  replaceChildren(container, [heading, renderProgress(command), meta]);
}

function renderOtaControls() {
  const device = currentDevice();
  const command = activeOtaCommand(device);
  const busy = state.busy.has('create-ota');
  const input = query('#target-version');
  const button = query('#create-ota');
  if (device && input.dataset.deviceId !== device.id) {
    input.dataset.deviceId = device.id;
    input.value = command ? commandTarget(command) : suggestedVersion(device);
    query('#ota-error').hidden = true;
  }
  if (device && command) input.value = commandTarget(command);
  if (!device) {
    input.dataset.deviceId = '';
    input.value = '';
  }
  input.disabled = !device || Boolean(command) || busy;
  button.disabled = !device || Boolean(command) || busy;
  button.textContent = busy ? '正在创建...' : command ? '任务进行中' : '创建任务';
  renderActiveCommand();
}

function commandTimeline(command) {
  const history = Array.isArray(command.history) && command.history.length
    ? command.history
    : [{ status: command.status, progress: command.progress, at: command.updatedAt || command.createdAt }];
  const list = createElement('ol', 'command-timeline');
  history.forEach((entry) => {
    const item = createElement('li');
    const marker = createElement('span', 'timeline-marker ' + statusClass(entry.status));
    marker.setAttribute('aria-hidden', 'true');
    const content = createElement('div');
    content.append(
      createElement('strong', '', statusLabel(entry.status) + ' · ' + clampProgress(entry.progress) + '%'),
      createElement('time', '', formatTime(entry.at || entry.occurredAt)),
    );
    item.append(marker, content);
    list.append(item);
  });
  return list;
}

function renderCommands() {
  const container = query('#commands');
  const commands = deviceCommands();
  query('#command-count').textContent = String(commands.length);
  if (!currentDevice()) {
    container.className = 'command-list empty-state';
    container.textContent = '选择设备后查看命令记录。';
    return;
  }
  if (!commands.length) {
    container.className = 'command-list empty-state';
    container.textContent = '暂无命令记录。';
    return;
  }
  container.className = 'command-list';
  const rows = commands.map((command, index) => {
    const details = createElement('details', 'command-row');
    details.dataset.commandId = command.id;
    const defaultOpen = index === 0 && !terminalCommandStatuses.has(String(command.status).toLowerCase());
    details.open = state.commandDisclosure.has(command.id)
      ? state.commandDisclosure.get(command.id)
      : defaultOpen;
    const summary = document.createElement('summary');
    summary.dataset.focusKey = 'command:' + command.id;
    const identity = createElement('span', 'command-identity');
    identity.append(
      createElement('strong', '', String(command.type || 'command').toUpperCase() + ' · ' + commandTarget(command)),
      createElement('small', '', command.id + ' · ' + formatTime(command.createdAt) + (command.expiresAt ? ' · 过期 ' + formatTime(command.expiresAt) : '')),
    );
    summary.append(identity, createElement('span', 'status compact ' + statusClass(command.status), statusLabel(command.status)));
    const body = createElement('div', 'command-body');
    body.append(renderProgress(command, 'small'), commandTimeline(command));
    details.append(summary, body);
    return details;
  });
  replaceChildren(container, rows);
}

function alertMetricLabel(metric) {
  const labels = {
    temperatureC: '温度',
    vibrationMmS: '振动',
    connectivity: '设备连接',
    offline: '设备离线',
    deviceOffline: '设备离线',
    lastSeenAt: '最后在线时间',
  };
  return labels[metric] || metric || '规则证据';
}

function formatDuration(value) {
  return CloudEdgeOperations.duration(Number(value));
}

function describeEvidence(alert) {
  const evidence = alert.evidence || {};
  const metric = evidence.metric || alert.metric;
  const parts = [];
  if (metric === 'temperatureC' || metric === 'vibrationMmS') {
    parts.push(alertMetricLabel(metric) + ' ' + formatMetric(metric, evidence.value));
    if (evidence.threshold !== undefined) parts.push('阈值 ' + formatMetric(metric, evidence.threshold));
  } else if (metric === 'connectivity' || metric === 'offline' || metric === 'deviceOffline' || alert.type === 'offline') {
    parts.push('设备未按期上报');
    const duration = evidence.offlineForMs ?? evidence.value;
    if (duration !== undefined && duration !== 'offline') parts.push('离线 ' + formatDuration(duration));
    const threshold = evidence.thresholdMs ?? (evidence.thresholdUnit === 'ms' ? evidence.threshold : undefined);
    if (threshold !== undefined) parts.push('阈值 ' + formatDuration(threshold));
    if (evidence.lastSeenAt) parts.push('最近接收 ' + formatTime(evidence.lastSeenAt));
  } else {
    parts.push(alertMetricLabel(metric) + (evidence.value !== undefined ? ' ' + String(evidence.value) : ''));
    if (evidence.threshold !== undefined) parts.push('阈值 ' + String(evidence.threshold));
  }
  const observedAt = evidence.observedAt || alert.updatedAt || alert.createdAt;
  if (observedAt) parts.push('观测于 ' + formatTime(observedAt));
  return parts.join(' · ');
}

async function acknowledgeAlert(alertId) {
  const key = 'ack:' + alertId;
  state.busy.add(key);
  setPageError('');
  renderAlerts();
  try {
    await api('/api/alerts/' + encodeURIComponent(alertId) + '/acknowledge', {
      method: 'POST',
      body: JSON.stringify({ actor: 'dashboard-operator' }),
    });
    await loadDashboard(false);
  } catch (error) {
    setPageError('确认告警失败：' + error.message);
  } finally {
    state.busy.delete(key);
    renderAlerts();
  }
}

function resolveAlert(alertId) {
  const alert = state.alerts.find((item) => item.id === alertId);
  if (!alert) return;
  state.resolvingAlertId = alertId;
  query('#resolve-context').textContent = CloudEdgeOperations.alarmTitle(alert) + ' · ' + CloudEdgeOperations.condition(alert, currentDevice()).label + ' · ' + describeEvidence(alert);
  query('#resolution-note').value = '';
  query('#resolve-error').hidden = true;
  query('#resolve-dialog').showModal();
  query('#resolution-note').focus();
}

async function submitResolution(event) {
  event.preventDefault();
  const alertId = state.resolvingAlertId;
  const reason = query('#resolution-note').value.trim();
  if (!alertId || !reason) {
    query('#resolve-error').hidden = false;
    query('#resolve-error').textContent = '请填写有效的处置记录。';
    return;
  }
  const key = 'resolve:' + alertId;
  if (state.busy.has(key)) return;
  state.busy.add(key);
  query('#resolve-submit').disabled = true;
  setPageError('');
  renderAlerts();
  try {
    await api('/api/alerts/' + encodeURIComponent(alertId) + '/resolve', {
      method: 'POST',
      body: JSON.stringify({ actor: 'dashboard-operator', reason }),
    });
    query('#resolve-dialog').close();
    state.resolvingAlertId = null;
    await loadDashboard(false);
  } catch (error) {
    query('#resolve-error').hidden = false;
    query('#resolve-error').textContent = '关闭告警失败：' + error.message;
  } finally {
    state.busy.delete(key);
    query('#resolve-submit').disabled = false;
    renderAlerts();
  }
}

function renderAlerts() {
  const container = query('#alerts');
  const selectedId = state.selectedDeviceId;
  const alerts = selectedId
    ? state.alerts.filter((alert) => {
      if (alert.deviceId !== selectedId) return false;
      if (state.alertStatus !== 'all' && alert.status !== state.alertStatus) return false;
      if (state.alertSeverity !== 'all' && alert.severity !== state.alertSeverity) return false;
      return true;
    })
    : [];
  const unresolved = state.alerts.filter((alert) => alert.deviceId === selectedId && alert.status !== 'resolved').length;
  query('#alert-count').textContent = String(unresolved);
  if (!selectedId) {
    container.className = 'feed empty-state';
    container.textContent = '选择设备后查看告警。';
    return;
  }
  if (!alerts.length) {
    container.className = 'feed empty-state';
    container.textContent = state.alertStatus !== 'all' || state.alertSeverity !== 'all'
      ? '没有符合筛选条件的告警。'
      : '该设备暂无告警。';
    return;
  }
  container.className = 'feed';
  const rows = alerts.map((alert) => {
    const row = createElement('article', 'alert-row');
    const accent = createElement('span', 'severity ' + statusClass(alert.severity));
    accent.classList.add(alert.severity === 'critical' ? 'critical' : 'warning');
    accent.setAttribute('aria-hidden', 'true');
    const content = createElement('div', 'alert-content');
    const heading = createElement('div', 'alert-heading');
    const labels = createElement('span', 'alert-labels');
    const severity = alert.severity === 'critical' ? 'critical' : 'warning';
    labels.append(
      createElement('span', 'severity-label ' + severity, severity === 'critical' ? '严重' : '警告'),
      createElement('span', 'status compact ' + statusClass(alert.status), statusLabel(alert.status)),
    );
    heading.append(
      createElement('strong', '', CloudEdgeOperations.alarmTitle(alert)),
      labels,
    );
    const lifecycle = [
      alert.acknowledgedBy ? alert.acknowledgedBy + ' 已确认' : '',
      alert.resolvedBy ? alert.resolvedBy + ' 已关闭' : '',
      alert.resolutionReason ? '原因：' + alert.resolutionReason : '',
    ].filter(Boolean);
    content.append(
      heading,
      createElement('p', 'alert-evidence', CloudEdgeOperations.condition(alert, currentDevice()).label),
      createElement('p', 'alert-evidence', describeEvidence(alert)),
      createElement('p', 'alert-meta', ['创建于 ' + formatTime(alert.createdAt), ...lifecycle].join(' · ')),
    );
    const actions = createElement('div', 'row-actions');
    if (alert.status === 'open') {
      const key = 'ack:' + alert.id;
      const acknowledge = createElement('button', 'text-button', state.busy.has(key) ? '确认中...' : '确认');
      acknowledge.type = 'button';
      acknowledge.dataset.focusKey = 'alert:acknowledge:' + alert.id;
      acknowledge.disabled = state.busy.has(key);
      acknowledge.addEventListener('click', () => acknowledgeAlert(alert.id));
      actions.append(acknowledge);
    }
    if (alert.status === 'acknowledged') {
      const key = 'resolve:' + alert.id;
      const resolve = createElement('button', 'text-button resolve', state.busy.has(key) ? '处理中...' : '关闭');
      resolve.type = 'button';
      resolve.dataset.focusKey = 'alert:resolve:' + alert.id;
      resolve.disabled = state.busy.has(key);
      resolve.addEventListener('click', () => resolveAlert(alert.id));
      actions.append(resolve);
    }
    row.append(accent, content, actions);
    return row;
  });
  replaceChildren(container, rows);
}

function eventDeviceId(event) {
  return event.device?.id || event.deviceId || event.alert?.deviceId || event.command?.deviceId || event.telemetry?.deviceId || '';
}

function describeEvent(event) {
  if (event.alert) return CloudEdgeOperations.alarmTitle(event.alert) + ' · ' + statusLabel(event.alert.status);
  if (event.command) {
    return String(event.command.type || 'command').toUpperCase() + ' ' + statusLabel(event.command.status) + ' · ' + clampProgress(event.command.progress) + '%';
  }
  if (event.telemetry) {
    const temperature = event.telemetry.metrics?.temperatureC;
    return temperature === undefined ? '遥测已接收' : '温度 ' + formatMetric('temperatureC', temperature);
  }
  if (event.device) return (event.device.name || event.device.id || '设备') + ' · ' + statusLabel(event.device.status);
  if (typeof event.detail === 'string' && event.detail) return event.detail;
  return '状态已更新';
}

function renderEvents() {
  const container = query('#events');
  if (!state.events.length) {
    container.className = 'feed empty-state';
    container.textContent = state.loading ? '正在加载事件...' : '等待事件。';
    return;
  }
  container.className = 'feed';
  const rows = state.events.slice(0, 24).map((event) => {
    const row = createElement('article', 'event-row');
    const typePrefix = String(event.type || 'event').split('.')[0].slice(0, 1).toUpperCase();
    const icon = createElement('span', 'event-icon', typePrefix || 'E');
    icon.setAttribute('aria-hidden', 'true');
    const content = createElement('div');
    const eventLabels = { 'telemetry.updated': '遥测接收', 'device.updated': '设备状态变更', 'alert.created': '告警触发', 'alert.updated': '告警更新', 'command.created': '升级任务创建', 'command.updated': '任务执行更新' };
    const title = createElement('strong', '', eventLabels[event.type] || event.type || '运行事件');
    title.title = event.type || '';
    const deviceId = eventDeviceId(event);
    const detail = describeEvent(event) + (deviceId ? ' · ' + deviceId : '');
    content.append(title, createElement('p', '', detail), createElement('time', '', formatTime(event.occurredAt)));
    row.append(icon, content);
    return row;
  });
  replaceChildren(container, rows);
}

function renderHeaderActions() {
  const button = query('#inject-alert');
  const busy = state.busy.has('inject-alert');
  button.disabled = !currentDevice() || busy;
  button.textContent = busy ? '正在模拟...' : '模拟温度超限';
}

function renderAll() {
  const activeFocusKey = captureInteractionState();
  renderPageState();
  renderHealth();
  renderMetrics();
  renderSummary();
  renderDeviceList();
  renderDevice();
  renderTelemetry();
  renderOtaControls();
  renderCommands();
  renderAlerts();
  renderEvents();
  renderHeaderActions();
  restoreInteractionState(activeFocusKey);
}

function requestedDeviceId(devices) {
  const requested = new URL(window.location.href).searchParams.get('device');
  const candidates = [state.selectedDeviceId, requested];
  return candidates.find((id) => id && devices.some((device) => device.id === id)) || devices[0]?.id || null;
}

async function loadDashboard(initial = false) {
  const sequence = ++state.loadSequence;
  if (initial) state.loading = true;
  renderAll();
  try {
    const [healthResult, metricsResult] = await Promise.allSettled([
      api('/api/health'),
      api('/api/metrics'),
    ]);
    if (sequence !== state.loadSequence) return;
    state.health = healthResult.status === 'fulfilled' ? healthResult.value
      : healthResult.reason?.body?.status === 'degraded' ? healthResult.reason.body : null;
    state.metrics = metricsResult.status === 'fulfilled' ? metricsResult.value : null;
    const [deviceResult, alertResult, eventResult] = await Promise.all([
      api('/api/devices'),
      api('/api/alerts'),
      api('/api/events/history?limit=40'),
    ]);
    const devices = Array.isArray(deviceResult.devices) ? deviceResult.devices : [];
    const selectedId = requestedDeviceId(devices);
    const detailResult = selectedId ? await api('/api/devices/' + encodeURIComponent(selectedId)) : { device: null };
    if (sequence !== state.loadSequence) return;
    state.devices = devices;
    state.alerts = Array.isArray(alertResult.alerts) ? alertResult.alerts : [];
    state.events = Array.isArray(eventResult.events) ? eventResult.events : [];
    state.selectedDeviceId = selectedId;
    state.device = detailResult.device || null;
    state.loading = false;
    state.detailLoading = false;
    setPageError('');
    renderAll();
    renderMetrics();
  } catch (error) {
    if (sequence !== state.loadSequence) return;
    if (error.status === 401 || error.status === 403) clearPrivateState();
    state.loading = false;
    state.detailLoading = false;
    setPageError('无法加载控制台：' + error.message);
    renderAll();
    throw error;
  }
}

function addRealtimeEvent(event) {
  state.events = [event, ...state.events].slice(0, 40);
  renderEvents();
}

function scheduleRefresh() {
  if (state.refreshTimer !== null) return;
  state.refreshTimer = window.setTimeout(() => {
    state.refreshTimer = null;
    loadDashboard(false).catch(() => {});
  }, 220);
}

function setConnection(connectionState) {
  const container = query('#connection');
  const labels = {
    locked: '等待认证',
    connecting: '实时连接中',
    connected: '实时已连接',
    reconnecting: '实时重连中',
  };
  container.className = 'connection ' + connectionState;
  query('#connection-label').textContent = labels[connectionState] || labels.connecting;
}

async function applyCredentials() {
  const authSequence = ++state.authSequence;
  state.eventSource?.close();
  state.eventSource = null;
  query('#apply-credentials').disabled = true;
  const operatorInput = query('#operator-token');
  const deviceInput = query('#device-token');
  state.credentials.operatorToken = operatorInput?.value.trim() || '';
  state.credentials.deviceToken = deviceInput?.value.trim() || '';
  const status = query('#credential-status');
  if (status) status.textContent = '正在验证并刷新...';
  try {
    await api('/api/auth/operator');
    if (authSequence !== state.authSequence) return;
    if (state.credentials.deviceToken && state.selectedDeviceId) {
      await api('/api/commands?deviceId=' + encodeURIComponent(state.selectedDeviceId));
    }
    await api('/api/auth/session', { method: 'POST' });
    if (authSequence !== state.authSequence) return;
    connectEvents();
    await loadDashboard(false);
    operatorInput.value = '';
    deviceInput.value = '';
    if (status) status.textContent = '凭据已应用（仅保存在当前页面）。';
  } catch {
    if (authSequence !== state.authSequence) return;
    clearPrivateState();
    renderAll();
    if (status) status.textContent = '凭据验证失败，请检查 Token 和服务状态。';
  } finally {
    query('#apply-credentials').disabled = false;
  }
}

function clearPrivateState() {
  query('#resolve-dialog').close();
  query('#resolution-note').value = '';
  state.resolvingAlertId = null;
  state.authSequence += 1;
  state.eventSource?.close();
  state.eventSource = null;
  window.clearTimeout(state.refreshTimer);
  state.refreshTimer = null;
  state.loadSequence += 1;
  state.credentials = { operatorToken: '', deviceToken: '' };
  state.devices = [];
  state.device = null;
  state.selectedDeviceId = null;
  state.alerts = [];
  state.events = [];
  state.metrics = null;
  if (state.health) state.health = { ok: state.health.ok, status: state.health.status, authMode: state.health.authMode };
  state.commandDisclosure.clear();
  state.pendingOtaRequest = null;
  state.loading = false;
  state.detailLoading = false;
  query('#operator-token').value = '';
  query('#device-token').value = '';
  setConnection('locked');
}

async function logout() {
  clearPrivateState();
  renderAll();
  query('#credential-status').textContent = '已退出';
  try {
    await api('/api/auth/session', { method: 'DELETE' });
  } catch {
    query('#credential-status').textContent = '本页已退出，服务端会话注销失败，请重试退出。';
  }
}

function connectEvents() {
  state.eventSource?.close();
  setConnection('connecting');
  const source = new EventSource('/api/events');
  state.eventSource = source;
  source.addEventListener('auth.expired', () => {
    if (state.eventSource !== source) return;
    clearPrivateState();
    renderAll();
    query('#credential-status').textContent = '会话已过期，请重新认证。';
  });
  source.onopen = () => setConnection('connected');
  source.addEventListener('connected', () => {
    setConnection('connected');
    scheduleRefresh();
  });
  eventTypes.forEach((type) => {
    source.addEventListener(type, (message) => {
      if (state.eventSource !== source) return;
      try {
        const event = JSON.parse(message.data);
        addRealtimeEvent(event);
        scheduleRefresh();
      } catch {
        setPageError('收到无法解析的实时事件。');
      }
    });
  });
  source.onerror = () => {
    if (state.eventSource !== source) return;
    setConnection('reconnecting');
    api('/api/auth/operator').then(() => {
      if (state.eventSource === source && state.health?.authMode === 'protected') {
        return api('/api/auth/session', { method: 'POST' });
      }
    }).catch((error) => {
      if (state.eventSource === source && [401, 403].includes(error.status)) {
        clearPrivateState();
        renderAll();
      }
    });
  };
  window.addEventListener('beforeunload', () => source.close(), { once: true });
}

query('#device-search').addEventListener('input', (event) => {
  state.search = event.target.value;
  renderDeviceList();
});
query('#device-status-filter').addEventListener('change', (event) => {
  state.deviceStatus = event.target.value;
  renderDeviceList();
});
query('#telemetry-metric').addEventListener('change', (event) => {
  state.telemetryMetric = event.target.value;
  renderTelemetry();
});
query('#resolve-form').addEventListener('submit', submitResolution);
query('#resolve-cancel').addEventListener('click', () => query('#resolve-dialog').close());

query('#alert-status-filter')?.addEventListener('change', (event) => {
  state.alertStatus = event.target.value;
  renderAlerts();
});

query('#alert-severity-filter')?.addEventListener('change', (event) => {
  state.alertSeverity = event.target.value;
  renderAlerts();
});

query('#apply-credentials')?.addEventListener('click', applyCredentials);
query('#logout')?.addEventListener('click', logout);

query('#ota-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const device = currentDevice();
  if (!device || activeOtaCommand(device)) return;
  const input = query('#target-version');
  const errorContainer = query('#ota-error');
  const targetVersion = input.value.trim();
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(targetVersion)) {
    errorContainer.hidden = false;
    errorContainer.textContent = '请输入有效版本号，例如 0.2.0 或 1.0.0-rc.1。';
    input.focus();
    return;
  }
  state.busy.add('create-ota');
  errorContainer.hidden = true;
  setPageError('');
  renderOtaControls();
  const reusableRequest = state.pendingOtaRequest;
  const requestId = reusableRequest
    && reusableRequest.deviceId === device.id
    && reusableRequest.targetVersion === targetVersion
    ? reusableRequest.requestId
    : window.crypto?.randomUUID
      ? 'dashboard-' + window.crypto.randomUUID()
      : 'dashboard-' + Date.now();
  state.pendingOtaRequest = { deviceId: device.id, targetVersion, requestId };
  try {
    await api('/api/ota-jobs', {
      method: 'POST',
      body: JSON.stringify({ deviceId: device.id, targetVersion, requestId }),
    });
    state.pendingOtaRequest = null;
    await loadDashboard(false);
  } catch (error) {
    if (Number.isInteger(error.status) && error.status < 500) state.pendingOtaRequest = null;
    errorContainer.hidden = false;
    errorContainer.textContent = '创建 OTA 任务失败：' + error.message;
  } finally {
    state.busy.delete('create-ota');
    renderOtaControls();
  }
});

query('#inject-alert').addEventListener('click', async () => {
  const device = currentDevice();
  if (!device) return;
  state.busy.add('inject-alert');
  setPageError('');
  renderHeaderActions();
  try {
    await api('/api/demo/inject-alert', {
      method: 'POST',
      body: JSON.stringify({ deviceId: device.id }),
    });
    await loadDashboard(false);
  } catch (error) {
    setPageError('注入演示告警失败：' + error.message);
  } finally {
    state.busy.delete('inject-alert');
    renderHeaderActions();
  }
});

loadDashboard(true).then(connectEvents).catch(() => {});
