const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class JsonFileRepository {
  constructor(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new TypeError('filePath is required');
    }
    this.filePath = path.resolve(filePath);
    this.backupPaths = [1, 2, 3].map((index) => `${this.filePath}.bak.${index}`);
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

  loadCandidates({ validator } = {}) {
    const candidates = [this.filePath, ...this.backupPaths];
    const errors = [];
    let found = false;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidatePath = candidates[index];
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
        found = true;
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        errors.push({ path: candidatePath, error });
        continue;
      }
      try {
        const state = validator ? validator(parsed) : parsed;
        return {
          state,
          migrated: parsed.version !== state.version,
          recovery: index === 0 ? null : {
            source: candidatePath,
            backupIndex: index,
            reason: errors.length ? 'primary-invalid' : 'primary-missing',
          },
        };
      } catch (error) {
        errors.push({ path: candidatePath, error });
      }
    }
    if (!found && !errors.length) return null;
    const detail = errors.map((entry) => `${entry.path}: ${entry.error.message}`).join('; ');
    throw new Error(`No valid platform state snapshot found${detail ? ` (${detail})` : ''}`);
  }

  save(state) {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      // Keep the committed primary in place until its replacement is ready.
      if (fs.existsSync(this.backupPaths[1])) fs.renameSync(this.backupPaths[1], this.backupPaths[2]);
      if (fs.existsSync(this.backupPaths[0])) fs.renameSync(this.backupPaths[0], this.backupPaths[1]);
      if (fs.existsSync(this.filePath)) fs.copyFileSync(this.filePath, this.backupPaths[0]);
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
