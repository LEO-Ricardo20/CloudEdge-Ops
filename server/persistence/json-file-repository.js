const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class JsonFileRepository {
  constructor(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new TypeError('filePath is required');
    }
    this.filePath = path.resolve(filePath);
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in platform state file: ${this.filePath}`, { cause: error });
      }
      throw error;
    }
  }

  save(state) {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') error.cleanupError = cleanupError;
      }
      throw error;
    }
  }
}

module.exports = { JsonFileRepository };
