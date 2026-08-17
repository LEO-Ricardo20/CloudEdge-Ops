const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { CloudEdgePlatform } = require('../server/domain/platform');
const { createHttpHandler } = require('../server/http');
const { JsonFileRepository } = require('../server/persistence/json-file-repository');

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await check();
    if (lastValue) return lastValue;
    await delay(50);
  }
  throw new Error(`Timed out waiting for simulator state; last value: ${JSON.stringify(lastValue)}`);
}

test('real simulator completes an OTA job through the HTTP server and persists the result', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudedge-smoke-'));
  const stateFile = path.join(temporaryDirectory, 'platform-state.json');
  const repository = new JsonFileRepository(stateFile);
  const platform = new CloudEdgePlatform({ repository, offlineAfterMs: 5_000 });
  const handler = createHttpHandler(platform, path.resolve(__dirname, '..', 'web'));
  const server = http.createServer(handler);
  let simulator;
  let simulatorOutput = '';

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    simulator = spawn(process.execPath, [path.resolve(__dirname, '..', 'simulator', 'device-simulator.js')], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        CLOUDEDGE_API: baseUrl,
        DEVICE_ID: 'robot-arm-01',
        SIMULATOR_INTERVAL_MS: '75',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    simulator.stdout.on('data', (chunk) => { simulatorOutput += chunk.toString(); });
    simulator.stderr.on('data', (chunk) => { simulatorOutput += chunk.toString(); });

    await waitFor(() => platform.getDevice('robot-arm-01').latestTelemetry);
    const createResponse = await fetch(`${baseUrl}/api/ota-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'robot-arm-01',
        targetVersion: '0.2.0',
        requestId: 'simulator-smoke-release',
      }),
    });
    assert.equal(createResponse.status, 201);
    const { command: created } = await createResponse.json();
    const completed = await waitFor(() => {
      const command = platform.listCommands('robot-arm-01').find((item) => item.id === created.id);
      return command?.status === 'success' ? command : null;
    });

    assert.equal(completed.progress, 100);
    assert.deepEqual(completed.history.map((entry) => entry.status), [
      'queued',
      'acknowledged',
      'downloading',
      'installing',
      'installing',
      'success',
    ]);
    const device = platform.getDevice('robot-arm-01');
    assert.equal(device.firmwareVersion, '0.2.0');
    assert.equal(device.shadow.reported.firmwareVersion, '0.2.0');
    assert.equal(device.shadow.desired.firmwareVersion, '0.2.0');
    assert.ok(device.recentTelemetry.length > 0);
    assert.ok(fs.existsSync(stateFile));

    const telemetryCountBeforeRestart = device.recentTelemetry.length;
    simulator.kill();
    await once(simulator, 'exit');
    simulator = spawn(process.execPath, [path.resolve(__dirname, '..', 'simulator', 'device-simulator.js')], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        CLOUDEDGE_API: baseUrl,
        DEVICE_ID: 'robot-arm-01',
        SIMULATOR_INTERVAL_MS: '75',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    simulator.stdout.on('data', (chunk) => { simulatorOutput += chunk.toString(); });
    simulator.stderr.on('data', (chunk) => { simulatorOutput += chunk.toString(); });
    await waitFor(() => platform.getDevice('robot-arm-01').recentTelemetry.length > telemetryCountBeforeRestart);
    assert.equal(platform.getDevice('robot-arm-01').firmwareVersion, '0.2.0');
    assert.equal(platform.getDevice('robot-arm-01').shadow.reported.firmwareVersion, '0.2.0');

    const restored = new CloudEdgePlatform({ repository: new JsonFileRepository(stateFile) });
    assert.equal(restored.getDevice('robot-arm-01').commandHistory[0].status, 'success');
  } catch (error) {
    error.message = `${error.message}\nSimulator output:\n${simulatorOutput}`;
    throw error;
  } finally {
    if (simulator && !simulator.killed) simulator.kill();
    handler.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
