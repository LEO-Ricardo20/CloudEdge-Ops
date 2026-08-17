const baseUrl = process.env.CLOUDEDGE_API || 'http://127.0.0.1:4173';
const deviceId = process.env.DEVICE_ID || 'robot-arm-01';

let tick = 0;
let otaCommandId = null;
let otaProgress = 0;
let firmwareVersion = '0.1.0';

function metrics() {
  tick += 1;
  return {
    temperatureC: Number((42 + Math.sin(tick / 3) * 3 + Math.random() * 1.2).toFixed(1)),
    vibrationMmS: Number((2.1 + Math.sin(tick / 4) * 0.45 + Math.random() * 0.25).toFixed(2)),
    batteryPct: Math.max(40, 88 - Math.floor(tick / 16)),
    motorRpm: Math.round(1240 + Math.sin(tick / 2) * 95),
  };
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `${response.status} ${response.statusText}`);
  return body;
}

async function postTelemetry() {
  await request('/api/telemetry', {
    method: 'POST',
    body: JSON.stringify({
      deviceId,
      metrics: metrics(),
      reportedState: { mode: 'auto', firmwareVersion },
    }),
  });
}

async function processCommands() {
  const result = await request(`/api/commands?deviceId=${encodeURIComponent(deviceId)}`);
  const command = result.commands.find((item) => item.type === 'ota' && item.status !== 'success');
  if (!command) return;

  if (otaCommandId !== command.id) {
    otaCommandId = command.id;
    otaProgress = 0;
    await request(`/api/commands/${command.id}/ack`, { method: 'POST', body: '{}' });
    console.log(`[edge] acknowledged OTA ${command.payload.targetVersion}`);
    return;
  }

  otaProgress = Math.min(100, otaProgress + 25);
  const status = otaProgress >= 100 ? 'success' : otaProgress >= 50 ? 'installing' : 'downloading';
  await request(`/api/commands/${command.id}/progress`, {
    method: 'POST',
    body: JSON.stringify({ progress: otaProgress, status }),
  });
  if (status === 'success') firmwareVersion = command.payload.targetVersion;
  console.log(`[edge] OTA ${status}: ${otaProgress}%`);
}

async function loop() {
  try {
    await postTelemetry();
    await processCommands();
    process.stdout.write(`[edge] telemetry sent for ${deviceId}\n`);
  } catch (error) {
    console.error(`[edge] ${error.message}`);
  }
}

console.log(`CloudEdge simulator using ${baseUrl} for ${deviceId}`);
loop();
setInterval(loop, 1200);
