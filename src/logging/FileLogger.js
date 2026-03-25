'use strict';

const fs = require('fs');
const path = require('path');
const { loadConfiguration } = require('../config');
const { appendTextFile } = require('../files/fileSystem');

class FileLogger {
  constructor(logDirectoryPath, output) {
    this.logFilePath = path.join(logDirectoryPath, 'codex-terminal-recorder.log');
    this.output = output;
    this.writeChain = Promise.resolve();
    this.loggingEnabled = false;
    this.logFileEnabled = false;
  }

  info(message, data) {
    this.write('info', message, data);
  }

  warn(message, data) {
    this.write('warn', message, data);
  }

  error(message, data) {
    this.write('error', message, data);
  }

  reloadConfiguration() {
    const configuration = loadConfiguration();
    this.loggingEnabled = Boolean(configuration.diagnosticsLoggingEnabled);
    this.logFileEnabled = Boolean(configuration.diagnosticsLogFileEnabled);
  }

  isLoggingEnabled() {
    return this.loggingEnabled;
  }

  isLogFileEnabled() {
    return this.loggingEnabled && this.logFileEnabled;
  }

  hasLogFile() {
    return fs.existsSync(this.logFilePath);
  }

  write(level, message, data) {
    if (!this.loggingEnabled || !this.logFileEnabled) {
      return this.writeChain;
    }

    const payload = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data: data || null
    };
    const line = `${JSON.stringify(payload)}\n`;

    this.writeChain = this.writeChain
      .then(() => appendTextFile(this.logFilePath, line))
      .catch((error) => {
        this.output.appendLine(`Failed to write diagnostics log: ${error.message}`);
      });

    return this.writeChain;
  }

  async flush() {
    await this.writeChain;
  }
}

module.exports = {
  FileLogger
};
