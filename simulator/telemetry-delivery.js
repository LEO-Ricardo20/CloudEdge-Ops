const crypto = require('node:crypto');

class TelemetryDelivery {
  constructor({ deviceId, send, sample, now = () => new Date(), bootId = crypto.randomUUID() }) {
    this.deviceId = deviceId;
    this.send = send;
    this.sample = sample;
    this.now = now;
    this.bootId = bootId;
    this.sequence = 0;
    this.pending = null;
  }

  async deliver() {
    // One outstanding sample bounds memory and preserves its identity across retries.
    if (!this.pending) {
      this.pending = {
        ...this.sample(), deviceId: this.deviceId, bootId: this.bootId,
        sequence: this.sequence++, timestamp: this.now().toISOString(),
      };
    }
    const result = await this.send(this.pending);
    this.pending = null;
    return result;
  }
}

module.exports = { TelemetryDelivery };
