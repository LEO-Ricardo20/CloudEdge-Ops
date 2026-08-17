const state = {
  devices: [],
  device: null,
  alerts: [],
  events: [],
};

const labels = {
  temperatureC: ['Temperature', 'deg C'],
  vibrationMmS: ['Vibration', 'mm/s'],
  batteryPct: ['Battery', '%'],
  motorRpm: ['Motor speed', 'RPM'],
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Request failed');
  return body;
}

function formatTime(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
}

function currentDevice() {
  return state.device || state.devices[0] || null;
}

function renderSummary() {
  const device = currentDevice();
  const openAlerts = state.alerts.filter((alert) => alert.status === 'open').length;
  const telemetry = device?.latestTelemetry?.metrics || {};
  const items = [
    ['Online devices', state.devices.filter((item) => item.status === 'online').length, `${state.devices.length} registered`],
    ['Open alerts', openAlerts, openAlerts ? 'Operator attention required' : 'All rules normal'],
    ['Temperature', telemetry.temperatureC == null ? '-' : `${telemetry.temperatureC} deg C`, device?.latestTelemetry ? 'Latest device report' : 'Waiting for telemetry'],
    ['Firmware', device?.firmwareVersion || '-', device?.desiredFirmwareVersion === device?.firmwareVersion ? 'Desired state aligned' : `Target ${device?.desiredFirmwareVersion}`],
  ];
  document.querySelector('#summary').innerHTML = items.map(([label, value, subtle]) => `
    <article class="summary-card"><p>${label}</p><strong>${value}</strong><span class="subtle">${subtle}</span></article>
  `).join('');
}

function renderDevice() {
  const device = currentDevice();
  if (!device) return;
  state.device = device;
  document.querySelector('#device-name').textContent = device.name;
  const status = document.querySelector('#device-status');
  status.textContent = device.status;
  status.className = `status ${device.status}`;
  document.querySelector('#device-meta').innerHTML = `<span>${device.id}</span><span>${device.type}</span><span>Mode: ${device.shadow.reported.mode || '-'}</span>`;
  document.querySelector('#reported-firmware').textContent = device.shadow.reported.firmwareVersion || '-';
  document.querySelector('#desired-firmware').textContent = device.shadow.desired.firmwareVersion || '-';
  document.querySelector('#last-seen').textContent = formatTime(device.lastSeenAt);

  const pending = (device.pendingCommands || []).find((command) => command.type === 'ota');
  document.querySelector('#ota-status').textContent = pending ? `OTA ${pending.status}: ${pending.progress}%` : '';
}

