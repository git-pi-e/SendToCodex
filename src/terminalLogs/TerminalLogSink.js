'use strict';

const {
  readTextFileIfExists,
  writeTextFile
} = require('../files/fileSystem');
const { normalizeTerminalText } = require('./ansiText');
const { buildLineStarts } = require('./lineIndex');
const { trimToMaxBytes } = require('./textBuffer');

class TerminalLogSink {
  constructor(paths, maxBytes, output) {
    this.paths = paths;
    this.maxBytes = maxBytes;
    this.output = output;
    this.textBuffer = '';
    this.flushTimer = undefined;
    this.writeChain = Promise.resolve();
    this.initialized = false;
    this.disposed = false;
  }

  async initialize() {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    const bufferedTextData = this.textBuffer;

    try {
      const existingText = await this.readExistingTextBuffer();
      this.textBuffer = trimToMaxBytes(existingText + bufferedTextData, this.maxBytes);
    } catch (error) {
      this.output.appendLine(`Failed to read ${this.paths.textLogPath}: ${error.message}`);
      this.textBuffer = trimToMaxBytes(bufferedTextData, this.maxBytes);
    }

    await this.flush();
  }

  async readExistingTextBuffer() {
    const existingText = await readTextFileIfExists(this.paths.textLogPath);
    if (existingText) {
      return existingText;
    }

    if (!this.paths.legacyRawLogPath) {
      return '';
    }

    const legacyRawText = await readTextFileIfExists(this.paths.legacyRawLogPath);
    return normalizeTerminalText(legacyRawText);
  }

  append(data) {
    if (this.disposed || !data) {
      return;
    }

    this.textBuffer = trimToMaxBytes(this.textBuffer + normalizeTerminalText(data), this.maxBytes);
    this.scheduleFlush();
  }

  async rebind(paths, maxBytes) {
    this.maxBytes = maxBytes;
    this.textBuffer = trimToMaxBytes(this.textBuffer, this.maxBytes);

    if (paths.textLogPath === this.paths.textLogPath && paths.lineIndexPath === this.paths.lineIndexPath) {
      this.scheduleFlush();
      return;
    }

    await this.flush();
    this.paths = paths;
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.flushTimer) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, 150);
  }

  async flush() {
    const paths = this.paths;
    const textSnapshot = this.textBuffer;
    const lineIndexSnapshot = JSON.stringify(
      {
        version: 1,
        lineStarts: buildLineStarts(textSnapshot)
      },
      null,
      2
    );

    this.writeChain = this.writeChain
      .then(async () => {
        await Promise.all([
          writeTextFile(paths.textLogPath, textSnapshot),
          writeTextFile(paths.lineIndexPath, lineIndexSnapshot)
        ]);
      })
      .catch((error) => {
        this.output.appendLine(`Failed to write terminal log files for ${paths.baseName}: ${error.message}`);
      });

    await this.writeChain;
  }

  async dispose() {
    this.disposed = true;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    await this.flush();
  }
}

module.exports = {
  TerminalLogSink
};
