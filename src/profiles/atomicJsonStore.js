'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const LOCK_RETRY_MS = 10;

function sleepSync(durationMs) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, durationMs);
}

function acquireFileLockSync(filePath, options = {}) {
  const lockPath = `${filePath}.lock`;
  const timeoutMs = options.lockTimeoutMs || DEFAULT_LOCK_TIMEOUT_MS;
  const staleLockMs = options.staleLockMs || DEFAULT_STALE_LOCK_MS;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      fs.mkdirSync(lockPath);
      return () => {
        try {
          fs.rmdirSync(lockPath);
        } catch (error) {
          const message = error && error.message ? error.message : String(error);
          throw new Error(`Failed to release JSON file lock at ${lockPath}: ${message}`);
        }
      };
    } catch (error) {
      const isWindowsLockContention =
        process.platform === 'win32' && error && (error.code === 'EPERM' || error.code === 'EACCES');
      if (!error || (error.code !== 'EEXIST' && !isWindowsLockContention)) {
        const message = error && error.message ? error.message : String(error);
        throw new Error(`Failed to acquire JSON file lock at ${lockPath}: ${message}`);
      }

      try {
        if (!fs.existsSync(lockPath)) {
          if (Date.now() >= deadline) {
            throw new Error(`Timed out after ${timeoutMs} ms waiting for JSON file lock at ${lockPath}`);
          }
          sleepSync(LOCK_RETRY_MS);
          continue;
        }
        const lockAgeMs = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (lockAgeMs > staleLockMs) {
          fs.rmdirSync(lockPath);
          if (typeof options.onStaleLockRemoved === 'function') {
            options.onStaleLockRemoved({ lockPath, lockAgeMs });
          }
          continue;
        }
      } catch (statError) {
        if (statError && (statError.code === 'ENOENT' || statError.code === 'ENOTEMPTY')) {
          continue;
        }
        const message = statError && statError.message ? statError.message : String(statError);
        throw new Error(`Failed to inspect JSON file lock at ${lockPath}: ${message}`);
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out after ${timeoutMs} ms waiting for JSON file lock at ${lockPath}`);
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

function writeJsonAtomicSync(filePath, data) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(data, null, 2), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

function mutateJsonFileSync(filePath, createValue, normalize, mutate, options = {}) {
  const release = acquireFileLockSync(filePath, options);
  let operationError;
  try {
    const rawValue = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : createValue;
    const current = normalize(rawValue);
    const currentSerialized = options.skipWriteIfUnchanged ? JSON.stringify(current) : null;
    const next = normalize(mutate(current));
    if (options.skipWriteIfUnchanged && currentSerialized === JSON.stringify(next)) {
      return next;
    }
    writeJsonAtomicSync(filePath, next);
    return next;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      release();
    } catch (releaseError) {
      if (!operationError) {
        throw releaseError;
      }
    }
  }
}

module.exports = {
  acquireFileLockSync,
  mutateJsonFileSync,
  writeJsonAtomicSync
};
