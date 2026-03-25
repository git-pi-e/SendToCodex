'use strict';

const path = require('path');
const { deleteFileIfExists, ensureDirectory, listFilePaths } = require('../files/fileSystem');

const MANAGED_LOG_FILE_PATTERN =
  /^terminal-\d+-.*\.(log|txt|lines\.json|selection(?:-[^.]+)?\.(txt|md))$/i;

class TerminalLogCleaner {
  constructor(output) {
    this.output = output;
  }

  async cleanupDeadLogFiles(logDirectory, activeFilePaths) {
    if (!logDirectory) {
      return;
    }

    await ensureDirectory(logDirectory);
    const filePaths = await listFilePaths(logDirectory);

    for (const filePath of filePaths) {
      if (!isManagedLogFile(filePath)) {
        continue;
      }

      if (activeFilePaths.has(filePath)) {
        continue;
      }

      await this.deleteLogFile(filePath);
    }
  }

  async deleteLogFile(filePath) {
    try {
      await deleteFileIfExists(filePath);
    } catch (error) {
      this.output.appendLine(`Failed to delete ${filePath}: ${error.message}`);
    }
  }

  async deleteTerminalFiles(paths) {
    for (const filePath of toManagedFilePathArray(paths)) {
      await this.deleteLogFile(filePath);
    }
  }
}

function isManagedLogFile(filePath) {
  return MANAGED_LOG_FILE_PATTERN.test(path.basename(filePath));
}

function toManagedFilePathArray(paths) {
  if (!paths) {
    return [];
  }

  if (Array.isArray(paths)) {
    return paths;
  }

  if (Array.isArray(paths.allFilePaths)) {
    return paths.allFilePaths;
  }

  return [];
}

module.exports = {
  TerminalLogCleaner
};
