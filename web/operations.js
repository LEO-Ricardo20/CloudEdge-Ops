(function (root) {
  const metrics = {
    temperatureC: { label: '温度', unit: '°C', decimals: 1 },
    vibrationMmS: { label: '振动速度', unit: 'mm/s', decimals: 2 },
    batteryPct: { label: '电池电量', unit: '%', decimals: 0 },
    motorRpm: { label: '电机转速', unit: 'r/min', decimals: 0 },
  };
  function duration(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return '-';
    const seconds = Math.floor(milliseconds / 1000);
    if (seconds < 60) return seconds + ' 秒';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + ' 分 ' + seconds % 60 + ' 秒';
    return Math.floor(minutes / 60) + ' 小时 ' + minutes % 60 + ' 分';
  }
  function alarmTitle(alert) {
    const known = { 'High temperature': '温度超上限', 'High vibration': '振动速度超上限', 'Device offline': '遥测上报超时' };
    return known[alert.title] || alert.title || '设备告警';
  }
  function condition(alert, device) {
    const metric = alert.evidence?.metric;
    if (!device || device.status === 'unknown') return { label: '工况未知', tone: 'unknown' };
    if (metric === 'connectivity') return device.status === 'online'
      ? { label: '上报已恢复', tone: 'resolved' } : { label: '上报超时', tone: 'open' };
    const value = device.latestTelemetry?.metrics?.[metric];
    if (device.status !== 'online' || typeof value !== 'number' || !Number.isFinite(value)
      || !Number.isFinite(alert.evidence?.threshold)) return { label: '工况未知', tone: 'unknown' };
    return value > alert.evidence.threshold
      ? { label: '最近采样仍超限', tone: 'open' }
      : { label: '最近采样未超限', tone: 'resolved' };
  }
  function series(records, metric) {
    return (Array.isArray(records) ? records : []).filter((record) =>
      typeof record.metrics?.[metric] === 'number' && Number.isFinite(record.metrics[metric])
      && Number.isFinite(Date.parse(record.receivedAt || record.timestamp)))
      .slice().sort((a, b) => Date.parse(a.receivedAt || a.timestamp) - Date.parse(b.receivedAt || b.timestamp));
  }
  const operations = { metrics, duration, alarmTitle, condition, series };
  if (typeof module !== 'undefined' && module.exports) module.exports = operations;
  else root.CloudEdgeOperations = operations;
})(globalThis);
