const { DEFAULT_OFFLINE_AFTER_MS, DEFAULT_COMMAND_TTL_MS } = require('./domain/platform');

function integerSetting(env, name, fallback, minimum = 1, maximum = 2_147_483_647) {
  if (env[name] == null || env[name] === '') return fallback;
  const value = Number(env[name]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function readConfig(env = process.env) {
  const authMode = env.AUTH_MODE || 'demo';
  if (!['demo', 'protected'].includes(authMode)) throw new Error('AUTH_MODE must be demo or protected');
  let deviceTokens = {};
  if (env.DEVICE_TOKENS) {
    try {
      deviceTokens = JSON.parse(env.DEVICE_TOKENS);
    } catch {
      throw new Error('DEVICE_TOKENS must be a JSON object mapping device IDs to tokens');
    }
    if (!deviceTokens || typeof deviceTokens !== 'object' || Array.isArray(deviceTokens)
      || Object.entries(deviceTokens).some(([id, token]) => !id.trim() || typeof token !== 'string' || !token.trim() || token !== token.trim())) {
      throw new Error('DEVICE_TOKENS must contain nonempty device IDs and token strings');
    }
  }
  const operatorToken = env.OPERATOR_TOKEN || '';
  const tokens = Object.values(deviceTokens);
  if (new Set(tokens).size !== tokens.length || (operatorToken && tokens.includes(operatorToken))) {
    throw new Error('Operator and device tokens must be unique across identities');
  }
  if (authMode === 'protected' && (!operatorToken.trim() || operatorToken !== operatorToken.trim() || !Object.keys(deviceTokens).length)) {
    throw new Error('Protected mode requires OPERATOR_TOKEN and at least one DEVICE_TOKENS entry');
  }
  const offlineAfterMs = integerSetting(env, 'OFFLINE_AFTER_MS', DEFAULT_OFFLINE_AFTER_MS);
  return {
    port: integerSetting(env, 'PORT', 4173, 0, 65535),
    offlineAfterMs,
    offlineCheckIntervalMs: integerSetting(env, 'OFFLINE_CHECK_INTERVAL_MS', Math.max(1_000, Math.min(Math.floor(offlineAfterMs / 2), 5_000))),
    commandTtlMs: integerSetting(env, 'COMMAND_TTL_MS', DEFAULT_COMMAND_TTL_MS, 1_000, 30 * 24 * 60 * 60 * 1000),
    authMode,
    operatorToken,
    deviceTokens,
  };
}

module.exports = { readConfig };
