const test = require('node:test');
const assert = require('node:assert/strict');
const { duration, condition, series, alarmTitle } = require('../web/operations');
const { CloudEdgePlatform } = require('../server/domain/platform');

test('operational durations preserve sub-minute offline thresholds', () => {
  assert.equal(duration(15000), '15 秒');
  assert.equal(duration(65000), '1 分 5 秒');
  assert.equal(duration(-1), '-');
});

test('alarm workflow closure does not imply the measured condition recovered', () => {
  const platform = new CloudEdgePlatform();
  const alert = platform.ingestTelemetry({ deviceId: 'robot-arm-01', metrics: { temperatureC: 72 } }).alerts[0];
  platform.acknowledgeAlert(alert.id, 'operator');
  const closed = platform.resolveAlert(alert.id, 'operator', 'Inspection recorded; follow-up required');
  assert.equal(closed.resolutionReason, 'Inspection recorded; follow-up required');
  assert.equal(condition(closed, platform.getDevice('robot-arm-01')).label, '最近采样仍超限');
  platform.ingestTelemetry({ deviceId: 'robot-arm-01', metrics: { temperatureC: 40 } });
  assert.equal(condition(closed, platform.getDevice('robot-arm-01')).label, '最近采样未超限');
  const device = platform.getDevice('robot-arm-01');
  device.status = 'offline';
  assert.equal(condition(closed, device).label, '工况未知');
  assert.equal(alarmTitle(closed), '温度超上限');
});

test('trend data rejects null and string measurements and uses receive timestamps', () => {
  const record = (value, time) => ({ metrics: { vibrationMmS: value }, receivedAt: time });
  const records = [record(3, '2026-09-07T00:00:03Z'), record(null, '2026-09-07T00:00:01Z'), record('2', '2026-09-07T00:00:02Z'), record(1, '2026-09-07T00:00:00Z')];
  assert.deepEqual(series(records, 'vibrationMmS').map((item) => item.metrics.vibrationMmS), [1, 3]);
  assert.equal(records[0].metrics.vibrationMmS, 3);
});