function chartPath(points, width = 620, height = 180, padding = 22) {
  const values = points.map((item) => Number(item.metrics.temperatureC)).filter(Number.isFinite);
  if (!values.length) return { line: '', area: '', min: 0, max: 100 };
  const min = Math.floor(Math.min(...values, 35) / 5) * 5;
  const max = Math.ceil(Math.max(...values, 70) / 5) * 5;
  const spread = Math.max(1, max - min);
  const mapped = points.map((item, index) => {
    const x = padding + (index / Math.max(1, points.length - 1)) * (width - padding * 2);
    const y = height - padding - ((Number(item.metrics.temperatureC) - min) / spread) * (height - padding * 2);
    return [x, y];
  });
  const line = mapped.map(([x, y], index) => `${index ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = mapped.length ? `${line} L ${mapped[mapped.length - 1][0].toFixed(1)} ${height - padding} L ${mapped[0][0].toFixed(1)} ${height - padding} Z` : '';
  return { line, area, min, max };
}

function renderTelemetry() {
  const device = currentDevice();
  const latest = device?.latestTelemetry?.metrics || {};
  document.querySelector('#temperature-value').textContent = latest.temperatureC == null ? '-' : `${latest.temperatureC} deg C`;
  const history = device?.recentTelemetry || [];
  const chart = chartPath(history.slice(-42));
  document.querySelector('#telemetry-chart').innerHTML = `
    <line class="chart-grid" x1="22" y1="22" x2="598" y2="22"></line>
    <line class="chart-grid" x1="22" y1="90" x2="598" y2="90"></line>
    <line class="chart-grid" x1="22" y1="158" x2="598" y2="158"></line>
    <text class="chart-label" x="0" y="27">${chart.max}</text>
    <text class="chart-label" x="0" y="95">${Math.round((chart.max + chart.min) / 2)}</text>
    <text class="chart-label" x="0" y="163">${chart.min}</text>
    <path class="chart-area" d="${chart.area}"></path>
    <path class="chart-line" d="${chart.line}"></path>
  `;
  document.querySelector('#metric-cards').innerHTML = Object.entries(labels).map(([metric, [label, unit]]) => `
    <article class="metric-card"><p>${label}</p><strong>${latest[metric] == null ? '-' : `${latest[metric]} ${unit}`}</strong></article>
  `).join('');
}

function renderAlerts() {
  const container = document.querySelector('#alerts');
  document.querySelector('#alert-count').textContent = state.alerts.filter((alert) => alert.status === 'open').length;
  if (!state.alerts.length) {
    container.className = 'feed empty';
    container.textContent = 'No active alerts.';
    return;
  }
  container.className = 'feed';
  container.innerHTML = '';
  const template = document.querySelector('#alert-template');
  state.alerts.slice(0, 6).forEach((alert) => {
    const fragment = template.content.cloneNode(true);
    fragment.querySelector('.severity').classList.add(alert.severity);
    fragment.querySelector('.alert-title').textContent = `${alert.title} · ${alert.status}`;
    fragment.querySelector('.alert-evidence').textContent = `${alert.evidence.metric}: ${alert.evidence.value} (threshold ${alert.evidence.threshold}) · ${formatTime(alert.evidence.observedAt)}`;
    const button = fragment.querySelector('.ack-button');
    button.disabled = alert.status !== 'open';
    button.textContent = alert.status === 'open' ? 'Acknowledge' : 'Acknowledged';
    button.addEventListener('click', async () => {
      await api(`/api/alerts/${alert.id}/acknowledge`, { method: 'POST', body: JSON.stringify({ actor: 'dashboard-operator' }) });
      await load();
    });
    container.append(fragment);
  });
}

function renderEvents() {
  const container = document.querySelector('#events');
  if (!state.events.length) return;
  container.className = 'feed';
  container.innerHTML = state.events.slice(0, 7).map((event) => `
    <div class="event-row"><span class="event-icon">${event.type.split('.')[0].slice(0, 1).toUpperCase()}</span><div><strong>${event.type}</strong><p>${event.detail} · ${formatTime(event.occurredAt)}</p></div></div>
  `).join('');
}

function render() {
  renderSummary();
  renderDevice();
  renderTelemetry();
  renderAlerts();
  renderEvents();
}

function addEvent(raw) {
  const detail = raw.alert ? raw.alert.title : raw.command ? `${raw.command.type} ${raw.command.status} ${raw.command.progress}%` : raw.telemetry ? `${raw.telemetry.deviceId} telemetry accepted` : 'State changed';
  state.events.unshift({ type: raw.type, occurredAt: raw.occurredAt, detail });
  state.events = state.events.slice(0, 12);
}

async function load() {
  const [deviceResult, alertResult, eventResult] = await Promise.all([api('/api/devices'), api('/api/alerts'), api('/api/events/history?limit=12')]);
  state.devices = deviceResult.devices;
  const id = state.device?.id || state.devices[0]?.id;
  if (id) state.device = (await api(`/api/devices/${encodeURIComponent(id)}`)).device;
  state.alerts = alertResult.alerts;
  state.events = eventResult.events.map((event) => ({
    type: event.type,
    occurredAt: event.occurredAt,
    detail: event.alert ? event.alert.title : event.command ? `${event.command.type} ${event.command.status} ${event.command.progress}%` : event.telemetry ? `${event.telemetry.deviceId} telemetry accepted` : 'State changed',
  }));
  render();
}

function connectEvents() {
  const source = new EventSource('/api/events');
  const dot = document.querySelector('#connection-dot');
  const label = document.querySelector('#connection-label');
  source.addEventListener('connected', () => {
    dot.classList.add('online');
    label.textContent = 'Realtime connected';
  });
  ['telemetry.updated', 'alert.created', 'alert.updated', 'command.created', 'command.updated'].forEach((type) => {
    source.addEventListener(type, async (event) => {
      addEvent(JSON.parse(event.data));
      await load();
    });
  });
  source.onerror = () => {
    dot.classList.remove('online');
    label.textContent = 'Reconnecting';
  };
}

document.querySelector('#create-ota').addEventListener('click', async () => {
  const device = currentDevice();
  if (!device) return;
  await api('/api/ota-jobs', { method: 'POST', body: JSON.stringify({ deviceId: device.id, targetVersion: '0.2.0' }) });
  await load();
});

document.querySelector('#inject-alert').addEventListener('click', async () => {
  const device = currentDevice();
  if (!device) return;
  await api('/api/demo/inject-alert', { method: 'POST', body: JSON.stringify({ deviceId: device.id }) });
  await load();
});

load().catch((error) => {
  document.querySelector('#events').textContent = `Unable to load dashboard: ${error.message}`;
}).then(connectEvents);
