const test = require('node:test');
const assert = require('node:assert/strict');
const { readConfig } = require('../server/config');

test('configuration defaults to local demo and validates protected credentials', () => {
  assert.equal(readConfig({}).authMode, 'demo');
  assert.equal(readConfig({}).port, 4173);
  const config = readConfig({ AUTH_MODE: 'protected', OPERATOR_TOKEN: 'operator-test', DEVICE_TOKENS: '{"device-1":"device-test"}' });
  assert.equal(config.deviceTokens['device-1'], 'device-test');
  for (const env of [
    { AUTH_MODE: 'protectd' },
    { DEVICE_TOKENS: '{"device-1":"same","device-2":"same"}' },
    { OPERATOR_TOKEN: 'same', DEVICE_TOKENS: '{"device-1":"same"}' },
    { AUTH_MODE: 'protected' },
    { DEVICE_TOKENS: '{broken' },
    { DEVICE_TOKENS: '[]' },
    { DEVICE_TOKENS: '{"device-1":42}' },
    { DEVICE_TOKENS: '{"device-1":" token "}' },
    { PORT: '65536' },
    { OFFLINE_AFTER_MS: 'NaN' },
    { OFFLINE_CHECK_INTERVAL_MS: '0' },
    { COMMAND_TTL_MS: '999' },
  ]) assert.throws(() => readConfig(env));
});
