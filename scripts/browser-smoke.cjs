const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { CloudEdgePlatform } = require('../server/domain/platform');
const { createHttpHandler } = require('../server/http');

async function verify(authMode, browser) {
  const platform = new CloudEdgePlatform();
  platform.registerDevice({ id: 'sensor-02', name: 'Workshop Sensor 02', type: 'Environmental sensor' });
  const handler = createHttpHandler(platform, path.resolve(__dirname, '..', 'web'), {
    authMode, operatorToken: 'browser-test-operator', deviceTokens: { 'robot-arm-01': 'browser-test-device' },
  });
  const server = http.createServer(handler);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let simulator;
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    simulator = spawn(process.execPath, [path.resolve(__dirname, '..', 'simulator/device-simulator.js')], {
      env: { ...process.env, CLOUDEDGE_API: url, DEVICE_ID: 'robot-arm-01', DEVICE_TOKEN: 'browser-test-device', SIMULATOR_INTERVAL_MS: '150' },
      windowsHide: true, stdio: 'ignore',
    });
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('#connection-label').textContent.includes('已连接'));
    await page.waitForFunction(() => document.querySelectorAll('.device-item').length === 2);
    if (authMode === 'protected') {
      await page.locator('#operator-token').fill('incorrect-token');
      await page.locator('#apply-credentials').click();
      await page.waitForFunction(() => document.querySelector('#credential-status').textContent.includes('失败'));
      await page.locator('#operator-token').fill('browser-test-operator');
      await page.locator('#device-token').fill('browser-test-device');
      await page.locator('#apply-credentials').click();
      await page.waitForFunction(() => document.querySelector('#credential-status').textContent.includes('已应用'));
    }
    await page.locator('#inject-alert').click();
    await page.locator('[data-focus-key^="alert:acknowledge:"]').first().click();
    await page.locator('[data-focus-key^="alert:resolve:"]').first().click();
    await page.waitForFunction(() => document.querySelector('#alerts').textContent.includes('已解决'));
    await page.locator('#target-version').fill('0.3.0');
    await page.locator('#create-ota').click();
    await page.waitForFunction(() => document.querySelector('#commands').textContent.includes('成功'));
    assert.equal(platform.getDevice('robot-arm-01').firmwareVersion, '0.3.0');
    await page.locator('#device-search').fill('Workshop');
    assert.equal(await page.locator('.device-item').count(), 1);
    await page.locator('.device-item').click();
    await page.waitForFunction(() => location.search.includes('sensor-02'));
    await page.locator('#device-search').fill('');
    await page.locator('.device-item').filter({ hasText: 'Robot Arm' }).click();
    await page.waitForFunction(() => document.querySelector('#commands').textContent.includes('成功'));
    if (authMode === 'demo') {
      const directory = path.resolve(__dirname, '..', 'docs/screenshots');
      fs.mkdirSync(directory, { recursive: true });
      for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844], ['narrow', 320, 740]]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(() => window.scrollTo(0, 0));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} horizontal overflow`);
        if (name !== 'narrow') await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true });
      }
    }
    assert.deepEqual(errors, []);
    console.log(`${authMode}: credentials, alert lifecycle, OTA, device navigation and layout passed`);
  } finally {
    await page.close();
    if (simulator && simulator.exitCode === null && simulator.signalCode === null) {
      const exited = once(simulator, 'exit');
      simulator.kill();
      await exited;
    }
    handler.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  try {
    await verify('demo', browser);
    await verify('protected', browser);
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
